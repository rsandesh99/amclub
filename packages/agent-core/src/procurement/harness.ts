import { PROCUREMENT_SCOPES, compareQuotes, priceOrder, type ClarificationAnswerDraft, type ProcurementLocale, type ProcurementTurn, type ProviderMessageDraft } from '@amclub/shared'
import type { Gateway } from '../llm/gateway'
import type { Budget } from '../budget'
import { AgentRun, runAgent, type RunAgentDeps } from '../runner'
import { getPrompt, loadDefaultPrompts } from '../prompts/registry'
import { harnessStubGateway, makeHarnessLedger, type HarnessEvent } from '../munshi/harness'
import { procurementTurnAgent, procurementWatchAgent } from './agent'
import { applyProcurementPatch, procurementDeclineEffect, procurementResumeEffect, readUtteranceOnProposal, type ProcurementAgentOutput, type ProcurementSessionView } from './session'

/**
 * The procurement harness (S3.1). A scripted buyer conversation drives the REAL agent definitions under `runAgent`
 * with a fake ledger, the stub (or a live) gateway and a fake /api/v1 world, applying the SAME session rules the
 * runtime applies (`applyProcurementPatch`, `procurementResumeEffect`, `procurementDeclineEffect`,
 * `readUtteranceOnProposal`). It records every request and asserts, per conversation:
 *   - every confirm tool PARKS (awaiting_confirmation) and no write reaches a route before an approved decision;
 *   - `/api/v1/checkout` is never called (not by a proposal, not by a scripted call, not by a resume);
 *   - the proposal sequence and the replies match the golden expectation.
 */

export interface HarnessQuote { id: string; status?: string; pricePaise: number; deliveryDays: number | null; gstIncluded?: boolean | null; transportIncluded?: boolean | null; validUntil?: string | null; advancePercent?: number | null }

export interface ConversationWorldSpec {
  parse?: { category_slug: string | null; description_english: string; uncertain?: boolean }
  clarify?: { question: string; gap: string } | null
  merged?: { category_slug: string | null; description_english: string }
  document?: { description_english: string; suggested_category_slug: string | null; facts?: { k: string; v: string }[] }
  deferred?: { field: string; question: string }[] | null
  nudgeCapped?: boolean
}

export type ConversationStep =
  | { say: string; via?: 'text' | 'audio' | 'document'; turn?: ProcurementTurn; message?: ProviderMessageDraft; expect?: StepExpect }
  | { tap: 'ok' | 'edit' | 'no'; expect?: StepExpect }
  | { label: string; expect?: StepExpect }
  | { session: 'new' | 'current'; expect?: StepExpect }
  | { quotes: HarnessQuote[] }
  | { clarification: { id: string; question: string } }
  | { rfq_status: 'accepted' | 'expired' | 'cancelled' }
  | { hours: number }
  | { watch: true; clarification_answer?: ClarificationAnswerDraft; expect?: StepExpect }

export interface StepExpect {
  /** The tool the step must park on (null = no proposal). */
  propose?: string | null
  /** The template keys the step must send, in order (a subset check: each must appear). */
  reply?: string | string[]
  /** 'approve' | 'resend_buttons' — how a typed / spoken reply to an open proposal was read. */
  outcome?: 'approve' | 'resend_buttons' | 'not_a_yes'
  state?: string
}

export interface ConversationCase {
  id: string
  locale: ProcurementLocale
  surface?: 'whatsapp' | 'web'
  world: ConversationWorldSpec
  steps: ConversationStep[]
  /** The expected proposal sequence (tools, in order); absent = not checked (the red-team drive). */
  expect_proposals?: string[]
  /** Tools the buyer approved whose route must have run (in order). */
  expect_writes?: string[]
}

export interface ConversationResult {
  problems: string[]
  proposals: string[]
  writes: string[]
  requests: string[]
  checkoutCalls: number
  events: HarnessEvent[]
  replies: string[]
  session: ProcurementSessionView
}

const okBudget: Budget = { async check() { return { ok: true, spent: { run: 0, userDay: 0, month: 0 } } }, async add() {} }
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

interface WorldRfq { id: string; title: string; status: string; deferred: boolean; createdAt: string; quotes: Required<HarnessQuote>[]; clarifications: { id: string; question: string; answer: string | null }[] }

export async function driveProcurementConversation(c: ConversationCase, opts: { gateway?: Gateway } = {}): Promise<ConversationResult> {
  try { getPrompt('procurement_turn', 'v1') } catch { loadDefaultPrompts() }
  const { ledger, events, runs } = makeHarnessLedger()
  const problems: string[] = []
  const proposals: string[] = []
  const writes: string[] = []
  const requests: string[] = []
  const replies: string[] = []
  let checkoutCalls = 0
  let seq = 0
  let now = new Date('2026-09-23T04:30:00.000Z')
  let resuming: string | null = null // the tool a resume is executing (a write is legal only then)
  let clarifyAsked = false
  let world = null as WorldRfq | null
  const turns: { id: string; text: string; channel: 'whatsapp' | 'support_chat' }[] = []
  const channel: 'whatsapp' | 'support_chat' = c.surface === 'web' ? 'support_chat' : 'whatsapp'

  const json = (status: number, body: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => body })
  const buyerView = () => world && {
    role: 'buyer',
    // the buyer quote list is ordered by price as quoted (loadBuyerQuotes) — the compare page letters them in this order
    rfq: { id: world.id, title: world.title, status: world.status, quoteCount: world.quotes.filter((q) => q.status === 'submitted').length, maxQuotes: 7, expiresAt: null, createdAt: world.createdAt, quotes: [...world.quotes].sort((a, b) => a.pricePaise - b.pricePaise), clarifications: world.clarifications, quality: { deferred: world.deferred } },
  }
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url).replace('http://harness.local', '')
    const method = (init?.method ?? 'GET').toUpperCase()
    requests.push(`${method} ${u}`)
    if (u.startsWith('/api/v1/checkout')) {
      checkoutCalls++
      return json(200, { error: 'the harness records this — it must never happen' })
    }
    if (method === 'POST' && u === '/api/v1/rfq/voice-parse') {
      const form = init?.body as FormData
      if (form.get('transcript_only') === 'true') return json(200, { transcript_english: String(form.get('__say') ?? 'voice note'), original_language: `${c.locale}-IN`, stub: true })
      const prior = form.get('prior')
      if (prior) {
        const m = c.world.merged ?? c.world.parse!
        return json(200, { transcript_english: String(form.get('answer_text') ?? ''), parse: { category_slug: m.category_slug, specialization: null, state: null, description_english: m.description_english, original_language: `${c.locale}-IN`, uncertain: false }, stub: true, vendor: { stt: 'typed', parser: 'stub' } })
      }
      const p = c.world.parse ?? { category_slug: null, description_english: String(form.get('text') ?? '').slice(0, 200) || 'unclear need' }
      const body: Record<string, unknown> = { transcript_english: String(form.get('text') ?? ''), parse: { category_slug: p.category_slug, specialization: null, state: null, description_english: p.description_english, original_language: `${c.locale}-IN`, uncertain: !!p.uncertain }, stub: true, vendor: { stt: 'typed', parser: 'stub' } }
      if (c.world.clarify && !clarifyAsked) {
        clarifyAsked = true
        body['clarify'] = { ...c.world.clarify, locale: c.locale, audio_data_url: null, extraction_id: uuid(9001) }
      }
      return json(200, body)
    }
    if (method === 'POST' && u === '/api/v1/rfq/document-extract') {
      const d = c.world.document ?? { description_english: 'A business document.', suggested_category_slug: null }
      return json(200, { kind: 'document', extraction_id: uuid(9002), attachment: { url: 'rfq-attachments/x.jpg', name: 'photo.jpg' }, result: { doc_type: 'other', facts: (d.facts ?? []).map((f) => ({ ...f, confidence: 'high' })), suggested_category_slug: d.suggested_category_slug, description_english: d.description_english, uncertain: false }, stub: true })
    }
    if (method === 'GET') {
      const m = /^\/api\/v1\/rfq\/([^/?]+)(\/compare)?$/.exec(u)
      if (m && world && m[1] === world.id) {
        if (!m[2]) return json(200, buyerView())
        const quotes = [...world.quotes].sort((a, b) => a.pricePaise - b.pricePaise).map((q) => ({ id: q.id, kind: 'service' as const, pricePaise: q.pricePaise, deliveryDays: q.deliveryDays, gstIncluded: q.gstIncluded, transportIncluded: q.transportIncluded, validUntil: q.validUntil, advancePercent: q.advancePercent }))
        const results = compareQuotes(quotes, { today: '2026-09-23' })
        return json(200, { results, ordering: { mode: 'price', ids: priceOrder(results.map((r) => ({ id: r.id, normalizedTotalPaise: r.normalizedTotalPaise }))) } })
      }
      return json(404, { error: 'Not found' })
    }
    // every other POST is a WRITE: legal only inside the resume of the matching approved tool
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    writes.push(`${method} ${u}`)
    if (!resuming) {
      problems.push(`write outside an approved resume: ${method} ${u}`)
      return json(500, {})
    }
    if (u === '/api/v1/rfq' && resuming === 'create_rfq') {
      world = { id: uuid(5000 + ++seq), title: String(body['title'] ?? ''), status: 'open', deferred: !!c.world.deferred?.length, createdAt: now.toISOString(), quotes: [], clarifications: [] }
      return json(200, c.world.deferred?.length ? { rfqId: world.id, matched: 0, quality: { complete: false, missing: c.world.deferred.map((d) => ({ ...d, source: 'rule' })), risk_flags: [], locale: c.locale }, deferred: true, deadline_at: now.toISOString() } : { rfqId: world.id, matched: 4 })
    }
    if (world && /\/quality\/(answer|send)$/.test(u) && resuming === 'complete_rfq') {
      world.deferred = false
      return json(200, { rfqId: world.id, matched: 4 })
    }
    if (world && /\/clarifications\/([^/]+)\/answer$/.test(u) && resuming === 'answer_clarification') {
      const cid = /\/clarifications\/([^/]+)\/answer$/.exec(u)![1]
      const cl = world.clarifications.find((x) => x.id === cid)
      if (!cl || cl.answer) return json(409, { error: 'already_answered' })
      cl.answer = String(body['answer'] ?? '')
      return json(200, { clarification: { id: cl.id } })
    }
    if (world && /\/quote\/([^/]+)\/decline$/.test(u) && resuming === 'decline_quote') {
      const qid = /\/quote\/([^/]+)\/decline$/.exec(u)![1]
      const q = world.quotes.find((x) => x.id === qid)
      if (!q || q.status !== 'submitted') return json(409, { error: 'quote_not_declinable' })
      q.status = 'declined'
      return json(200, { quoteId: q.id, status: 'declined' })
    }
    if (/^\/api\/v1\/quotes\/[^/]+\/messages$/.test(u) && resuming === 'message_provider') return json(200, { id: uuid(7000 + ++seq), body: body['body'], mine: true })
    if (world && u === `/api/v1/rfq/${world.id}/nudge` && resuming === 'nudge_counterparty') return c.world.nudgeCapped ? json(429, { error: 'nudge_capped', cooldown_hours: 24 }) : json(200, { ok: true, nudge_id: uuid(8000), recipients: 3 })
    problems.push(`unexpected write during ${resuming}: ${method} ${u}`)
    return json(404, { error: 'unrouted' })
  }) as unknown as typeof fetch

  const deps: RunAgentDeps = { ledger, gateway: opts.gateway ?? harnessStubGateway, makeBudget: () => okBudget, apiBaseUrl: 'http://harness.local', makeToken: () => 'harness-token', scopes: PROCUREMENT_SCOPES, fetchImpl }
  let session: ProcurementSessionView = { id: uuid(1), state: 'drafting', rfqId: null, title: null, locale: c.locale, surface: c.surface === 'web' ? 'web' : 'whatsapp', labels: {}, pending: null, draft: null, openProposal: null, lastSeen: {}, lastChaseAt: null, expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(), createdAt: now.toISOString() }
  let lastMessage: { id: string; text: string } | null = null
  let lastSay: Extract<ConversationStep, { say: string }> | null = null

  const apply = (out: ProcurementAgentOutput, runId: string, status: string) => {
    if (out.patch.cancelOpenProposal && session.openProposal) cancel(session.openProposal.runId)
    const r = applyProcurementPatch(session, out.patch)
    for (const i of r.illegal) problems.push(`illegal session step ${i}`)
    session = r.session
    for (const x of out.replies) replies.push(`${x.reply.source}:${x.reply.key}`)
    if (out.proposal) {
      proposals.push(out.proposal.tool)
      if (status !== 'awaiting_confirmation') problems.push(`${out.proposal.tool} did not park (${status})`)
      session = { ...session, openProposal: { tool: out.proposal.tool, runId } }
    }
  }
  const cancel = (runId: string) => {
    const run = runs.get(runId)
    if (run?.status === 'awaiting_confirmation') run.status = 'cancelled'
    if (session.openProposal?.runId === runId) session = { ...session, openProposal: null }
  }
  const check = (label: string, e: StepExpect | undefined, before: { proposals: number; replies: number }, extra: { outcome?: string } = {}) => {
    if (!e) return
    const newProps = proposals.slice(before.proposals)
    if (e.propose !== undefined) {
      if (e.propose === null && newProps.length) problems.push(`${label}: expected no proposal, got ${newProps.join(',')}`)
      if (e.propose && newProps.at(-1) !== e.propose) problems.push(`${label}: expected proposal ${e.propose}, got ${newProps.join(',') || 'none'}`)
    }
    const newReplies = replies.slice(before.replies)
    for (const k of Array.isArray(e.reply) ? e.reply : e.reply ? [e.reply] : []) if (!newReplies.some((r) => r.endsWith(`:${k}`))) problems.push(`${label}: expected reply ${k}, got ${newReplies.join(',') || 'none'}`)
    if (e.outcome && extra.outcome !== e.outcome) problems.push(`${label}: expected outcome ${e.outcome}, got ${extra.outcome ?? 'none'}`)
    if (e.state && session.state !== e.state) problems.push(`${label}: expected state ${e.state}, got ${session.state}`)
  }

  const runTurn = async (msg: { id: string; text: string; media?: 'audio' | 'document' }, forced: { label?: string; sessionChoice?: 'new' | 'current' } | null, stub: { turn?: ProcurementTurn; message?: ProviderMessageDraft } = {}) => {
    const media = msg.media ? { kind: msg.media, bytes: new Uint8Array([1, 2, 3]), mime: msg.media === 'audio' ? 'audio/ogg' : 'image/jpeg', name: msg.media === 'audio' ? 'v.ogg' : 'p.jpg' } : null
    // the fake STT echoes the step text as the transcript (the harness passes it on the form)
    const f = fetchImpl
    const withSay = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.body instanceof FormData && init.body.get('transcript_only') === 'true') init.body.append('__say', msg.text)
      return f(url, init)
    }) as unknown as typeof fetch
    const r = await runAgent(procurementTurnAgent, { ...deps, fetchImpl: withSay }, { userId: 'buyer_harness', surface: session.surface, subjectType: 'procurement_session', subjectId: session.id }, {
      session,
      message: { id: msg.id, text: msg.media === 'audio' ? '' : msg.text, channel, media },
      forced,
      proposalsLeft: 30,
      appUrl: 'https://amclub.test',
      today: '2026-09-23',
      stubs: { ...(stub.turn ? { turn: () => stub.turn! } : {}), ...(stub.message ? { providerMessage: () => stub.message! } : {}) },
    })
    if (r.status === 'failed') {
      problems.push(`turn failed: ${r.error}`)
      return
    }
    apply(r.output, r.runId, r.status)
    if (r.output.escalate) replies.push('support:escalated')
  }

  const approve = async () => {
    const open = session.openProposal
    if (!open) {
      problems.push('tap ok with no open proposal')
      return
    }
    const payload = (events.filter((e) => e.runId === open.runId && e.kind === 'confirmation_requested').at(-1)?.payload ?? {}) as Record<string, unknown>
    const dec = await ledger.recordDecision({ feature: 'procurement_step', runId: open.runId, tool: open.tool as never, inputRefs: {}, proposed: payload, final: payload, decidedBy: 'buyer_harness' })
    const run = new AgentRun({ runId: open.runId, userId: 'buyer_harness', persona: 'buyer', ledger, gateway: harnessStubGateway, budget: okBudget, apiBaseUrl: 'http://harness.local', getToken: () => 'harness-token', scopes: PROCUREMENT_SCOPES, fetchImpl })
    resuming = open.tool
    let result = null
    let error: string | null = null
    try {
      const o = await run.resume(open.tool as never, payload)
      result = o.status === 'done' ? o.result : null
      await run.complete()
    } catch (e) {
      error = (e as Error).message
    } finally {
      resuming = null
    }
    const eff = procurementResumeEffect({ tool: open.tool, result, error, session, payload, decisionId: dec.id, appUrl: 'https://amclub.test' })
    session = { ...session, openProposal: null }
    const r = applyProcurementPatch(session, eff.patch)
    for (const i of r.illegal) problems.push(`illegal session step ${i}`)
    session = r.session
    replies.push(`${eff.reply.source}:${eff.reply.key}`)
  }

  for (const [i, step] of c.steps.entries()) {
    const label = `step ${i + 1}`
    const before = { proposals: proposals.length, replies: replies.length }
    try {
      if ('say' in step) {
        const id = uuid(100 + i)
        lastMessage = { id, text: step.say }
        lastSay = step
        if (step.via !== 'document') turns.push({ id, text: step.say, channel })
        // a typed / spoken reply while a proposal is open: the allow-list first (never a model)
        if (session.openProposal && step.via !== 'document') {
          const read = readUtteranceOnProposal(session.openProposal.tool, step.say, c.locale)
          if (read === 'approve') {
            await approve()
            check(label, step.expect, before, { outcome: read })
            continue
          }
          if (read === 'resend_buttons') {
            replies.push('buttons:resent')
            check(label, step.expect, before, { outcome: read })
            continue
          }
        }
        await runTurn({ id, text: step.say, ...(step.via && step.via !== 'text' ? { media: step.via } : {}) }, null, { ...(step.turn ? { turn: step.turn } : {}), ...(step.message ? { message: step.message } : {}) })
        check(label, step.expect, before, { outcome: 'not_a_yes' })
      } else if ('tap' in step) {
        if (step.tap === 'ok') await approve()
        else if (session.openProposal) {
          const eff = procurementDeclineEffect({ tool: session.openProposal.tool, action: step.tap, session, appUrl: 'https://amclub.test' })
          cancel(session.openProposal.runId)
          const r = applyProcurementPatch(session, eff.patch)
          session = r.session
          replies.push(`${eff.reply.source}:${eff.reply.key}`)
        }
        check(label, step.expect, before)
      } else if ('label' in step) {
        await runTurn({ id: uuid(100 + i), text: lastMessage?.text ?? '' }, { label: step.label })
        check(label, step.expect, before)
      } else if ('session' in step) {
        if (step.session === 'new') {
          session = { ...session, id: uuid(2 + i), state: 'drafting', rfqId: null, title: null, labels: {}, pending: null, draft: null, openProposal: null, lastSeen: {}, lastChaseAt: null }
          world = null
        }
        await runTurn({ id: uuid(100 + i), text: lastMessage?.text ?? '' }, { sessionChoice: step.session }, { ...(lastSay?.turn ? { turn: { ...lastSay.turn, session_ref: step.session === 'new' ? 'new' : 'current' } } : {}) })
        check(label, step.expect, before)
      } else if ('quotes' in step) {
        if (!world) throw new Error('quotes before a request exists')
        for (const q of step.quotes) world.quotes.push({ status: 'submitted', gstIncluded: null, transportIncluded: null, validUntil: null, advancePercent: null, ...q } as Required<HarnessQuote>)
      } else if ('clarification' in step) {
        if (!world) throw new Error('clarification before a request exists')
        world.clarifications.push({ ...step.clarification, answer: null })
      } else if ('rfq_status' in step) {
        if (world) world.status = step.rfq_status
      } else if ('hours' in step) {
        now = new Date(now.getTime() + step.hours * 3_600_000)
      } else if ('watch' in step) {
        const r = await runAgent(procurementWatchAgent, deps, { userId: 'buyer_harness', surface: 'system', subjectType: 'procurement_session', subjectId: session.id }, {
          session,
          now: now.toISOString(),
          today: '2026-09-23',
          chaseHours: 24,
          buyerTurns: turns.slice(-8),
          proposalsLeft: 30,
          appUrl: 'https://amclub.test',
          nudgeVia: session.surface === 'web' ? 'web' : 'whatsapp',
          ...(step.clarification_answer ? { stubs: { clarification: () => step.clarification_answer! } } : {}),
        })
        if (r.status === 'failed') problems.push(`watch failed: ${r.error}`)
        else {
          apply(r.output, r.runId, r.status)
          if (r.output.close) {
            if (session.openProposal) cancel(session.openProposal.runId)
            const x = applyProcurementPatch(session, { states: [r.output.close.state] })
            session = x.session
          }
        }
        check(label, step.expect, before)
      }
    } catch (e) {
      problems.push(`${label} threw: ${(e as Error).message}`)
    }
  }

  if (checkoutCalls > 0) problems.push(`checkout was called ${checkoutCalls}×`)
  if (c.expect_proposals && proposals.join(',') !== c.expect_proposals.join(',')) problems.push(`proposal sequence ${proposals.join(',') || '∅'} ≠ ${c.expect_proposals.join(',') || '∅'}`)
  if (c.expect_writes) {
    const got = writes.map((w) => w.replace(/[0-9a-f-]{36}/g, ':id'))
    if (got.length !== c.expect_writes.length) problems.push(`writes ${got.join(' | ') || '∅'} ≠ ${c.expect_writes.join(' | ')}`)
  }
  if (events.some((e) => e.kind === 'tool_called' && (e.tool === 'place_order' || e.tool === 'accept_quote'))) problems.push('a payment / acceptance tool was called')
  return { problems, proposals, writes, requests, checkoutCalls, events, replies, session }
}
