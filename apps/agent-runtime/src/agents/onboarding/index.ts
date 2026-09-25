import type { SupabaseClient } from '@supabase/supabase-js'
import {
  AgentRun,
  AgentRunError,
  buildOnboardingParts,
  getPrompt,
  onboardingDraftSchema,
  renderDraftSummary,
  runAgent,
  templateFor,
  type AgentDefinition,
  type RunAgentDeps,
  type RunAgentResult,
  type WaLocale,
  type WhatsAppProvider,
} from '@amclub/agent-core'
import {
  ONBOARDING_MAX_DRAFTS,
  capabilityFactsFromDraft,
  isOnboardingTerminal,
  onboardingCategoryName,
  onboardingCopy,
  redactContactInfo,
  toOnboardingLocale,
  type CategorySlug,
  type OnboardingAnswer,
  type OnboardingDraft,
  type OnboardingStep,
} from '@amclub/shared'
import { businessNameOf, promptFor, reviewButtons, stepMachine, type MachineInbound, type MachineSession, type OutboundMsg } from './machine'
import { transcribeVoiceNote } from './stt'
import { conversationServesUser, currentWhatsAppGrants } from '../../whatsapp/binding'

/**
 * Onboarding agent (BUILD_PROMPTS S1.6). Persona provider. A SCRIPTED
 * interview on WhatsApp: the steps are code (the pure machine), the model is
 * called ONCE per draft (max two per session), and the provider's BUTTON tap
 * is the confirmation — recorded by the web decision route under the
 * provider's delegated token as ONE ai_decisions row (feature `onboarding`,
 * tool `confirm_onboarding_draft`). Free text never confirms.
 *
 * Every turn is one agent_runs row: the start turn is the root, every later
 * turn is a child (parent_run_id = root); only the draft turn spends budget.
 * The session row is the durable state; runs are the audit trail.
 *
 * Service role touches ONLY agent-owned tables: onboarding_sessions,
 * provider_capability_facts, wa_* and the ledgers. The runtime never writes
 * provider_profiles / provider_categories / packages / provider_verifications
 * — the wizard consumes the confirmed draft and stays the only writer.
 */

export interface OnboardingTurn {
  kind: 'start' | 'message' | 'expire'
  sessionId: string
  messageId?: string | null
  jobId?: string | null
}
export interface OnboardingTurnOutput {
  sessionId: string
  state: OnboardingStep
  outcome: string
  sent: number
}
export type OnboardingTurnResult = RunAgentResult<OnboardingTurnOutput> | { runId: null; status: 'failed'; error: 'session_not_found' | 'session_terminal' }

export interface OnboardingRuntimeDeps {
  core: RunAgentDeps
  admin: SupabaseClient
  whatsapp: WhatsAppProvider
  /** The web app (API of record): hand-off links + the routes this turn calls under the delegated token. */
  apiUrl: string
  /** Runtime AGENT_ENABLED — replies are gated on it (dark ⇒ nothing is sent). */
  agentEnabled: boolean
  /** The provider's delegated token (deps.mintRuntimeToken in the worker; the rig injects a session token). */
  tokenFor: (args: { runId: string; userId: string }) => Promise<string>
  mediaBucket: string
  /** Sliding session TTL in hours (agent_settings.onboarding_session_ttl_hours). */
  ttlHours: number
  now?: () => Date
  capture?: (userId: string, event: string, props?: Record<string, unknown>) => void
  fetchImpl?: typeof fetch
}

interface SessionRow {
  id: string
  user_id: string
  root_run_id: string | null
  conversation_id: string | null
  surface: string
  locale: string
  state: OnboardingStep
  answers: OnboardingAnswer[]
  photo_refs: string[]
  category_slugs: CategorySlug[]
  gstin: string | null
  udyam: string | null
  draft: OnboardingDraft | null
  draft_run_id: string | null
  draft_decision_id: string | null
  draft_count: number
  revise_pending: boolean
  expires_at: string
}
interface ConversationRow {
  id: string
  phone_e164: string
  window_open_until: string | null
}
interface MessageRow {
  id: string
  conversation_id: string
  direction: string
  kind: string
  body: string | null
  media_ref: string | null
  mime: string | null
  payload: Record<string, unknown> | null
}

const SESSION_COLS = 'id, user_id, root_run_id, conversation_id, surface, locale, state, answers, photo_refs, category_slugs, gstin, udyam, draft, draft_run_id, draft_decision_id, draft_count, revise_pending, expires_at'
const TOOL = 'confirm_onboarding_draft' as const

export function onboardingLink(apiUrl: string, sessionId: string): string {
  return `${apiUrl.replace(/\/$/, '')}/partner/onboarding?session=${sessionId}`
}

/** Recover the button payload from a stored inbound row (Meta raw shape, Interakt, or the rig's explicit field). */
export function buttonPayloadOf(row: Pick<MessageRow, 'kind' | 'body' | 'payload'>): string | null {
  if (row.kind !== 'button') return null
  const p = row.payload ?? {}
  const fromMeta = ((p['button'] as { payload?: string } | undefined)?.payload)
    ?? ((p['interactive'] as { button_reply?: { id?: string }; list_reply?: { id?: string } } | undefined)?.button_reply?.id)
    ?? ((p['interactive'] as { list_reply?: { id?: string } } | undefined)?.list_reply?.id)
  const explicit = typeof p['button_payload'] === 'string' ? (p['button_payload'] as string) : null
  return fromMeta ?? explicit ?? row.body
}

function toMachineSession(s: SessionRow): MachineSession {
  return {
    id: s.id,
    state: s.state,
    locale: toOnboardingLocale(s.locale),
    answers: s.answers ?? [],
    photo_refs: s.photo_refs ?? [],
    category_slugs: s.category_slugs ?? [],
    gstin: s.gstin,
    udyam: s.udyam,
    draft_run_id: s.draft_run_id,
    draft_count: s.draft_count ?? 0,
    revise_pending: s.revise_pending === true,
  }
}

/** Keyless / CI producer: a schema-valid draft from the session itself (never money). */
export function stubDraftFor(session: MachineSession): OnboardingDraft {
  const name = businessNameOf(session) ?? 'Provider'
  const packages = session.category_slugs.slice(0, 3).map((slug, i) => {
    const mine = session.answers.filter((a) => a.step === 'capabilities' && a.category_slug === slug)
    const lines = (t: string | undefined) => (t ?? '').split(/[,;\n]/).map((x) => x.trim()).filter((x) => x.length > 0).slice(0, 8)
    const scope = lines(mine[0]?.text)
    const deliverables = lines(mine[1]?.text)
    return {
      category_slug: slug,
      title: `${onboardingCategoryName(slug, session.locale)} — ${name}`.slice(0, 200),
      scope_included: scope.length ? scope : [onboardingCategoryName(slug, session.locale)],
      deliverables: deliverables.length ? deliverables : [onboardingCategoryName(slug, session.locale)],
      price_paise: null,
      delivery_days: null,
      _i: i,
    }
  }).map(({ _i, ...p }) => { void _i; return p })
  return {
    profile: { display_name: name.slice(0, 100), legal_name: name.slice(0, 200), about: null, city: null, state: null, languages: [session.locale], category_slugs: session.category_slugs.slice(0, 3) },
    packages,
    uncertain_fields: ['about', ...packages.map((_, i) => `packages.${i}.price_paise`)].slice(0, 12),
  }
}

// ── the turn ────────────────────────────────────────────────────────────────

export async function runOnboardingTurn(deps: OnboardingRuntimeDeps, turn: OnboardingTurn): Promise<OnboardingTurnResult> {
  const { data: row } = await deps.admin.from('onboarding_sessions').select(SESSION_COLS).eq('id', turn.sessionId).is('deleted_at', null).maybeSingle()
  const session = row as SessionRow | null
  if (!session) return { runId: null, status: 'failed', error: 'session_not_found' }
  if (isOnboardingTerminal(session.state)) return { runId: null, status: 'failed', error: 'session_terminal' }
  const def = onboardingAgent(deps, session)
  return runAgent(def, deps.core, {
    userId: session.user_id,
    surface: 'whatsapp',
    subjectType: 'onboarding_session',
    subjectId: session.id,
    parentRunId: session.root_run_id,
    jobId: turn.jobId ?? null,
    meta: { kind: turn.kind, message_id: turn.messageId ?? null },
  }, turn)
}

function onboardingAgent(deps: OnboardingRuntimeDeps, session: SessionRow): AgentDefinition<OnboardingTurn, OnboardingTurnOutput> {
  const now = deps.now ?? (() => new Date())
  const capture = deps.capture ?? (() => undefined)
  const admin = deps.admin
  const locale = toOnboardingLocale(session.locale)
  const link = onboardingLink(deps.apiUrl, session.id)

  /** Audit M41: the session's conversation only while it is still bound to the provider and is their current phone. */
  async function conversation(): Promise<ConversationRow | null> {
    if (!session.conversation_id) return null
    const { data } = await admin.from('wa_conversations').select('id, phone_e164, window_open_until, user_id').eq('id', session.conversation_id).maybeSingle()
    const conv = data as (ConversationRow & { user_id: string | null }) | null
    if (!conv || !(await conversationServesUser(admin, conv, session.user_id))) return null
    return { id: conv.id, phone_e164: conv.phone_e164, window_open_until: conv.window_open_until }
  }
  /** A WhatsApp grant given from the provider's current phone. */
  async function hasWhatsAppGrant(): Promise<boolean> {
    return (await currentWhatsAppGrants(admin, session.user_id)).length > 0
  }
  async function recordOutbound(conv: ConversationRow, kind: 'text' | 'button' | 'template', body: string | null, r: { ok: boolean; vendorMessageId: string | null; detail: string }, extra: Record<string, unknown> = {}) {
    await admin.from('wa_messages').insert({
      conversation_id: conv.id,
      direction: 'out',
      vendor_message_id: r.vendorMessageId,
      kind,
      body,
      status: r.ok ? (r.detail === 'stub' ? 'stub' : 'sent') : 'failed',
      payload: { session_id: session.id, detail: r.detail, ...extra },
      ...(kind === 'template' && typeof extra['template_name'] === 'string' ? { template_name: extra['template_name'] } : {}),
    })
    if (r.ok) await admin.from('wa_conversations').update({ last_outbound_at: now().toISOString() }).eq('id', conv.id)
  }
  /**
   * Send replies: inside the 24h window as text/buttons; outside it as the
   * matching template (start / resume / expired), which needs the provider's
   * WhatsApp grant. Gated on the runtime flag; every outbound is a wa_messages row.
   */
  async function send(msgs: OutboundMsg[], stateForTemplate: OnboardingStep, templateParam: string): Promise<number> {
    if (!deps.agentEnabled || msgs.length === 0) return 0
    const conv = await conversation()
    if (!conv) return 0
    const inWindow = !!conv.window_open_until && new Date(conv.window_open_until).getTime() > now().getTime()
    let sent = 0
    if (inWindow) {
      for (const m of msgs) {
        const r = m.type === 'text' ? await deps.whatsapp.sendText(conv.phone_e164, m.text) : await deps.whatsapp.sendButtons(conv.phone_e164, m.text, m.buttons, m.listLabel)
        await recordOutbound(conv, m.type === 'text' ? 'text' : 'button', m.text, r, m.type === 'buttons' ? { buttons: m.buttons.map((b) => b.id) } : {})
        if (r.ok) sent++
      }
      return sent
    }
    if (!(await hasWhatsAppGrant())) return 0
    const kind = stateForTemplate === 'language' ? 'onboarding_start' : stateForTemplate === 'abandoned' ? 'onboarding_expired' : 'onboarding_resume'
    const tpl = templateFor(kind, locale as WaLocale)
    if (!tpl) return 0
    const r = await deps.whatsapp.sendTemplate(conv.phone_e164, tpl.name, locale as WaLocale, [templateParam])
    await recordOutbound(conv, 'template', null, r, { template_name: tpl.name, params: [templateParam] })
    return r.ok ? 1 : 0
  }
  /** Guarded session update: only from the state we read (replay-safe across workers). */
  async function patchSession(fromState: OnboardingStep, patch: Record<string, unknown>): Promise<boolean> {
    const { data, error } = await admin.from('onboarding_sessions').update({ ...patch, updated_at: now().toISOString() }).eq('id', session.id).eq('state', fromState).select('id')
    if (error) throw new Error(`session_update_failed:${error.message}`)
    return Array.isArray(data) && data.length > 0
  }
  async function clearActiveSession() {
    if (session.conversation_id) await admin.from('wa_conversations').update({ active_session_id: null }).eq('id', session.conversation_id).eq('active_session_id', session.id)
  }
  function slidingExpiry(): string {
    return new Date(now().getTime() + deps.ttlHours * 3600 * 1000).toISOString()
  }
  async function cancelParkedDraftRun(reason: string, extra: Record<string, unknown>) {
    if (!session.draft_run_id) return
    try {
      await deps.core.ledger.appendEvent({ runId: session.draft_run_id, kind: 'declined', tool: TOOL, actor: 'user', payload: { reason, ...extra } })
      await deps.core.ledger.transitionRun(session.draft_run_id, 'awaiting_confirmation', 'cancelled')
    } catch {
      /* already advanced (a confirm won the race) — leave it */
    }
  }

  return {
    name: 'onboarding',
    persona: 'provider',
    async run(run, turn) {
      const ms = toMachineSession(session)

      // ── start: the root run; the welcome ──────────────────────────────────
      if (turn.kind === 'start') {
        if (!session.root_run_id) {
          await admin.from('onboarding_sessions').update({ root_run_id: run.runId, last_prompt_at: now().toISOString() }).eq('id', session.id).is('root_run_id', null)
          session.root_run_id = run.runId
        }
        const { data: u } = await admin.from('users').select('full_name').eq('id', session.user_id).maybeSingle()
        const name = ((u as { full_name?: string | null } | null)?.full_name ?? '').trim()
        const sent = await send(promptFor('language', ms, { name }), 'language', name || 'there')
        capture(session.user_id, 'onboarding_wa_started', { session_id: session.id, surface: session.surface, sent })
        return { sessionId: session.id, state: session.state, outcome: 'started', sent }
      }

      // ── expire: abandon + point to the web ────────────────────────────────
      if (turn.kind === 'expire') {
        if (new Date(session.expires_at).getTime() > now().getTime()) return { sessionId: session.id, state: session.state, outcome: 'not_expired', sent: 0 }
        const moved = await patchSession(session.state, { state: 'abandoned', failure: 'expired' })
        if (!moved) return { sessionId: session.id, state: session.state, outcome: 'noop', sent: 0 }
        await cancelParkedDraftRun('expired', {})
        await clearActiveSession()
        const sent = await send(promptFor('abandoned', ms, { link }), 'abandoned', link)
        capture(session.user_id, 'onboarding_wa_abandoned', { session_id: session.id, step: session.state, sent })
        return { sessionId: session.id, state: 'abandoned', outcome: 'expired', sent }
      }

      // ── message: one machine step ─────────────────────────────────────────
      if (!turn.messageId) throw new Error('message_id_required')
      const { data: m } = await admin.from('wa_messages').select('id, conversation_id, direction, kind, body, media_ref, mime, payload').eq('id', turn.messageId).maybeSingle()
      const msg = m as MessageRow | null
      if (!msg || msg.direction !== 'in') throw new Error('message_not_found')
      if (session.conversation_id && msg.conversation_id !== session.conversation_id) throw new Error('message_conversation_mismatch')

      let text: string | null = msg.body
      let transcriptVendor: string | null = null
      if (msg.kind === 'audio') {
        text = null
        if (msg.media_ref) {
          const token = await deps.tokenFor({ runId: run.runId, userId: session.user_id })
          const t = await transcribeVoiceNote({ admin, bucket: deps.mediaBucket, mediaRef: msg.media_ref, mime: msg.mime, apiUrl: deps.apiUrl, token, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) })
          if (t.ok) {
            text = t.text
            transcriptVendor = t.vendor
          } else {
            console.warn('[onboarding] stt failed', session.id, t.reason)
          }
        }
      }
      let redacted = false
      if (text) {
        const r = redactContactInfo(text)
        text = r.text
        redacted = r.redacted
      }
      const inbound: MachineInbound = {
        messageId: msg.id,
        kind: (msg.kind === 'text' || msg.kind === 'audio' || msg.kind === 'image' || msg.kind === 'document' || msg.kind === 'button' ? msg.kind : 'unknown'),
        text,
        buttonPayload: buttonPayloadOf(msg),
        mediaRef: msg.media_ref,
        transcriptVendor,
        redacted,
      }
      const result = stepMachine(ms, inbound)
      if (result.outcome === 'noop') return { sessionId: session.id, state: session.state, outcome: 'noop', sent: 0 }

      // The confirm action is persisted only AFTER the decision route succeeded.
      if (result.action === 'confirm') {
        return confirmDraft(run, ms, msg.id)
      }

      const patch: Record<string, unknown> = { ...result.patch, state: result.state, last_prompt_at: now().toISOString(), expires_at: slidingExpiry() }
      const moved = await patchSession(session.state, patch)
      if (!moved) return { sessionId: session.id, state: session.state, outcome: 'noop', sent: 0 }
      Object.assign(session, result.patch, { state: result.state })
      const msAfter = toMachineSession(session)
      const sent = await send(result.replies, result.state, onboardingCopy(`step.${result.state}`, msAfter.locale))
      capture(session.user_id, 'onboarding_wa_step', { session_id: session.id, step: result.state, kind: inbound.kind, outcome: result.outcome, redacted })

      if (result.action === 'draft') return draft(run, msAfter, sent)
      if (result.action === 'revise') {
        await cancelParkedDraftRun('revise', { wa_message_id: msg.id })
        capture(session.user_id, 'onboarding_wa_revised', { session_id: session.id, draft_count: session.draft_count })
        return { sessionId: session.id, state: result.state, outcome: 'revise', sent }
      }
      if (result.action === 'cap_handoff') {
        await cancelParkedDraftRun('revise_cap', { wa_message_id: msg.id })
        await admin.from('onboarding_sessions').update({ handed_off_at: now().toISOString(), failure: 'revise_cap' }).eq('id', session.id)
        await clearActiveSession()
        const n = await send([{ type: 'text', text: onboardingCopy('revise_cap', msAfter.locale, { link }) }], 'handed_off', link)
        capture(session.user_id, 'onboarding_wa_handed_off', { session_id: session.id, confirmed: false, cap: true })
        return { sessionId: session.id, state: 'handed_off', outcome: 'cap_handoff', sent: sent + n }
      }
      return { sessionId: session.id, state: result.state, outcome: result.outcome, sent }

      // ── the ONE model call ──────────────────────────────────────────────
      async function draft(run: AgentRun, s: MachineSession, alreadySent: number): Promise<OnboardingTurnOutput> {
        const prompt = getPrompt('onboarding_interview', 'v1')
        const parts = buildOnboardingParts({
          sessionId: s.id,
          locale: s.locale,
          categorySlugs: s.category_slugs,
          businessName: businessNameOf(s),
          gstin: s.gstin,
          answers: s.answers.filter((a) => a.step === 'capabilities' || a.step === 'review'),
        })
        let out: OnboardingDraft
        try {
          out = await run.callModel({ taskClass: prompt.taskClass, prompt, schema: onboardingDraftSchema, parts, temperature: 0.2, feature: 'onboarding', stub: () => stubDraftFor(s) })
        } catch (e) {
          const failure = (e instanceof AgentRunError ? e.code : (e as Error).message).slice(0, 200)
          await patchSession('drafting', { state: 'failed', failure })
          await clearActiveSession()
          const n = await send(promptFor('failed', s, { link }), 'failed', link)
          capture(session.user_id, 'onboarding_wa_failed', { session_id: session.id, failure, sent: n })
          throw e // the run fails cleanly (budget_* / gateway) — the worker never retries budget errors
        }
        // Pin category_slugs to the interview's set regardless of what the model returned.
        out = { ...out, profile: { ...out.profile, category_slugs: s.category_slugs.slice(0, 3) } }
        const draftCount = (session.draft_count ?? 0) + 1
        const moved = await patchSession('drafting', { draft: out, draft_run_id: run.runId, draft_count: draftCount, state: 'review', revise_pending: false })
        if (!moved) return { sessionId: session.id, state: 'drafting', outcome: 'noop', sent: alreadySent }
        Object.assign(session, { draft: out, draft_run_id: run.runId, draft_count: draftCount, state: 'review' })
        const s2: MachineSession = { ...s, draft_run_id: run.runId, draft_count: draftCount, state: 'review' }
        const chunks = renderDraftSummary(out, s.locale).map((text): OutboundMsg => ({ type: 'text', text }))
        const n = await send([...chunks, reviewButtons(s2)], 'review', out.profile.display_name ?? '')
        // Park: the provider's button is the confirmation. The run stays awaiting_confirmation until then.
        await run.proposeTool(TOOL, { session_id: session.id })
        capture(session.user_id, 'onboarding_wa_drafted', { session_id: session.id, categories: s.category_slugs.length, packages: out.packages.length, uncertain_count: out.uncertain_fields.length, stub: process.env['AGENT_LLM_API_KEY'] || process.env['OPENROUTER_API_KEY'] ? false : true, draft_count: draftCount })
        return { sessionId: session.id, state: 'review', outcome: 'drafted', sent: alreadySent + n }
      }

      // ── the confirmation (button payload only) ──────────────────────────
      async function confirmDraft(run: AgentRun, s: MachineSession, waMessageId: string): Promise<OnboardingTurnOutput> {
        const draftRunId = s.draft_run_id
        const draftObj = session.draft
        if (!draftRunId || !draftObj) throw new Error('no_draft_to_confirm')
        const f = deps.fetchImpl ?? fetch
        let decisionId: string | null = null
        let resumed = false
        try {
          const token = await deps.tokenFor({ runId: run.runId, userId: session.user_id })
          const res = await f(`${deps.apiUrl}/api/v1/agent/runs/${draftRunId}/decision`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ approve: true, final: draftObj, input_refs: { session_id: session.id, wa_message_id: waMessageId } }),
          })
          const body = (await res.json().catch(() => null)) as { decision_id?: string; resumed?: boolean; error?: string } | null
          if (res.ok && body?.decision_id) {
            decisionId = body.decision_id
            resumed = body.resumed === true
          } else if (res.status === 409 && body?.error === 'not_awaiting_confirmation') {
            // Replayed button: an earlier tap may already have recorded the decision.
            const { data: d } = await admin.from('ai_decisions').select('id').eq('run_id', draftRunId).eq('tool', TOOL).limit(1).maybeSingle()
            decisionId = (d as { id: string } | null)?.id ?? null
          } else {
            console.warn('[onboarding] decision route', res.status, body?.error)
          }
        } catch (e) {
          console.warn('[onboarding] decision route failed', (e as Error).message)
        }
        if (!decisionId || !(await deps.core.ledger.hasApprovedDecision({ runId: draftRunId, tool: TOOL, decisionId }))) {
          const n = await send([{ type: 'text', text: onboardingCopy('confirm_failed', s.locale) }, reviewButtons(s)], 'review', '')
          return { sessionId: session.id, state: 'review', outcome: 'confirm_failed', sent: n }
        }
        // Resume the parked draft run in-process when the web could not reach the runtime
        // (guarded transitions make this idempotent if the ping did get through).
        if (!resumed) {
          try {
            const parked = new AgentRun({
              runId: draftRunId,
              userId: session.user_id,
              persona: 'provider',
              ledger: deps.core.ledger,
              gateway: deps.core.gateway,
              budget: deps.core.makeBudget({ runId: draftRunId, userId: session.user_id, agentName: 'onboarding' }),
              apiBaseUrl: deps.apiUrl,
              getToken: () => deps.tokenFor({ runId: draftRunId, userId: session.user_id }),
            })
            await parked.resume(TOOL, { session_id: session.id }, { decisionId })
            await parked.complete()
          } catch {
            /* already resumed + completed by the web ping */
          }
        }
        // Confirmed: facts with provenance, then the hand-off.
        const facts = capabilityFactsFromDraft(draftObj, s.locale).map((fct) => ({ user_id: session.user_id, provider_id: null, category_slug: fct.category_slug, fact: fct.fact, locale: fct.locale, source_decision_id: decisionId, source_session_id: session.id }))
        if (facts.length) {
          const { error } = await admin.from('provider_capability_facts').insert(facts)
          if (error) console.warn('[onboarding] facts insert failed', error.message)
        }
        const ts = now().toISOString()
        const moved = await patchSession('review', { state: 'confirmed', draft_decision_id: decisionId, confirmed_at: ts, revise_pending: false })
        if (!moved) return { sessionId: session.id, state: session.state, outcome: 'noop', sent: 0 }
        capture(session.user_id, 'onboarding_wa_confirmed', { session_id: session.id, decision_id: decisionId, facts: facts.length, draft_count: session.draft_count })
        const n = await send(promptFor('handed_off', s, { link }), 'handed_off', link)
        await patchSession('confirmed', { state: 'handed_off', handed_off_at: now().toISOString() })
        await clearActiveSession()
        capture(session.user_id, 'onboarding_wa_handed_off', { session_id: session.id, confirmed: true, sent: n })
        return { sessionId: session.id, state: 'handed_off', outcome: 'confirmed', sent: n }
      }
    },
  }
}

/** Sessions past expires_at in an active state — the expiry job's selection. */
export async function listExpiredOnboardingSessions(admin: SupabaseClient, now = new Date(), limit = 200): Promise<string[]> {
  const { data } = await admin
    .from('onboarding_sessions')
    .select('id')
    .not('state', 'in', '("handed_off","abandoned","failed")')
    .lte('expires_at', now.toISOString())
    .is('deleted_at', null)
    .order('expires_at', { ascending: true })
    .limit(limit)
  return ((data ?? []) as { id: string }[]).map((r) => r.id)
}

export { ONBOARDING_MAX_DRAFTS }
