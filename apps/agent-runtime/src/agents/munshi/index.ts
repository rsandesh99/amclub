import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  AgentRun,
  AgentRunError,
  approvalIntentAgent,
  munshiAskPayload,
  munshiDraftAgent,
  munshiQuotePayload,
  munshiReplyAgent,
  runAgent,
  signRuntimeCredential,
  templateFor,
  type AgentDefinition,
  type MunshiStubContext,
  type RunAgentDeps,
  type RunContext,
  type ThreadReplyQuoteFacts,
  type ToolCallResult,
  type WaLocale,
  type WhatsAppProvider,
} from '@amclub/agent-core'
import {
  MUNSHI_BAND_QUESTION,
  MUNSHI_BUTTON_TITLES,
  MUNSHI_DRAFT_TTL_HOURS,
  MUNSHI_MAX_DRAFTS_PER_SCAN,
  formatRupees,
  hasMunshiScopes,
  isUnambiguousYes,
  munshiCopy,
  parseMunshiButton,
  quoteWindowLapsed,
  renderMunshiDraft,
  renderMunshiReply,
  toMunshiLocale,
  type ApprovalIntent,
  type MunshiDraft,
  type MunshiDraftKind,
  type MunshiLocale,
  type ThreadReplyDraft,
} from '@amclub/shared'
import { readAgentSettings } from '../../settings'
import { boundConversationFor, currentWhatsAppGrants, phoneDigits } from '../../whatsapp/binding'
import { GROWTH_INTERVAL_DAYS, PROVIDER_COMPONENTS, SCORE_VERSION, growthNudgeLine, pickGrowthNudge, pickLocale, weakestComponents, type ComponentResult, type GrowthFacts, type GrowthNudge, type GrowthProfileField, type ProviderComponent } from '@amclub/shared'
import { transcribeVoiceNote } from '../onboarding/stt'
import { buttonPayloadOf } from '../onboarding/index'

/**
 * Digital Munshi — the runtime side (BUILD_PROMPTS S2.2).
 *
 *   munshi.scan (every 15 min)  → per enabled provider: a parent run reads the
 *     matched list + the price book under the provider's delegated token; one
 *     CHILD run per new match drives `munshiDraftAgent` (agent-core; harness-
 *     proven), which persists a munshi_drafts row and PARKS on submit_quote /
 *     ask_clarification. The draft is delivered (WhatsApp buttons in the 24 h
 *     window, else a template; an in-app notification through the web).
 *   munshi.decide (per provider reply)  → a button (`approve|edit|skip:<runId>`)
 *     or an utterance. Approval is the decision route under the delegated token
 *     (ai_decisions, feature munshi_draft / munshi_reply) followed by the
 *     runner's resume — the ORDINARY route runs the write. A voice note
 *     approves ONLY through `isUnambiguousYes` (code); the intent classifier
 *     (a child run, no tools) can only re-ask, edit or reject.
 *   munshi.followup (hourly)  → expiry of stale drafts, resumes the decision
 *     ping could not reach, window warnings, thread-reply drafts, re-drafts
 *     after a clarification answer.
 *
 * The service role here touches ONLY agent-owned tables (munshi_drafts,
 * munshi_provider_state, provider_capability_facts, wa_*, agent_grants) and
 * the ledgers; every RFQ / quote / thread read is a /api/v1 GET under the
 * token, every write a confirm:true tool resumed after the provider's tap.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MunshiRuntimeDeps {
  core: RunAgentDeps
  admin: SupabaseClient
  whatsapp: WhatsAppProvider
  apiUrl: string
  agentEnabled: boolean
  tokenFor: (args: { runId: string; userId: string }) => Promise<string>
  mediaBucket: string
  runtimeSecret: string
  now?: () => Date
  capture?: (userId: string, event: string, props?: Record<string, unknown>) => void
  fetchImpl?: typeof fetch
  /** Keyless producers (the rig, CI). Absent → `defaultStubDraft` (honest: quote inside the band, else ask). */
  stubDraft?: (ctx: MunshiStubContext) => MunshiDraft
  stubReply?: () => ThreadReplyDraft
  stubIntent?: (transcript: string) => ApprovalIntent
}

export interface MunshiScanJob { kind: 'scan'; jobId?: string | null }
export interface MunshiFollowupJob { kind: 'followup'; jobId?: string | null }
/**
 * A Munshi decision job. `utterance` = typed / spoken text; it may approve / edit / skip ONLY with `textApproval: true`,
 * which the dispatcher sets when the text is bound to exactly this draft (audit M42 — `bindTextConfirmation`); otherwise
 * (absent = a job from an older runtime) the buttons are re-sent and nothing is decided. `reask` = re-send this draft's
 * buttons without reading the message (the "which one?" answer when several proposals are open).
 */
export interface MunshiDecideJob { kind: 'decide'; runId: string; messageId: string; action: 'approve' | 'edit' | 'skip' | 'utterance' | 'reask'; textApproval?: boolean; jobId?: string | null }
/** S2.4 — the weekly growth nudge. */
export interface MunshiGrowthJob { kind: 'growth'; jobId?: string | null }
export type MunshiJob = MunshiScanJob | MunshiFollowupJob | MunshiDecideJob | MunshiGrowthJob
export type MunshiJobResult = { status: 'ok'; detail: Record<string, unknown> } | { status: 'failed'; error: string }

// ── settings + providers ─────────────────────────────────────────────────────

interface MunshiSettings {
  enabled: boolean
  cohort: Set<string>
  toleranceBps: number
  maxDraftsPerDay: number
  followupHoursBeforeLapse: number
  quoteWindowHours: number | null
}

async function settings(admin: SupabaseClient): Promise<MunshiSettings> {
  const s = await readAgentSettings(admin, ['agents_enabled', 'cohort_user_ids', 'munshi_price_tolerance_bps', 'munshi_max_drafts_per_day', 'munshi_followup_hours_before_lapse', 'quote_window_hours'])
  const int = (v: unknown, d: number, lo: number, hi: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : d)
  const win = s.quote_window_hours
  return {
    enabled: (s.agents_enabled as Record<string, boolean> | undefined)?.['munshi'] === true,
    cohort: new Set(Array.isArray(s.cohort_user_ids) ? (s.cohort_user_ids as string[]) : []),
    toleranceBps: int(s.munshi_price_tolerance_bps, 2500, 0, 10_000),
    maxDraftsPerDay: int(s.munshi_max_drafts_per_day, 20, 1, 100),
    followupHoursBeforeLapse: int(s.munshi_followup_hours_before_lapse, 6, 1, 24),
    quoteWindowHours: typeof win === 'number' && Number.isInteger(win) && win >= 6 && win <= 168 ? win : null,
  }
}

interface ProviderState {
  provider_id: string
  user_id: string
  locale: MunshiLocale
  paused_until: string | null
  drafts_today: number
  drafts_today_date: string | null
  last_scan_at: string | null
  munshi_reminders: Record<string, { warned_at: string }>
  scopes: string[]
  whatsapp: boolean
}

/** IST calendar date (the daily cap resets at midnight IST). */
export function istDate(d: Date): string {
  return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)
}

async function enabledProviders(deps: MunshiRuntimeDeps, s: MunshiSettings): Promise<ProviderState[]> {
  if (!s.enabled || !s.cohort.size) return []
  const now = (deps.now ?? (() => new Date()))()
  const [{ data: states }, { data: grants }] = await Promise.all([
    deps.admin.from('munshi_provider_state').select('provider_id, user_id, locale, paused_until, drafts_today, drafts_today_date, last_scan_at, munshi_reminders'),
    deps.admin.from('agent_grants').select('user_id, scopes, channel, channel_identity').eq('persona', 'provider').is('revoked_at', null),
  ])
  const grantRows = (grants as { user_id: string; scopes: string[] | null; channel: string; channel_identity: string | null }[] | null) ?? []
  // audit M41: a WhatsApp grant counts only for the phone it was given from = the user's CURRENT phone
  const waUserIds = [...new Set(grantRows.filter((g) => g.channel === 'whatsapp').map((g) => g.user_id))]
  const phoneByUser = new Map<string, string>()
  for (let i = 0; i < waUserIds.length; i += 200) {
    const { data: users } = await deps.admin.from('users').select('id, phone').in('id', waUserIds.slice(i, i + 200))
    for (const u of (users as { id: string; phone: string | null }[] | null) ?? []) phoneByUser.set(u.id, phoneDigits(u.phone))
  }
  const scopesByUser = new Map<string, Set<string>>()
  const waByUser = new Set<string>()
  for (const g of grantRows) {
    const set = scopesByUser.get(g.user_id) ?? new Set<string>()
    for (const sc of g.scopes ?? []) set.add(sc)
    scopesByUser.set(g.user_id, set)
    const phone = phoneByUser.get(g.user_id)
    if (g.channel === 'whatsapp' && hasMunshiScopes(g.scopes) && !!phone && phoneDigits(g.channel_identity) === phone) waByUser.add(g.user_id)
  }
  const out: ProviderState[] = []
  for (const st of (states as any[]) ?? []) {
    const scopes = [...(scopesByUser.get(st.user_id) ?? [])]
    if (!s.cohort.has(st.user_id) || !hasMunshiScopes(scopes)) continue
    if (st.paused_until && new Date(st.paused_until) > now) continue
    out.push({ ...st, locale: toMunshiLocale(st.locale), munshi_reminders: st.munshi_reminders ?? {}, scopes, whatsapp: waByUser.has(st.user_id) })
  }
  return out
}

function depsFor(deps: MunshiRuntimeDeps, scopes: readonly string[]): RunAgentDeps {
  return { ...deps.core, scopes, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) }
}

function runContext(deps: MunshiRuntimeDeps, args: { runId: string; userId: string; scopes: readonly string[] | null }): RunContext {
  return {
    runId: args.runId,
    userId: args.userId,
    persona: 'provider',
    ledger: deps.core.ledger,
    gateway: deps.core.gateway,
    budget: deps.core.makeBudget({ runId: args.runId, userId: args.userId, agentName: 'munshi' }),
    apiBaseUrl: deps.apiUrl,
    getToken: () => deps.core.makeToken({ runId: args.runId, persona: 'provider', userId: args.userId }),
    scopes: args.scopes,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  }
}

// ── the keyless producer (honest by construction) ────────────────────────────

const STUB_SCOPE: Record<MunshiLocale, (title: string) => string> = {
  en: (t) => `Service as described in "${t}", delivered as per your usual terms, with one round of clarification before we start.`,
  hi: (t) => `"${t}" में बताई गई सेवा, आपकी सामान्य शर्तों के अनुसार, शुरू करने से पहले एक बार स्पष्टीकरण के साथ।`,
  te: (t) => `"${t}" లో వివరించిన సేవ, మీ సాధారణ షరతుల ప్రకారం, ప్రారంభానికి ముందు ఒకసారి స్పష్టీకరణతో.`,
  ta: (t) => `"${t}" இல் விவரிக்கப்பட்ட சேவை, உங்கள் வழக்கமான நிபந்தனைகளின்படி, தொடங்கும் முன் ஒரு முறை தெளிவுபடுத்தலுடன்.`,
}

/** No key: quote at the accepted (else newest) basis price — inside the band by construction — or ask when there is no basis. */
export function defaultStubDraft(ctx: MunshiStubContext): MunshiDraft {
  const basis = ctx.basis
  if (ctx.band && basis.length) {
    const ref = basis.find((b) => b.accepted) ?? basis[0]!
    return {
      action: 'quote',
      quote: { price_paise: ref.price_paise, delivery_days: Math.max(1, Math.min(365, ref.delivery_days ?? 5)), scope: STUB_SCOPE[ctx.locale](ctx.rfqTitle.replace(/["<>]/g, '').slice(0, 80)), gst_included: null, transport_included: null, valid_until: null, advance_percent: null },
      basis: [],
      question: null,
      skip_reason: null,
      rationale: [`Priced at your ${ref.accepted ? 'accepted' : 'latest'} quote for this category (${formatRupees(ref.price_paise)}).`],
      confidence: 'medium',
    }
  }
  return { action: 'ask', quote: null, basis: [], question: MUNSHI_BAND_QUESTION[ctx.locale], skip_reason: null, rationale: ['No price history in this category yet.'], confidence: 'low' }
}

// ── WhatsApp delivery ────────────────────────────────────────────────────────

interface ConversationRow {
  id: string
  phone_e164: string
  window_open_until: string | null
}

/** Audit M41: the conversation of the user's CURRENT phone (bound to them) — never "the most recent inbound". */
async function conversationFor(admin: SupabaseClient, userId: string): Promise<ConversationRow | null> {
  return boundConversationFor(admin, userId)
}

async function recordOutbound(deps: MunshiRuntimeDeps, conv: ConversationRow, kind: 'text' | 'button' | 'template', body: string | null, r: { ok: boolean; vendorMessageId: string | null; detail: string }, extra: Record<string, unknown>): Promise<string | null> {
  const { data } = await deps.admin
    .from('wa_messages')
    .insert({
      conversation_id: conv.id,
      direction: 'out',
      vendor_message_id: r.vendorMessageId,
      kind,
      body,
      status: r.ok ? (r.detail === 'stub' ? 'stub' : 'sent') : 'failed',
      payload: { detail: r.detail, ...extra },
      ...(kind === 'template' && typeof extra['template_name'] === 'string' ? { template_name: extra['template_name'] } : {}),
    })
    .select('id')
    .single()
  if (r.ok) await deps.admin.from('wa_conversations').update({ last_outbound_at: (deps.now ?? (() => new Date()))().toISOString() }).eq('id', conv.id)
  return (data as { id: string } | null)?.id ?? null
}

function waLocale(l: MunshiLocale): WaLocale {
  return l === 'ta' ? 'en' : l
}

function inWindow(deps: MunshiRuntimeDeps, conv: ConversationRow): boolean {
  return !!conv.window_open_until && new Date(conv.window_open_until).getTime() > (deps.now ?? (() => new Date()))().getTime()
}

/** Text inside the 24 h window; a template outside it (needs the WhatsApp grant, which `whatsapp` already asserts). */
async function sendToProvider(deps: MunshiRuntimeDeps, st: Pick<ProviderState, 'user_id' | 'locale' | 'whatsapp'>, text: string, template: { kind: string; params: string[] } | null, extra: Record<string, unknown>): Promise<string | null> {
  if (!deps.agentEnabled || !st.whatsapp) return null
  const conv = await conversationFor(deps.admin, st.user_id)
  if (!conv) return null
  if (inWindow(deps, conv)) {
    const r = await deps.whatsapp.sendText(conv.phone_e164, text)
    return recordOutbound(deps, conv, 'text', text, r, extra)
  }
  if (!template) return null
  const tpl = templateFor(template.kind, waLocale(st.locale))
  if (!tpl) return null
  const r = await deps.whatsapp.sendTemplate(conv.phone_e164, tpl.name, waLocale(st.locale), template.params)
  return recordOutbound(deps, conv, 'template', null, r, { ...extra, template_name: tpl.name, params: template.params })
}

async function sendButtons(deps: MunshiRuntimeDeps, st: Pick<ProviderState, 'user_id' | 'locale' | 'whatsapp'>, runId: string, text: string, template: { kind: string; params: string[] }, extra: Record<string, unknown>): Promise<string | null> {
  if (!deps.agentEnabled || !st.whatsapp) return null
  const conv = await conversationFor(deps.admin, st.user_id)
  if (!conv) return null
  if (inWindow(deps, conv)) {
    const t = MUNSHI_BUTTON_TITLES[st.locale]
    const buttons = [
      { id: `approve:${runId}`, title: t.approve },
      { id: `edit:${runId}`, title: t.edit },
      { id: `skip:${runId}`, title: t.skip },
    ]
    const r = await deps.whatsapp.sendButtons(conv.phone_e164, text, buttons)
    return recordOutbound(deps, conv, 'button', text, r, { ...extra, buttons: buttons.map((b) => b.id) })
  }
  const tpl = templateFor(template.kind, waLocale(st.locale))
  if (!tpl) return null
  const r = await deps.whatsapp.sendTemplate(conv.phone_e164, tpl.name, waLocale(st.locale), template.params)
  return recordOutbound(deps, conv, 'template', null, r, { ...extra, template_name: tpl.name, params: template.params })
}

async function notifyWeb(deps: MunshiRuntimeDeps, args: { draftId: string; runId: string; userId: string }): Promise<boolean> {
  if (!deps.agentEnabled || !deps.runtimeSecret) return false
  try {
    const cred = signRuntimeCredential(deps.runtimeSecret, { userId: args.userId, persona: 'provider', runId: args.runId })
    const f = deps.fetchImpl ?? fetch
    const res = await f(`${deps.apiUrl}/api/v1/agent/munshi/drafts/${args.draftId}/notify`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `AMC-Runtime ${cred}` }, body: '{}' })
    return res.ok
  } catch (e) {
    console.warn('[munshi] notify failed', (e as Error).message)
    return false
  }
}

async function deliverDraft(deps: MunshiRuntimeDeps, st: ProviderState, d: { draftId: string; runId: string; kind: MunshiDraftKind; draft: MunshiDraft | ThreadReplyDraft; rfqTitle: string }): Promise<void> {
  const delivered: Record<string, unknown> = {}
  delivered['notification'] = await notifyWeb(deps, { draftId: d.draftId, runId: d.runId, userId: st.user_id })
  const text = d.kind === 'reply' ? renderMunshiReply(d.draft as ThreadReplyDraft, st.locale, d.rfqTitle) : renderMunshiDraft(d.draft as MunshiDraft, st.locale, d.rfqTitle)
  const q = d.kind === 'quote' ? (d.draft as MunshiDraft).quote : null
  const template = d.kind === 'reply' ? { kind: 'munshi_reply_draft', params: [d.rfqTitle.slice(0, 60)] } : { kind: 'munshi_draft', params: [d.rfqTitle.slice(0, 60), q ? `${formatRupees(q.price_paise)} · ${q.delivery_days}d` : '—'] }
  const waId = await sendButtons(deps, st, d.runId, text, template, { munshi_draft_id: d.draftId, run_id: d.runId })
  if (waId) delivered['whatsapp'] = waId
  await deps.admin.from('munshi_drafts').update({ delivered, updated_at: new Date().toISOString() }).eq('id', d.draftId)
}

// ── the parent scan agent: reads under the token, proposes nothing ───────────

const matchedListSchema = z.object({
  rfqs: z.array(
    z.object({ rfqId: z.string(), title: z.string(), status: z.string(), kind: z.string().optional(), categorySlug: z.string().nullable().optional(), quoted: z.boolean(), declined: z.boolean(), notifiedAt: z.string().nullable().optional(), expiresAt: z.string().optional() }).passthrough(),
  ),
})
type MatchedItem = z.infer<typeof matchedListSchema>['rfqs'][number]

interface ScanOutput {
  rfqs: MatchedItem[]
  providerCategories: string[]
}

const munshiScanAgent: AgentDefinition<Record<string, never>, ScanOutput> = {
  name: 'munshi',
  persona: 'provider',
  async run(run) {
    const list = await run.proposeTool('extract_requirements')
    if (list.status !== 'done') throw new Error('unexpected_park')
    if (!list.result.ok) throw new Error(`matched_read_failed:${list.result.status}`)
    const parsed = matchedListSchema.safeParse(list.result.body)
    if (!parsed.success) throw new Error('matched_read_failed:shape')
    const pb = await run.proposeTool('read_price_book')
    if (pb.status !== 'done') throw new Error('unexpected_park')
    const cats = new Set<string>()
    if (pb.result.ok) for (const r of ((pb.result.body as { rows?: { category_slug?: string }[] })?.rows ?? [])) if (r.category_slug) cats.add(r.category_slug)
    return { rfqs: parsed.data.rfqs, providerCategories: [...cats] }
  },
}

async function capabilityFacts(admin: SupabaseClient, providerId: string, categorySlug: string | null): Promise<string[]> {
  const { data } = await admin.from('provider_capability_facts').select('fact, category_slug').eq('provider_id', providerId).is('deleted_at', null).limit(30)
  const rows = (data as { fact: string; category_slug: string }[] | null) ?? []
  return rows.filter((r) => !categorySlug || r.category_slug === categorySlug).map((r) => r.fact).slice(0, 12)
}

async function bumpState(admin: SupabaseClient, st: ProviderState, patch: Record<string, unknown>): Promise<void> {
  const { error } = await admin.from('munshi_provider_state').update({ ...patch, updated_at: new Date().toISOString() }).eq('provider_id', st.provider_id)
  if (error) console.error('[munshi] state update failed', error.message)
}

// ── munshi.scan ──────────────────────────────────────────────────────────────

export async function runMunshiScan(deps: MunshiRuntimeDeps): Promise<MunshiJobResult> {
  if (!deps.agentEnabled) return { status: 'failed', error: 'agent_disabled' }
  const s = await settings(deps.admin)
  const providers = await enabledProviders(deps, s)
  const now = (deps.now ?? (() => new Date()))()
  const today = istDate(now)
  const detail = { providers: providers.length, runs: 0, proposed: 0, skipped: 0, failed: 0 }
  for (const st of providers) {
    const draftsToday = st.drafts_today_date === today ? st.drafts_today : 0
    let remaining = Math.min(MUNSHI_MAX_DRAFTS_PER_SCAN, s.maxDraftsPerDay - draftsToday)
    if (remaining <= 0) continue
    const parent = await runAgent(munshiScanAgent, depsFor(deps, st.scopes), { userId: st.user_id, surface: 'system', subjectType: 'provider', subjectId: st.provider_id }, {})
    detail.runs++
    if (parent.status !== 'completed') {
      console.warn(`[munshi] scan run ${parent.runId} for provider ${st.provider_id}: ${parent.status === 'failed' ? parent.error : parent.status}`)
      await bumpState(deps.admin, st, { last_scan_at: now.toISOString(), last_scan_run_id: parent.runId })
      continue
    }
    const since = st.last_scan_at ? new Date(new Date(st.last_scan_at).getTime() - 5 * 60 * 1000) : null
    const candidates = parent.output.rfqs.filter((r) => !r.quoted && !r.declined && (r.status === 'open' || r.status === 'quoted') && (!since || !r.notifiedAt || new Date(r.notifiedAt) > since))
    const ids = candidates.map((r) => r.rfqId)
    const blocked = new Set<string>()
    if (ids.length) {
      const { data: existing } = await deps.admin.from('munshi_drafts').select('rfq_id, status, result_ref').eq('provider_id', st.provider_id).in('rfq_id', ids).is('deleted_at', null)
      for (const e of (existing as { rfq_id: string; status: string; result_ref: { redraft?: boolean } | null }[] | null) ?? []) {
        if (!(e.status === 'expired' && e.result_ref?.redraft === true)) blocked.add(e.rfq_id)
      }
    }
    let proposedNow = 0
    for (const r of candidates) {
      if (remaining <= 0) break
      if (blocked.has(r.rfqId)) continue
      const windowLapsed = !!(s.quoteWindowHours && r.notifiedAt && quoteWindowLapsed(new Date(r.notifiedAt), s.quoteWindowHours, now))
      const facts = await capabilityFacts(deps.admin, st.provider_id, r.categorySlug ?? null)
      let persistedId: string | null = null
      const child = await runAgent(
        munshiDraftAgent,
        depsFor(deps, st.scopes),
        { userId: st.user_id, surface: 'system', subjectType: 'rfq', subjectId: r.rfqId, parentRunId: parent.runId },
        {
          rfqId: r.rfqId,
          locale: st.locale,
          today,
          providerCategories: parent.output.providerCategories,
          capabilityFacts: facts,
          toleranceBps: s.toleranceBps,
          windowLapsed,
          stub: deps.stubDraft ?? defaultStubDraft,
          persist: async (p) => {
            const { data, error } = await deps.admin
              .from('munshi_drafts')
              .insert({
                provider_id: st.provider_id,
                user_id: st.user_id,
                rfq_id: p.rfq.id,
                kind: p.draft.action,
                run_id: p.runId,
                draft: p.draft,
                basis: p.draft.basis,
                status: p.draft.action === 'skip' ? 'skipped' : 'proposed',
                stub: !p.codeOnly && !!deps.stubDraft,
                expires_at: new Date(now.getTime() + MUNSHI_DRAFT_TTL_HOURS * 3600 * 1000).toISOString(),
                result_ref: p.draft.action === 'skip' ? { skip_reason: p.draft.skip_reason, code_only: p.codeOnly } : null,
              })
              .select('id')
              .single()
            if (error) throw new Error(`draft_persist_failed:${error.message}`)
            persistedId = (data as { id: string }).id
            return { draftId: persistedId }
          },
        },
      )
      detail.runs++
      const run = await deps.core.ledger.getRun(child.runId)
      if (persistedId) await deps.admin.from('munshi_drafts').update({ model_cost_paise: run?.costEstPaise ?? 0 }).eq('id', persistedId)
      if (child.status === 'awaiting_confirmation' && persistedId) {
        const { data: row } = await deps.admin.from('munshi_drafts').select('id, kind, draft').eq('id', persistedId).maybeSingle()
        if (row) await deliverDraft(deps, st, { draftId: persistedId, runId: child.runId, kind: (row as any).kind, draft: (row as any).draft, rfqTitle: r.title })
        deps.capture?.(st.user_id, 'munshi_draft_proposed', { kind: child.output.action, action: child.output.action, confidence: (row as any)?.draft?.confidence ?? null, has_basis: ((row as any)?.draft?.basis?.length ?? 0) > 0 })
        proposedNow++
        remaining--
        detail.proposed++
      } else if (child.status === 'completed') {
        detail.skipped++
      } else {
        detail.failed++
        if (persistedId) await deps.admin.from('munshi_drafts').update({ status: 'failed', result_ref: { error: child.status === 'failed' ? child.error : 'unknown' }, updated_at: now.toISOString() }).eq('id', persistedId).eq('status', 'proposed')
        console.warn(`[munshi] draft run ${child.runId} failed: ${child.status === 'failed' ? child.error : child.status}`)
      }
    }
    await bumpState(deps.admin, st, { last_scan_at: now.toISOString(), last_scan_run_id: parent.runId, drafts_today: draftsToday + proposedNow, drafts_today_date: today })
  }
  return { status: 'ok', detail }
}

// ── outcomes (shared by decide, the resume route and the follow-up) ──────────

interface DraftRow {
  id: string
  provider_id: string
  user_id: string
  rfq_id: string | null
  quote_id: string | null
  kind: MunshiDraftKind
  status: string
  run_id: string | null
  draft: unknown
  decision_id: string | null
  rfq: { title: string } | null
}

async function draftByRun(admin: SupabaseClient, runId: string): Promise<DraftRow | null> {
  const { data } = await admin.from('munshi_drafts').select('id, provider_id, user_id, rfq_id, quote_id, kind, status, run_id, draft, decision_id, rfq:rfqs(title)').eq('run_id', runId).is('deleted_at', null).maybeSingle()
  return (data as DraftRow | null) ?? null
}

async function providerStateFor(deps: MunshiRuntimeDeps, providerId: string, userId: string): Promise<Pick<ProviderState, 'user_id' | 'locale' | 'whatsapp'>> {
  const [{ data: st }, grants] = await Promise.all([
    deps.admin.from('munshi_provider_state').select('locale').eq('provider_id', providerId).maybeSingle(),
    // audit M41: only a grant given from the user's current phone
    currentWhatsAppGrants(deps.admin, userId, 'provider'),
  ])
  return { user_id: userId, locale: toMunshiLocale((st as { locale?: string } | null)?.locale), whatsapp: grants.some((g) => hasMunshiScopes(g.scopes)) }
}

function toolFor(kind: MunshiDraftKind): 'submit_quote' | 'ask_clarification' | 'reply_thread' {
  return kind === 'quote' ? 'submit_quote' : kind === 'ask' ? 'ask_clarification' : 'reply_thread'
}

function payloadFor(d: DraftRow): Record<string, unknown> {
  if (d.kind === 'quote') return munshiQuotePayload(d.draft as MunshiDraft, d.rfq_id ?? '', d.id)
  if (d.kind === 'ask') return munshiAskPayload(d.draft as MunshiDraft, d.rfq_id ?? '', d.id)
  return { quote_id: d.quote_id ?? '', body: (d.draft as ThreadReplyDraft).body, munshi_draft_id: d.id }
}

/**
 * After the ordinary route ran (resume): approved + result_ref on 2xx; expired
 * / failed with the reason on 4xx (already_quoted, rfq_closed, declined,
 * tool_out_of_scope); the provider is told either way. Guarded on 'proposed'.
 */
export async function finalizeMunshiRun(deps: MunshiRuntimeDeps, runId: string, outcome: ToolCallResult | null, error: string | null, via: string): Promise<void> {
  const d = await draftByRun(deps.admin, runId)
  if (!d) return
  const st = await providerStateFor(deps, d.provider_id, d.user_id)
  const now = new Date().toISOString()
  // The quote route already closed the draft (approved + result_ref) when the run's own submit ran — the
  // spine-safe path; here only the decision link and the provider's "sent" message remain.
  if (d.status === 'approved' && !d.decision_id) {
    const { data: dec } = await deps.admin.from('ai_decisions').select('id').eq('run_id', runId).eq('tool', toolFor(d.kind)).order('created_at', { ascending: false }).limit(1).maybeSingle()
    await deps.admin.from('munshi_drafts').update({ decision_id: (dec as { id: string } | null)?.id ?? null, updated_at: now }).eq('id', d.id).eq('status', 'approved')
    const copy = d.kind === 'quote' ? 'sent_quote' : d.kind === 'ask' ? 'sent_ask' : 'sent_reply'
    deps.capture?.(d.user_id, 'munshi_draft_decided', { via, outcome: 'approved', kind: d.kind })
    await sendToProvider(deps, st, munshiCopy(copy, st.locale), { kind: 'munshi_result', params: [munshiCopy(copy, st.locale).slice(0, 120)] }, { munshi_draft_id: d.id, run_id: runId, outcome: 'approved' })
    return
  }
  if (d.status !== 'proposed') return
  const body = (outcome?.body ?? null) as Record<string, unknown> | null
  const errCode = (typeof body?.['error'] === 'string' ? (body['error'] as string) : null) ?? error
  let status: 'approved' | 'expired' | 'failed'
  let copy: Parameters<typeof munshiCopy>[0]
  let resultRef: Record<string, unknown>
  if (outcome?.ok) {
    status = 'approved'
    copy = d.kind === 'quote' ? 'sent_quote' : d.kind === 'ask' ? 'sent_ask' : 'sent_reply'
    resultRef = d.kind === 'quote' ? { quote_id: body?.['quoteId'] ?? null, via } : d.kind === 'ask' ? { clarification_id: (body?.['clarification'] as { id?: string } | undefined)?.id ?? null, via } : { message_id: body?.['id'] ?? null, via }
  } else if (errCode === 'already_quoted' || errCode === 'rfq_closed' || errCode === 'declined' || errCode === 'clarification_cap') {
    status = 'expired'
    copy = errCode === 'already_quoted' ? 'failed_already_quoted' : errCode === 'declined' ? 'failed_declined' : 'failed_closed'
    resultRef = { error: errCode, status: outcome?.status ?? null, via }
  } else {
    status = 'failed'
    copy = errCode === 'tool_out_of_scope' ? 'failed_scope' : 'failed_other'
    resultRef = { error: errCode ?? 'unknown', status: outcome?.status ?? null, via }
  }
  let decisionId: string | null = null
  if (status === 'approved') {
    const { data: dec } = await deps.admin.from('ai_decisions').select('id').eq('run_id', runId).eq('tool', toolFor(d.kind)).order('created_at', { ascending: false }).limit(1).maybeSingle()
    decisionId = (dec as { id: string } | null)?.id ?? null
  }
  await deps.admin.from('munshi_drafts').update({ status, result_ref: resultRef, decision_id: decisionId, updated_at: now }).eq('id', d.id).eq('status', 'proposed')
  if (status !== 'approved' && d.run_id) {
    // a 4xx from the route leaves the run running/completed; the draft is closed, so record the failure on the run too
    try {
      const run = await deps.core.ledger.getRun(d.run_id)
      if (run?.status === 'running') await deps.core.ledger.transitionRun(d.run_id, 'running', 'failed', { error: errCode ?? 'route_refused' })
    } catch {
      /* already advanced */
    }
  }
  const outcomeLabel = status === 'approved' ? 'approved' : status
  deps.capture?.(d.user_id, 'munshi_draft_decided', { via, outcome: outcomeLabel, kind: d.kind })
  await sendToProvider(deps, st, munshiCopy(copy, st.locale), { kind: 'munshi_result', params: [munshiCopy(copy, st.locale).slice(0, 120)] }, { munshi_draft_id: d.id, run_id: runId, outcome: outcomeLabel })
}

/** The decision route said approved but could not reach the runtime (or we ARE the runtime, in-process): resume here. */
async function resumeInProcess(deps: MunshiRuntimeDeps, d: DraftRow, decisionId: string | null, scopes: readonly string[], via: string): Promise<void> {
  if (!d.run_id) return
  const run = new AgentRun(runContext(deps, { runId: d.run_id, userId: d.user_id, scopes }))
  try {
    const outcome = await run.resume(toolFor(d.kind), payloadFor(d), decisionId ? { decisionId } : undefined)
    try {
      await run.complete()
    } catch {
      /* already completed by a concurrent resume */
    }
    await finalizeMunshiRun(deps, d.run_id, outcome.status === 'done' ? outcome.result : null, null, via)
  } catch (e) {
    // an AgentRunError reports its CODE (tool_out_of_scope, budget_…), as runAgent does, so the draft's reason and the
    // provider's copy match the runner's vocabulary
    const msg = e instanceof AgentRunError ? e.code : (e as Error).message
    await run.fail(msg)
    await finalizeMunshiRun(deps, d.run_id, null, msg, via)
  }
}

async function scopesFor(admin: SupabaseClient, userId: string): Promise<string[]> {
  const { data } = await admin.from('agent_grants').select('scopes').eq('user_id', userId).eq('persona', 'provider').is('revoked_at', null)
  return [...new Set(((data as { scopes: string[] | null }[] | null) ?? []).flatMap((g) => g.scopes ?? []))]
}

/** POST the decision route under the provider's delegated token (the ONE confirmation ledger writer). */
async function postDecision(deps: MunshiRuntimeDeps, d: DraftRow, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; decisionId: string | null; resumed: boolean; error: string | null }> {
  if (!d.run_id) return { ok: false, status: 0, decisionId: null, resumed: false, error: 'no_run' }
  const f = deps.fetchImpl ?? fetch
  try {
    const token = await deps.tokenFor({ runId: d.run_id, userId: d.user_id })
    const res = await f(`${deps.apiUrl}/api/v1/agent/runs/${d.run_id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    const json = (await res.json().catch(() => null)) as { decision_id?: string; resumed?: boolean; status?: string; error?: string } | null
    return { ok: res.ok, status: res.status, decisionId: json?.decision_id ?? null, resumed: json?.resumed === true, error: json?.error ?? null }
  } catch (e) {
    return { ok: false, status: 0, decisionId: null, resumed: false, error: (e as Error).message }
  }
}

// ── munshi.decide ────────────────────────────────────────────────────────────

export async function runMunshiDecide(deps: MunshiRuntimeDeps, job: MunshiDecideJob): Promise<MunshiJobResult> {
  if (!deps.agentEnabled) return { status: 'failed', error: 'agent_disabled' }
  const d = await draftByRun(deps.admin, job.runId)
  if (!d) return { status: 'failed', error: 'draft_gone' }
  const { data: msg } = await deps.admin.from('wa_messages').select('id, conversation_id, kind, body, media_ref, mime, payload').eq('id', job.messageId).maybeSingle()
  if (!msg) return { status: 'failed', error: 'message_not_found' }
  const { data: conv } = await deps.admin.from('wa_conversations').select('id, user_id, phone_e164, window_open_until').eq('id', (msg as any).conversation_id).maybeSingle()
  if (!conv || (conv as any).user_id !== d.user_id) return { status: 'failed', error: 'message_conversation_mismatch' }
  const st = await providerStateFor(deps, d.provider_id, d.user_id)
  const rfqTitle = d.rfq?.title ?? ''
  if (d.status !== 'proposed') {
    await sendToProvider(deps, st, munshiCopy('draft_gone', st.locale), null, { munshi_draft_id: d.id })
    return { status: 'ok', detail: { outcome: 'draft_gone' } }
  }
  const scopes = await scopesFor(deps.admin, d.user_id)
  let action: 'approve' | 'edit' | 'skip' | 'reask' = job.action === 'utterance' ? 'reask' : job.action
  const inputRefs: Record<string, string> = { munshi_draft_id: d.id, wa_message_id: job.messageId }
  let via: 'whatsapp_button' | 'voice_yes' | 'whatsapp_text' = 'whatsapp_button'
  let editInstructions: string | null = null
  // audit M42: text decides only when the dispatcher bound it to THIS draft; otherwise the buttons come back (reask)
  const textBound = job.action === 'utterance' && job.textApproval === true
  if (job.action === 'utterance' && !textBound) deps.capture?.(d.user_id, 'munshi_text_not_bound', { kind: d.kind })

  if (textBound) {
    let text: string | null = null
    const m = msg as { kind: string; body: string | null; media_ref: string | null; mime: string | null }
    if (m.kind === 'audio' && m.media_ref && d.run_id) {
      const token = await deps.tokenFor({ runId: d.run_id, userId: d.user_id })
      const t = await transcribeVoiceNote({ admin: deps.admin, bucket: deps.mediaBucket, mediaRef: m.media_ref, mime: m.mime, apiUrl: deps.apiUrl, token, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) })
      if (t.ok) {
        text = t.text
        inputRefs['transcript_vendor'] = t.vendor
      }
      via = 'voice_yes'
    } else {
      text = m.body
      via = 'whatsapp_text'
    }
    if (text && isUnambiguousYes(text, st.locale)) {
      action = 'approve'
    } else if (text) {
      // The classifier: a child run, no tools; its output can never approve.
      const r = await runAgent(
        approvalIntentAgent,
        depsFor(deps, scopes),
        { userId: d.user_id, surface: 'whatsapp', subjectType: 'munshi_draft', subjectId: d.id, parentRunId: d.run_id, meta: { message_id: job.messageId } },
        { transcript: text, messageId: job.messageId, locale: st.locale, draftKind: d.kind, via: m.kind === 'audio' ? 'audio' : 'text', ...(deps.stubIntent ? { stub: () => deps.stubIntent!(text!) } : {}) },
      )
      const intent = r.status === 'completed' ? r.output.intent : 'unclear'
      if (intent === 'reject') action = 'skip'
      else if (intent === 'edit') {
        action = 'edit'
        editInstructions = r.status === 'completed' ? r.output.edit_instructions : null
      } else action = 'reask' // 'approve' from a model is NOT an approval
    }
  }

  if (action === 'reask') {
    // re-send THIS draft's card (its text + buttons, so the provider can tell several open cards apart); run_id on the
    // outbound row lets a quoted reply bind to it
    const draftText = d.kind === 'reply' ? renderMunshiReply(d.draft as ThreadReplyDraft, st.locale, rfqTitle) : renderMunshiDraft(d.draft as MunshiDraft, st.locale, rfqTitle)
    const text = `${munshiCopy('reask', st.locale)}\n\n${draftText}`
    if (d.run_id) await sendButtons(deps, st, d.run_id, text, { kind: 'munshi_draft', params: [rfqTitle.slice(0, 60), '—'] }, { munshi_draft_id: d.id, run_id: d.run_id, reask: true })
    return { status: 'ok', detail: { outcome: 'reask', bound: textBound } }
  }
  if (action === 'skip') {
    const r = await postDecision(deps, d, { approve: false, reason: 'skipped', input_refs: inputRefs })
    await deps.admin.from('munshi_drafts').update({ status: 'skipped', result_ref: { skipped_via: via, decision_status: r.status }, updated_at: new Date().toISOString() }).eq('id', d.id).eq('status', 'proposed')
    deps.capture?.(d.user_id, 'munshi_draft_decided', { via, outcome: 'skipped', kind: d.kind })
    await sendToProvider(deps, st, munshiCopy('skipped', st.locale), null, { munshi_draft_id: d.id })
    return { status: 'ok', detail: { outcome: 'skipped' } }
  }
  if (action === 'edit') {
    const r = await postDecision(deps, d, { approve: false, reason: 'edited', input_refs: inputRefs })
    await deps.admin.from('munshi_drafts').update({ status: 'edited', result_ref: { edited_via: via, decision_status: r.status, ...(editInstructions ? { instructions: editInstructions.slice(0, 500) } : {}) }, updated_at: new Date().toISOString() }).eq('id', d.id).eq('status', 'proposed')
    deps.capture?.(d.user_id, 'munshi_draft_decided', { via, outcome: 'edited', kind: d.kind })
    const link = d.kind === 'reply' ? `${deps.apiUrl}/partner/rfqs/${d.rfq_id ?? ''}` : `${deps.apiUrl}/partner/rfqs/${d.rfq_id ?? ''}?munshi=${d.id}`
    const text = munshiCopy('edited', st.locale, { link }) + (editInstructions ? `\n\n“${editInstructions.slice(0, 300)}”` : '')
    await sendToProvider(deps, st, text, { kind: 'munshi_result', params: [munshiCopy('edited', st.locale, { link }).slice(0, 120)] }, { munshi_draft_id: d.id })
    return { status: 'ok', detail: { outcome: 'edited' } }
  }
  // approve
  const r = await postDecision(deps, d, { approve: true, final: payloadFor(d), input_refs: inputRefs })
  let decisionId = r.decisionId
  if (!r.ok && r.status === 409 && d.run_id) {
    // Replayed button / a second "yes": the decision may already exist; resume idempotently.
    const { data: dec } = await deps.admin.from('ai_decisions').select('id').eq('run_id', d.run_id).eq('tool', toolFor(d.kind)).limit(1).maybeSingle()
    decisionId = (dec as { id: string } | null)?.id ?? null
  }
  if (!r.ok && !decisionId) {
    await sendToProvider(deps, st, munshiCopy('failed_other', st.locale), null, { munshi_draft_id: d.id, decision_error: r.error })
    return { status: 'failed', error: `decision_failed:${r.status}:${r.error ?? ''}` }
  }
  if (!r.resumed) await resumeInProcess(deps, d, decisionId, scopes, via)
  return { status: 'ok', detail: { outcome: 'approved', resumed_by: r.resumed ? 'web_ping' : 'in_process' } }
}

// ── the follow-up parent agent: reads only ───────────────────────────────────

const rfqDetailLiteSchema = z.object({
  role: z.literal('provider'),
  rfq: z.object({ id: z.string(), title: z.string(), status: z.string(), myQuote: z.object({ id: z.string(), pricePaise: z.number(), deliveryDays: z.number(), scope: z.string().nullable().optional(), status: z.string(), gstIncluded: z.boolean().nullable().optional(), transportIncluded: z.boolean().nullable().optional(), validUntil: z.string().nullable().optional(), advancePercent: z.number().nullable().optional() }).passthrough().nullable().optional(), clarifications: z.array(z.object({ id: z.string(), mine: z.boolean().optional(), answer: z.string().nullable().optional() }).passthrough()).optional() }).passthrough(),
})

interface ThreadCandidate {
  quoteId: string
  rfqId: string
  rfqTitle: string
  quote: ThreadReplyQuoteFacts
  scope: string
  messages: { id: string; mine: boolean; body: string; createdAt: string }[]
}

interface FollowupOutput {
  warnings: { rfqId: string; title: string; hoursLeft: number }[]
  threads: ThreadCandidate[]
  answeredAskRfqIds: string[]
}

function followupAgent(deps: MunshiRuntimeDeps, s: MunshiSettings, st: ProviderState, openAskRfqIds: Set<string>): AgentDefinition<Record<string, never>, FollowupOutput> {
  const now = (deps.now ?? (() => new Date()))()
  return {
    name: 'munshi',
    persona: 'provider',
    async run(run) {
      const list = await run.proposeTool('extract_requirements')
      if (list.status !== 'done') throw new Error('unexpected_park')
      if (!list.result.ok) throw new Error(`matched_read_failed:${list.result.status}`)
      const parsed = matchedListSchema.safeParse(list.result.body)
      if (!parsed.success) throw new Error('matched_read_failed:shape')
      const out: FollowupOutput = { warnings: [], threads: [], answeredAskRfqIds: [] }
      // (a) window warnings — once per match, when the window lapses within N hours
      if (s.quoteWindowHours) {
        for (const r of parsed.data.rfqs) {
          if (r.quoted || r.declined || !r.notifiedAt || st.munshi_reminders[r.rfqId]) continue
          const lapseAt = new Date(r.notifiedAt).getTime() + s.quoteWindowHours * 3600 * 1000
          const hoursLeft = (lapseAt - now.getTime()) / 3600 / 1000
          if (hoursLeft > 0 && hoursLeft <= s.followupHoursBeforeLapse) out.warnings.push({ rfqId: r.rfqId, title: r.title, hoursLeft: Math.max(1, Math.round(hoursLeft)) })
        }
      }
      // (b) quote threads with an unanswered buyer message (≥ 2 h old) + (c) answered clarifications on an open ask
      const token = await deps.tokenFor({ runId: run.runId, userId: st.user_id })
      const f = deps.fetchImpl ?? fetch
      const interesting = parsed.data.rfqs.filter((r) => r.quoted || openAskRfqIds.has(r.rfqId)).slice(0, 10)
      for (const r of interesting) {
        const det = await run.proposeTool('extract_requirements', { rfq_id: r.rfqId })
        if (det.status !== 'done' || !det.result.ok) continue
        const dp = rfqDetailLiteSchema.safeParse(det.result.body)
        if (!dp.success) continue
        const rfq = dp.data.rfq
        if (openAskRfqIds.has(r.rfqId) && (rfq.clarifications ?? []).some((c) => c.mine && c.answer)) out.answeredAskRfqIds.push(r.rfqId)
        const q = rfq.myQuote
        if (!q || q.status !== 'submitted') continue
        // a scripted GET under the token (the reply scope implies reading the thread) — never a model-proposed tool
        const res = await f(`${deps.apiUrl}/api/v1/quotes/${q.id}/messages`, { headers: { Authorization: `Bearer ${token}` } })
        if (!res.ok) continue
        const body = (await res.json().catch(() => null)) as { messages?: { id: string; mine: boolean; body: string; createdAt: string }[] } | null
        const msgs = body?.messages ?? []
        const last = msgs.at(-1)
        if (!last || last.mine) continue
        const age = now.getTime() - new Date(last.createdAt).getTime()
        if (age < 2 * 3600 * 1000) continue
        out.threads.push({
          quoteId: q.id,
          rfqId: rfq.id,
          rfqTitle: rfq.title,
          quote: { price_paise: q.pricePaise, delivery_days: q.deliveryDays, gst_included: q.gstIncluded ?? null, transport_included: q.transportIncluded ?? null, valid_until: q.validUntil ?? null, advance_percent: q.advancePercent ?? null, status: q.status },
          scope: q.scope ?? '',
          messages: msgs.slice(-12),
        })
      }
      return out
    },
  }
}

async function cancelRun(deps: MunshiRuntimeDeps, runId: string | null, reason: string): Promise<void> {
  if (!runId) return
  try {
    const run = await deps.core.ledger.getRun(runId)
    if (run?.status === 'awaiting_confirmation') {
      await deps.core.ledger.appendEvent({ runId, kind: 'declined', actor: 'system', payload: { reason } })
      await deps.core.ledger.transitionRun(runId, 'awaiting_confirmation', 'cancelled')
    }
  } catch {
    /* already advanced */
  }
}

// ── munshi.followup ──────────────────────────────────────────────────────────

export async function runMunshiFollowup(deps: MunshiRuntimeDeps): Promise<MunshiJobResult> {
  if (!deps.agentEnabled) return { status: 'failed', error: 'agent_disabled' }
  const s = await settings(deps.admin)
  const now = (deps.now ?? (() => new Date()))()
  const nowIso = now.toISOString()
  const detail = { expired: 0, resumed: 0, providers: 0, warnings: 0, replies: 0, redrafts: 0 }

  // (1) expire stale proposals (TTL) and cancel their parked runs
  const { data: stale } = await deps.admin.from('munshi_drafts').select('id, run_id, user_id, kind').eq('status', 'proposed').lt('expires_at', nowIso).is('deleted_at', null).limit(200)
  for (const d of (stale as { id: string; run_id: string | null; user_id: string; kind: MunshiDraftKind }[] | null) ?? []) {
    await cancelRun(deps, d.run_id, 'expired')
    const { data: upd } = await deps.admin.from('munshi_drafts').update({ status: 'expired', result_ref: { reason: 'ttl' }, updated_at: nowIso }).eq('id', d.id).eq('status', 'proposed').select('id')
    if (Array.isArray(upd) && upd.length) {
      detail.expired++
      deps.capture?.(d.user_id, 'munshi_draft_decided', { via: 'system', outcome: 'expired', kind: d.kind })
    }
  }

  // (2) approved on the web but the runtime ping did not land: the ai_decisions row exists, the run still waits
  const { data: pending } = await deps.admin.from('munshi_drafts').select('id, provider_id, user_id, rfq_id, quote_id, kind, status, run_id, draft, rfq:rfqs(title)').eq('status', 'proposed').not('run_id', 'is', null).is('deleted_at', null).limit(200)
  for (const d of (pending as DraftRow[] | null) ?? []) {
    if (!d.run_id) continue
    const run = await deps.core.ledger.getRun(d.run_id)
    if (run?.status !== 'awaiting_confirmation') continue
    const { data: dec } = await deps.admin.from('ai_decisions').select('id').eq('run_id', d.run_id).eq('tool', toolFor(d.kind)).limit(1).maybeSingle()
    const decisionId = (dec as { id: string } | null)?.id
    if (!decisionId) continue
    await resumeInProcess(deps, d, decisionId, await scopesFor(deps.admin, d.user_id), 'web')
    detail.resumed++
  }

  // (3) per enabled provider: warnings, thread replies, re-drafts after an answered clarification
  const providers = await enabledProviders(deps, s)
  for (const st of providers) {
    detail.providers++
    const { data: openAsks } = await deps.admin.from('munshi_drafts').select('id, rfq_id, run_id').eq('provider_id', st.provider_id).eq('kind', 'ask').eq('status', 'proposed').is('deleted_at', null)
    const askByRfq = new Map<string, { id: string; run_id: string | null }>()
    for (const a of (openAsks as { id: string; rfq_id: string | null; run_id: string | null }[] | null) ?? []) if (a.rfq_id) askByRfq.set(a.rfq_id, a)
    const parent = await runAgent(followupAgent(deps, s, st, new Set(askByRfq.keys())), depsFor(deps, st.scopes), { userId: st.user_id, surface: 'system', subjectType: 'provider', subjectId: st.provider_id, meta: { job: 'followup' } }, {})
    if (parent.status !== 'completed') {
      console.warn(`[munshi] followup run ${parent.runId}: ${parent.status === 'failed' ? parent.error : parent.status}`)
      continue
    }
    // (a) warnings
    const reminders = { ...st.munshi_reminders }
    for (const w of parent.output.warnings) {
      const text = munshiCopy('window_warning', st.locale, { title: w.title.slice(0, 80), hours: w.hoursLeft })
      const sent = await sendToProvider(deps, st, text, { kind: 'munshi_window_warning', params: [w.title.slice(0, 60), String(w.hoursLeft)] }, { rfq_id: w.rfqId, reminder: true })
      await notifyWebReminder(deps, st, w)
      reminders[w.rfqId] = { warned_at: nowIso }
      detail.warnings++
      deps.capture?.(st.user_id, 'munshi_reminder_sent', { rfq_id: w.rfqId, whatsapp: !!sent })
    }
    if (parent.output.warnings.length) await bumpState(deps.admin, st, { munshi_reminders: reminders })
    // (c) answered clarification on an open ask → expire that draft; the next scan re-drafts (redraft marker)
    for (const rfqId of parent.output.answeredAskRfqIds) {
      const a = askByRfq.get(rfqId)
      if (!a) continue
      await cancelRun(deps, a.run_id, 'clarification_answered')
      await deps.admin.from('munshi_drafts').update({ status: 'expired', result_ref: { redraft: true, reason: 'clarification_answered' }, updated_at: nowIso }).eq('id', a.id).eq('status', 'proposed')
      detail.redrafts++
    }
    // (b) thread replies — one child run per thread, ≤ 3 per provider per hour
    for (const t of parent.output.threads.slice(0, 3)) {
      const { data: existing } = await deps.admin.from('munshi_drafts').select('id, created_at').eq('provider_id', st.provider_id).eq('kind', 'reply').eq('quote_id', t.quoteId).in('status', ['proposed', 'approved', 'edited']).is('deleted_at', null).order('created_at', { ascending: false }).limit(1).maybeSingle()
      const lastMsgAt = t.messages.at(-1)?.createdAt ?? nowIso
      if (existing && new Date((existing as { created_at: string }).created_at) > new Date(lastMsgAt)) continue
      let persistedId: string | null = null
      const child = await runAgent(
        munshiReplyAgent,
        depsFor(deps, st.scopes),
        { userId: st.user_id, surface: 'system', subjectType: 'quote', subjectId: t.quoteId, parentRunId: parent.runId },
        {
          quoteId: t.quoteId,
          rfqId: t.rfqId,
          rfqTitle: t.rfqTitle,
          locale: st.locale,
          today: istDate(now),
          quote: t.quote,
          scope: t.scope,
          messages: t.messages.map((m) => ({ id: m.id, mine: m.mine, body: m.body })),
          ...(deps.stubReply ? { stub: deps.stubReply } : { stub: () => ({ body: 'Thank you for your message. I will confirm this and reply here shortly.', needs_provider_input: true, rationale: 'keyless stub' }) }),
          persist: async (p) => {
            const { data, error } = await deps.admin
              .from('munshi_drafts')
              .insert({ provider_id: st.provider_id, user_id: st.user_id, rfq_id: t.rfqId, quote_id: t.quoteId, kind: 'reply', run_id: p.runId, draft: p.draft, basis: [], status: 'proposed', stub: !!deps.stubReply, expires_at: new Date(now.getTime() + MUNSHI_DRAFT_TTL_HOURS * 3600 * 1000).toISOString() })
              .select('id')
              .single()
            if (error) throw new Error(`draft_persist_failed:${error.message}`)
            persistedId = (data as { id: string }).id
            return { draftId: persistedId }
          },
        },
      )
      if (child.status === 'awaiting_confirmation' && persistedId) {
        const { data: row } = await deps.admin.from('munshi_drafts').select('draft').eq('id', persistedId).maybeSingle()
        if (row) await deliverDraft(deps, st, { draftId: persistedId, runId: child.runId, kind: 'reply', draft: (row as any).draft, rfqTitle: t.rfqTitle })
        detail.replies++
        deps.capture?.(st.user_id, 'munshi_reply_proposed', { quote_id: t.quoteId, needs_provider_input: child.output.needsProviderInput })
      } else if (persistedId) {
        await deps.admin.from('munshi_drafts').update({ status: 'failed', result_ref: { error: child.status === 'failed' ? child.error : child.status }, updated_at: nowIso }).eq('id', persistedId).eq('status', 'proposed')
      }
    }
  }
  return { status: 'ok', detail }
}

async function notifyWebReminder(deps: MunshiRuntimeDeps, st: ProviderState, w: { rfqId: string; title: string; hoursLeft: number }): Promise<void> {
  if (!deps.runtimeSecret) return
  try {
    const cred = signRuntimeCredential(deps.runtimeSecret, { userId: st.user_id, persona: 'provider', runId: '00000000-0000-0000-0000-000000000000' })
    const f = deps.fetchImpl ?? fetch
    await f(`${deps.apiUrl}/api/v1/agent/munshi/reminders`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `AMC-Runtime ${cred}` }, body: JSON.stringify({ rfq_id: w.rfqId, hours_left: w.hoursLeft }) })
  } catch {
    /* best-effort */
  }
}

// ── the dispatcher branch (called from whatsapp/inbound.ts) ──────────────────

export interface MunshiInboundHooks {
  enqueueMunshiDecide?: (job: Omit<MunshiDecideJob, 'kind'>) => Promise<string | null>
}

/**
 * True when the message was routed to Munshi: a button `approve|edit|skip:<runId>`
 * whose run belongs to this conversation's user. Typed / spoken text is NOT taken
 * here any more (audit M42): `whatsapp/confirmations.ts` binds free text to at most
 * one open proposal across Munshi, procurement and support, and only a bound text
 * reaches `munshi.decide` with `textApproval: true`.
 */
export async function routeMunshiInbound(admin: SupabaseClient, args: { messageId: string; userId: string; row: { kind: string; body: string | null; payload: Record<string, unknown> | null } }, hooks: MunshiInboundHooks): Promise<boolean> {
  if (!hooks.enqueueMunshiDecide) return false
  const btn = parseMunshiButton(buttonPayloadOf(args.row))
  if (!btn) return false
  const { data } = await admin.from('munshi_drafts').select('id, user_id').eq('run_id', btn.runId).is('deleted_at', null).maybeSingle()
  if (!data || (data as { user_id: string }).user_id !== args.userId) return false
  await hooks.enqueueMunshiDecide({ runId: btn.runId, messageId: args.messageId, action: btn.action })
  return true
}

// ── S2.4 munshi.growth — the weekly informational nudge (fixed copy; no model, no confirm, no ai_decisions) ──────
//
// One run per provider (audited), at most one nudge per GROWTH_INTERVAL_DAYS. Facts: the provider's OWN listing gaps,
// state and categories read under the delegated token (GET /profile/me, a scripted GET); the category demand is an
// aggregate count of platform data (unmatched services requests from buyers in the provider's state, 30 days — no
// buyer identity leaves the query); the provider's own score row and events (derived platform data). WhatsApp only
// with the provider's WhatsApp grant (STOP halts it); disabling Munshi removes the provider from the enumeration.

const growthProfileSchema = z.object({ providerProfileGaps: z.array(z.string()).nullable().optional(), providerState: z.string().nullable().optional(), providerCategorySlugs: z.array(z.string()).nullable().optional() }).passthrough()

async function growthDemand(admin: SupabaseClient, state: string, since: string, cache: Map<string, Map<string, number>>): Promise<Map<string, number>> {
  const hit = cache.get(state)
  if (hit) return hit
  const counts = new Map<string, number>()
  const { data: rfqs } = await admin.from('rfqs').select('id, category:categories!inner(slug), msme:msme_profiles!inner(state)').eq('msme.state', state).gte('created_at', since).is('deleted_at', null).limit(2000)
  const rows = ((rfqs ?? []) as any[]).filter((r) => r.category?.slug)
  const matched = new Set<string>()
  for (let i = 0; i < rows.length; i += 200) {
    const ids = rows.slice(i, i + 200).map((r) => r.id as string)
    const { data: m } = await admin.from('rfq_matches').select('rfq_id').in('rfq_id', ids)
    for (const x of (m ?? []) as { rfq_id: string }[]) matched.add(x.rfq_id)
  }
  for (const r of rows) if (!matched.has(r.id)) counts.set(r.category.slug, (counts.get(r.category.slug) ?? 0) + 1)
  cache.set(state, counts)
  return counts
}

async function growthScoreFacts(admin: SupabaseClient, providerId: string, since: string): Promise<Pick<GrowthFacts, 'weakest' | 'rise'>> {
  const { data: snap } = await admin.from('provider_scores').select('components').eq('provider_id', providerId).eq('score_version', SCORE_VERSION).maybeSingle()
  let weakest: GrowthFacts['weakest'] = null
  if (snap) {
    const raw = ((snap as { components: Record<string, any> }).components ?? {}) as Record<string, any>
    const comps = Object.fromEntries(PROVIDER_COMPONENTS.map((k) => [k, { value: typeof raw[k]?.value === 'number' ? raw[k].value : null, sample: Number(raw[k]?.sample ?? 0), raw: {}, weight: Number(raw[k]?.weight ?? 0) } satisfies ComponentResult])) as Record<ProviderComponent, ComponentResult>
    const w = weakestComponents(comps, PROVIDER_COMPONENTS, 1)[0]
    if (w) weakest = { component: w, value: comps[w].value ?? 100 }
  }
  const { data: evs } = await admin.from('score_events').select('delta, reason').eq('subject_type', 'provider').eq('subject_id', providerId).eq('score_version', SCORE_VERSION).gte('created_at', since).neq('reason', 'gate')
  const list = ((evs ?? []) as { delta: number; reason: string }[]).filter((e) => (PROVIDER_COMPONENTS as readonly string[]).includes(e.reason))
  const total = list.reduce((a, e) => a + e.delta, 0)
  const top = [...list].sort((a, b) => b.delta - a.delta)[0]
  const rise = total > 0 && top && top.delta > 0 ? { component: top.reason as ProviderComponent, points: total } : null
  return { weakest, rise }
}

function growthAgent(deps: MunshiRuntimeDeps, st: ProviderState, since30: string, demandCache: Map<string, Map<string, number>>): AgentDefinition<Record<string, never>, { nudge: GrowthNudge | null }> {
  return {
    name: 'munshi',
    persona: 'provider',
    async run(run) {
      // the provider's own listing facts, under the delegated token (a scripted GET, logged on the run)
      const token = await deps.tokenFor({ runId: run.runId, userId: st.user_id })
      const f = deps.fetchImpl ?? fetch
      const res = await f(`${deps.apiUrl}/api/v1/profile/me`, { headers: { Authorization: `Bearer ${token}` } })
      await deps.core.ledger.appendEvent({ runId: run.runId, kind: 'tool_called', tool: null, actor: 'agent', payload: { path: '/api/v1/profile/me', status: res.status, purpose: 'growth_nudge' } })
      const me = growthProfileSchema.safeParse(res.ok ? await res.json().catch(() => null) : null)
      const gaps = (me.success ? me.data.providerProfileGaps ?? [] : []) as GrowthProfileField[]
      const state = me.success ? me.data.providerState ?? null : null
      const listed = new Set(me.success ? me.data.providerCategorySlugs ?? [] : [])
      const demand = state ? [...(await growthDemand(deps.admin, state, since30, demandCache)).entries()].filter(([slug]) => !listed.has(slug)).map(([category_slug, count]) => ({ category_slug, count })) : []
      const score = await growthScoreFacts(deps.admin, st.provider_id, since30)
      return { nudge: pickGrowthNudge({ profileGaps: gaps, demand, ...score }) }
    },
  }
}

async function notifyWebGrowth(deps: MunshiRuntimeDeps, st: ProviderState, nudge: GrowthNudge): Promise<boolean> {
  if (!deps.runtimeSecret) return false
  try {
    const cred = signRuntimeCredential(deps.runtimeSecret, { userId: st.user_id, persona: 'provider', runId: '00000000-0000-0000-0000-000000000000' })
    const f = deps.fetchImpl ?? fetch
    const res = await f(`${deps.apiUrl}/api/v1/agent/munshi/growth`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `AMC-Runtime ${cred}` }, body: JSON.stringify({ nudge }) })
    return res.ok
  } catch {
    return false
  }
}

export async function runMunshiGrowth(deps: MunshiRuntimeDeps): Promise<MunshiJobResult> {
  if (!deps.agentEnabled) return { status: 'failed', error: 'agent_disabled' }
  const g = await readAgentSettings(deps.admin, ['growth_nudge_enabled'])
  if (g.growth_nudge_enabled !== true) return { status: 'ok', detail: { providers: 0, sent: 0, skipped: 'growth_nudge_disabled' } }
  const s = await settings(deps.admin)
  const now = (deps.now ?? (() => new Date()))()
  const since30 = new Date(now.getTime() - 30 * 86400 * 1000).toISOString()
  const providers = await enabledProviders(deps, s)
  const { data: lastRows } = await deps.admin.from('munshi_provider_state').select('provider_id, last_growth_at').in('provider_id', providers.length ? providers.map((p) => p.provider_id) : ['00000000-0000-0000-0000-000000000000'])
  const last = new Map(((lastRows ?? []) as { provider_id: string; last_growth_at: string | null }[]).map((r) => [r.provider_id, r.last_growth_at]))
  const demandCache = new Map<string, Map<string, number>>()
  const detail = { providers: providers.length, sent: 0, whatsapp: 0, in_app: 0, recent: 0, nothing_to_say: 0, failed: 0, kinds: {} as Record<string, number> }
  for (const st of providers) {
    const prev = last.get(st.provider_id)
    if (prev && now.getTime() - new Date(prev).getTime() < GROWTH_INTERVAL_DAYS * 86400 * 1000) { detail.recent++; continue }
    const r = await runAgent(growthAgent(deps, st, since30, demandCache), depsFor(deps, st.scopes), { userId: st.user_id, surface: 'system', subjectType: 'provider', subjectId: st.provider_id, meta: { job: 'growth' } }, {})
    if (r.status !== 'completed') { detail.failed++; continue }
    const nudge = r.output.nudge
    if (!nudge) { detail.nothing_to_say++; continue }
    let categoryName: string | null = null
    if (nudge.kind === 'category_demand') {
      const { data: cat } = await deps.admin.from('categories').select('name_i18n').eq('slug', nudge.category_slug).maybeSingle()
      categoryName = cat ? pickLocale((cat as { name_i18n: { en: string; hi?: string; te?: string } }).name_i18n, st.locale) : null
    }
    const line = growthNudgeLine(nudge, st.locale, categoryName)
    const wa = await sendToProvider(deps, st, line, { kind: 'munshi_growth', params: [line] }, { growth: nudge.kind, run_id: r.runId })
    const inApp = await notifyWebGrowth(deps, st, nudge)
    await bumpState(deps.admin, st, { last_growth_at: now.toISOString() })
    detail.sent++
    if (wa) detail.whatsapp++
    if (inApp) detail.in_app++
    detail.kinds[nudge.kind] = (detail.kinds[nudge.kind] ?? 0) + 1
    deps.capture?.(st.user_id, 'munshi_growth_sent', { kind: nudge.kind, whatsapp: !!wa, in_app: inApp })
  }
  return { status: 'ok', detail }
}
