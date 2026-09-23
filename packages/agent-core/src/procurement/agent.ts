import { z } from 'zod'
import {
  CATEGORY_LIST,
  PROCUREMENT_DECLINE_REASON_LABELS,
  acceptClarificationDraft,
  clampProviderMessage,
  compareLabel,
  labelMentioned,
  procurementDeclineReason,
  quoteSetKey,
  resolveSupportReply,
  summariseQuotesForChat,
  voiceParseSchema,
  type ClarificationAnswerDraft,
  type CompareQuoteResult,
  type ProcurementLocale,
  type ProcurementSessionState,
  type ProcurementTurn,
  type ProviderMessageDraft,
  type SupportRfqView,
  type VoiceParse,
} from '@amclub/shared'
import type { AgentDefinition, AgentRun } from '../runner'
import { getPrompt } from '../prompts/registry'
import { procurementTurnSchema } from '../prompts/procurement_turn/schema'
import { clarificationAnswerDraftSchema } from '../prompts/clarification_answer/schema'
import { providerMessageDraftSchema } from '../prompts/provider_message/schema'
import { buildClarificationAnswerParts, buildProcurementTurnParts, buildProviderMessageParts, type ProcurementChannel } from './parts'
import { stubClarificationAnswer, stubProcurementTurn, stubProviderMessage } from './stub'
import {
  emptyOutput,
  priceSlot,
  waitingFor,
  type ProcurementAgentOutput,
  type ProcurementDocIntake,
  type ProcurementDraftState,
  type ProcurementPending,
  type ProcurementReply,
  type ProcurementSessionView,
} from './session'

/**
 * The Buyer Procurement Agent (S3.1; A2, built dark). Two definitions, one run each:
 *
 *   procurementTurnAgent — ONE buyer message (WhatsApp or the web mirror). The model only ROUTES it
 *     (`procurement_turn@v1`, no reply field); code then drafts the request through the S1.8 routes (scripted,
 *     prefill only), or proposes ONE confirm:true tool and the run parks until the buyer taps.
 *   procurementWatchAgent — one tick for one active session: reads the request under the buyer's token, summarises a
 *     new quote set (pure code), drafts / relays a provider question, offers the chase nudge, or closes.
 *
 * Laws enforced HERE, never by a prompt:
 *   - the agent proposes only buyer tools; money-adjacent ones are button-only (the runtime / web enforce the tap);
 *   - checkout is unreachable: `choose_quote` is a LOCAL gate (its effect is a link), `place_order` / `accept_quote`
 *     are not in the grant, and `scriptedCall` refuses every money route;
 *   - no negotiation: the buyer's words AND the drafted message both pass `clampProviderMessage` before a proposal;
 *   - "go with B" becomes a proposal only when the letter is literally in the buyer's words (`labelMentioned`) or the
 *     buyer tapped a label button — a description ("the fast one") gets the label buttons instead;
 *   - one open proposal per session; the daily proposal cap is checked before every proposal.
 */

// ── inputs / outputs ─────────────────────────────────────────────────────────

export interface ProcurementMedia {
  kind: 'audio' | 'document'
  bytes: Uint8Array
  mime: string
  name: string
}

export interface ProcurementTurnInput {
  session: ProcurementSessionView
  message: { id: string; text: string; channel: ProcurementChannel; media?: ProcurementMedia | null }
  /** A label button (pr:label:…) or the session choice (pr:sess:…) — the buyer's tap, not a model reading. */
  forced?: { label?: string; sessionChoice?: 'new' | 'current' } | null
  proposalsLeft: number
  appUrl: string
  today: string
  stubs?: {
    turn?: (text: string) => ProcurementTurn
    providerMessage?: (text: string) => ProviderMessageDraft
  }
}

export interface ProcurementWatchInput {
  session: ProcurementSessionView
  now: string
  today: string
  chaseHours: number
  /** The buyer's own earlier turns (oldest first) — the only basis a drafted clarification answer may have. */
  buyerTurns: readonly { id: string; text: string; channel: ProcurementChannel }[]
  proposalsLeft: number
  appUrl: string
  nudgeVia: 'whatsapp' | 'web' | 'mobile'
  stubs?: { clarification?: (question: string, turns: readonly { id: string; text: string }[]) => ClarificationAnswerDraft }
}

// ── the reads (scripted, under the buyer's token) ───────────────────────────

const buyerQuoteSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    pricePaise: z.number(),
    deliveryDays: z.number().nullable().optional(),
    gstIncluded: z.boolean().nullable().optional(),
    transportIncluded: z.boolean().nullable().optional(),
    validUntil: z.string().nullable().optional(),
    advancePercent: z.number().nullable().optional(),
  })
  .passthrough()
const buyerRfqSchema = z.object({
  role: z.literal('buyer'),
  rfq: z
    .object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      quoteCount: z.number(),
      maxQuotes: z.number(),
      expiresAt: z.string().nullable().optional(),
      createdAt: z.string(),
      quotes: z.array(buyerQuoteSchema),
      clarifications: z.array(z.object({ id: z.string(), question: z.string(), answer: z.string().nullable().optional() }).passthrough()).optional(),
      quality: z.object({ deferred: z.boolean() }).passthrough().optional(),
    })
    .passthrough(),
})
export type BuyerRfqView = z.infer<typeof buyerRfqSchema>['rfq']

const compareResponseSchema = z.object({
  results: z.array(z.object({ id: z.string(), normalizedTotalPaise: z.number(), normalizationNotes: z.array(z.unknown()), flags: z.array(z.string()) }).passthrough()),
  ordering: z.object({ mode: z.string(), ids: z.array(z.string()) }).passthrough().nullable().optional(),
})

async function readRfq(run: AgentRun, rfqId: string): Promise<BuyerRfqView | null> {
  const r = await run.scriptedCall('compare_quotes', { method: 'GET', path: `/api/v1/rfq/${rfqId}` })
  if (!r.ok) return null
  const p = buyerRfqSchema.safeParse(r.body)
  return p.success ? p.data.rfq : null
}

/** quote id → the compare page's letter (its position in the buyer's quote list). */
export function labelsFor(rfq: BuyerRfqView): Record<string, string> {
  const out: Record<string, string> = {}
  rfq.quotes.forEach((q, i) => (out[q.id] = compareLabel(i)))
  return out
}

const liveQuotes = (rfq: BuyerRfqView) => rfq.quotes.filter((q) => q.status === 'submitted')

// ── the S1.8 draft pipeline (prefill routes, scripted; nothing is created here) ─

const parseResponseSchema = z.object({
  transcript_english: z.string(),
  parse: voiceParseSchema,
  stub: z.boolean().optional(),
  vendor: z.object({ stt: z.string(), parser: z.string() }).partial().optional(),
  clarify: z.object({ question: z.string(), gap: z.string(), locale: z.string(), extraction_id: z.string() }).passthrough().optional(),
})
const sttResponseSchema = z.object({ transcript_english: z.string(), original_language: z.string().optional(), stub: z.boolean().optional() })
const documentResponseSchema = z.object({
  kind: z.enum(['document', 'drawing']),
  extraction_id: z.string(),
  attachment: z.object({ url: z.string(), name: z.string() }),
  result: z.object({ description_english: z.string().optional(), summary_english: z.string().optional(), suggested_category_slug: z.string().nullable().optional(), facts: z.array(z.object({ k: z.string(), v: z.string() }).passthrough()).optional(), spec_rows: z.array(z.object({ k: z.string(), v: z.string() })).optional() }).passthrough(),
})

const LANG: Record<ProcurementLocale, string> = { en: 'en-IN', hi: 'hi-IN', te: 'te-IN', ta: 'ta-IN' }
const CATEGORY_SLUGS_SET = new Set(CATEGORY_LIST.map((c) => c.slug as string))

function categoryName(slug: string | null | undefined): string {
  const c = CATEGORY_LIST.find((x) => x.slug === slug)
  return c ? c.name_i18n.en : '—'
}

async function transcribe(run: AgentRun, media: ProcurementMedia): Promise<{ text: string; language: string; stub: boolean } | null> {
  const form = new FormData()
  form.append('audio', new Blob([media.bytes as unknown as ArrayBuffer], { type: media.mime }), media.name)
  form.append('duration_ms', '20000') // WhatsApp reports no length; the route's byte cap backstops it (the S1.6 note)
  form.append('transcript_only', 'true')
  const r = await run.scriptedCall('draft_rfq', { method: 'POST', path: '/api/v1/rfq/voice-parse', form })
  const p = sttResponseSchema.safeParse(r.body)
  return r.ok && p.success ? { text: p.data.transcript_english, language: p.data.original_language ?? 'unknown', stub: p.data.stub === true } : null
}

async function extractDocument(run: AgentRun, media: ProcurementMedia): Promise<ProcurementDocIntake | null> {
  const form = new FormData()
  form.append('file', new Blob([media.bytes as unknown as ArrayBuffer], { type: media.mime }), media.name)
  form.append('mode', 'service')
  const r = await run.scriptedCall('extract_document', { method: 'POST', path: '/api/v1/rfq/document-extract', form })
  const p = documentResponseSchema.safeParse(r.body)
  if (!r.ok || !p.success) return null
  const res = p.data.result
  const facts = [...(res.facts ?? []), ...(res.spec_rows ?? [])].map((f) => `${f.k}: ${f.v}`).slice(0, 12)
  const slug = res.suggested_category_slug ?? null
  return { extraction_id: p.data.extraction_id, attachment: p.data.attachment, description: (res.description_english ?? res.summary_english ?? '').trim(), suggested_category_slug: slug && CATEGORY_SLUGS_SET.has(slug) ? slug : null, facts }
}

async function parseNeed(run: AgentRun, args: { text: string; language: string; prior?: Extract<ProcurementPending, { kind: 'clarify' }> | null }): Promise<z.infer<typeof parseResponseSchema> | null> {
  const form = new FormData()
  if (args.prior) {
    form.append('prior', JSON.stringify({ transcript_english: args.prior.transcript_english, parse: args.prior.parse, question: { question: args.prior.question, gap: args.prior.gap, locale: args.prior.qlocale } }))
    form.append('answer_text', args.text.slice(0, 1000))
  } else {
    form.append('text', args.text.slice(0, 1000))
    form.append('language_code', args.language)
  }
  const r = await run.scriptedCall('draft_rfq', { method: 'POST', path: '/api/v1/rfq/voice-parse', form })
  const p = parseResponseSchema.safeParse(r.body)
  return r.ok && p.success ? p.data : null
}

function titleFrom(description: string): string {
  const first = description.split(/(?<=[.!?।])\s+/)[0] ?? description
  const t = (first.length >= 10 ? first : description).trim().slice(0, 120)
  return t.length >= 10 ? t : `${t} — service request`.slice(0, 120)
}

export function rfqCreateBody(args: {
  categorySlug: string
  description: string
  via: 'audio' | 'text' | 'document'
  parse: VoiceParse | null
  transcript: string | null
  sttStub?: boolean
  parser?: string | null
  clarified: ProcurementDraftState['clarified']
  docs: readonly ProcurementDocIntake[]
}): Record<string, unknown> {
  const facts = args.docs.flatMap((d) => d.facts)
  const details: Record<string, unknown> = { additional_details: args.description.slice(0, 2000) }
  if (facts.length) details['document_facts'] = facts.join(' · ').slice(0, 2000)
  const intake = [...args.docs.map((d) => d.extraction_id), ...(args.clarified ? [args.clarified.extraction_id] : [])].slice(0, 4)
  const body: Record<string, unknown> = {
    kind: 'service',
    category_slug: args.categorySlug,
    title: titleFrom(args.description),
    details,
    attachments: args.docs.map((d) => d.attachment).slice(0, 5),
    intake_extraction_ids: intake,
  }
  if (args.via === 'audio' && args.parse && args.transcript) {
    body['voice_meta'] = {
      transcript_english: args.transcript.slice(0, 4000),
      parse: args.parse,
      duration_ms: 20000,
      edited_fields: [],
      vendor: { stt: args.sttStub ? 'stub' : 'sarvam', parser: (args.parser ?? 'agent').slice(0, 80) },
      ...(args.clarified ? { clarify: { question: args.clarified.question.slice(0, 200), gap: args.clarified.gap.slice(0, 60), answer_transcript: args.clarified.answer.slice(0, 2000), answered_by: args.clarified.via === 'audio' ? 'voice' : 'text' } } : {}),
    }
  }
  return body
}

function draftSummary(payload: Record<string, unknown>): string {
  const lines = [`• ${String(payload['title'] ?? '')}`, `• ${categoryName(String(payload['category_slug'] ?? ''))}`]
  const d = String((payload['details'] as Record<string, unknown> | undefined)?.['additional_details'] ?? '')
  if (d && d !== payload['title']) lines.push(`• ${d.slice(0, 240)}`)
  const att = (payload['attachments'] as unknown[] | undefined)?.length ?? 0
  if (att) lines.push(`• ${att} 📎`)
  return lines.join('\n')
}

const P = (key: Extract<ProcurementReply, { source: 'procurement' }>['key'], slots: Record<string, string | number> = {}): ProcurementReply => ({ source: 'procurement', key, slots })
const rfqLink = (appUrl: string, rfqId: string | null) => (rfqId ? `${appUrl}/app/rfq/${rfqId}` : `${appUrl}/app/rfq/new`)
const SEND_AS_IS = /^(send( it)? as( it)? is|send now|just send|jaisa hai (waisa )?bhej(o| do)|जैसा है वैसा भेज(ो| दो)|ఉన్నది ఉన్నట్టు పంపు|இருப்பதை அப்படியே அனுப்பு)[\s.!]*$/i

// ── the turn agent ───────────────────────────────────────────────────────────

export const procurementTurnAgent: AgentDefinition<ProcurementTurnInput, ProcurementAgentOutput> = {
  name: 'procurement',
  persona: 'buyer',
  async run(run, input) {
    const out = emptyOutput()
    const s = input.session
    const say = (r: ProcurementReply, buttons: ProcurementAgentOutput['replies'][number]['buttons'] = null) => out.replies.push({ reply: r, buttons })
    const drafting = s.state === 'drafting' || s.state === 'awaiting_create'
    const capped = () => input.proposalsLeft <= 0
    const propose = async (tool: 'create_rfq' | 'complete_rfq' | 'answer_clarification' | 'message_provider' | 'decline_quote' | 'choose_quote', payload: Record<string, unknown>) => {
      await run.proposeTool(tool, payload)
      out.proposal = { tool, payload }
      out.proposed = true
    }

    // 0. media first: a voice note becomes text (STT); a photo / PDF becomes a document intake (prefill only)
    let text = input.message.text.trim()
    let language = LANG[s.locale]
    let via: 'text' | 'audio' | 'document' = 'text'
    let sttStub = false
    let doc: ProcurementDocIntake | null = null
    if (input.message.media?.kind === 'audio') {
      const t = await transcribe(run, input.message.media)
      if (!t) {
        say(P('reask'))
        return out
      }
      text = t.text
      language = t.language
      sttStub = t.stub
      via = 'audio'
    } else if (input.message.media?.kind === 'document') {
      if (!drafting && s.rfqId) {
        say(P('reask'))
        return out
      }
      doc = await extractDocument(run, input.message.media)
      if (!doc) {
        say(P('draft_failed', { link: `${input.appUrl}/app/rfq/new` }))
        return out
      }
      via = 'document'
    }

    // 1. a tapped label / session choice needs no model reading
    let turn: ProcurementTurn
    const liveLabels = Object.entries(s.labels).map(([, l]) => l).sort()
    if (input.forced?.label) {
      const purpose = s.pending?.kind === 'label' ? s.pending.purpose : 'choose'
      turn = { route: purpose === 'decline' ? 'decline' : purpose === 'ask' ? 'ask_provider' : 'choose', session_ref: 'current', choose_label: input.forced.label, decline_label: input.forced.label, decline_reason: s.pending?.kind === 'label' ? ((s.pending.reason as ProcurementTurn['decline_reason']) ?? null) : null, provider_question: s.pending?.kind === 'label' ? (s.pending.body ?? null) : null, escalate_to_support: false }
    } else if (doc) {
      turn = { route: drafting || !s.rfqId ? 'need_detail' : 'other', session_ref: 'current', choose_label: null, decline_label: null, decline_reason: null, provider_question: null, escalate_to_support: false }
    } else {
      const parts = buildProcurementTurnParts({ text, messageId: input.message.id, channel: input.message.channel, locale: s.locale, state: s.rfqId || s.state !== 'drafting' ? s.state : s.draft ? 'drafting' : null, hasRequest: !!s.rfqId, requestTitle: s.title, quoteLabels: liveLabels, waitingFor: waitingFor(s.pending), openProposal: s.openProposal?.tool ?? null })
      turn = await run.callModel<ProcurementTurn>({
        taskClass: 'procurement_turn',
        prompt: getPrompt('procurement_turn', 'v1'),
        schema: procurementTurnSchema,
        parts,
        temperature: 0,
        feature: 'procurement',
        stub: () => (input.stubs?.turn ?? ((t: string) => stubProcurementTurn(t, { state: s.state, hasRequest: !!s.rfqId, quoteLabels: liveLabels, waitingFor: waitingFor(s.pending) })))(text),
      })
    }
    if (input.forced?.sessionChoice === 'new') turn = { ...turn, route: 'new_need', session_ref: 'new' }

    if (turn.escalate_to_support) {
      out.escalate = true
      return out
    }

    // 2. one open proposal per session: only status / other / more detail for an open draft get through
    const detailForOpenDraft = s.openProposal?.tool === 'create_rfq' && (turn.route === 'need_detail' || turn.route === 'answer_to_agent' || (turn.route === 'new_need' && turn.session_ref !== 'new'))
    if (s.openProposal && !detailForOpenDraft && turn.route !== 'status' && turn.route !== 'other') {
      say(P('busy'))
      return out
    }

    // 3. a different need while this session follows a live request → ask which (the runtime starts a new session on "new")
    if (s.rfqId && (turn.route === 'new_need' || (turn.route === 'need_detail' && turn.session_ref === 'new')) && input.forced?.sessionChoice !== 'current' && input.forced?.sessionChoice !== 'new') {
      say(P('session_which', { title: s.title ?? '' }), { kind: 'session' })
      return out
    }

    // 4. drafting: new need / more detail / the clarify answer / a document
    if (!s.rfqId && (turn.route === 'new_need' || turn.route === 'need_detail' || (turn.route === 'answer_to_agent' && s.pending?.kind === 'clarify') || doc)) {
      if (detailForOpenDraft || (s.openProposal?.tool === 'create_rfq')) out.patch.cancelOpenProposal = true
      const draft: ProcurementDraftState = { description: s.draft?.description ?? '', docs: [...(s.draft?.docs ?? [])], clarified: s.draft?.clarified ?? null, via: s.draft?.via ?? via }
      if (via === 'audio') draft.via = 'audio'
      if (doc) {
        draft.docs = [...(draft.docs ?? []), doc].slice(-4)
        if (text) draft.description = [draft.description, text].filter(Boolean).join('\n')
      }
      let parse: VoiceParse | null = null
      let transcript: string | null = null
      let parser: string | null = null
      const clarifyPending = s.pending?.kind === 'clarify' ? s.pending : null
      if (clarifyPending && !doc) {
        const r = await parseNeed(run, { text, language, prior: clarifyPending })
        if (!r) {
          say(P('draft_failed', { link: `${input.appUrl}/app/rfq/new` }))
          return out
        }
        parse = r.parse
        transcript = clarifyPending.transcript_english
        parser = r.vendor?.parser ?? null
        draft.clarified = { question: clarifyPending.question, gap: clarifyPending.gap, answer: text, extraction_id: clarifyPending.extraction_id, via: via === 'audio' ? 'audio' : 'text' }
        draft.description = r.parse.description_english
      } else if (!doc || text) {
        const need = [draft.description, doc ? '' : text].filter(Boolean).join('\n').trim()
        const withDocs = [need, ...(draft.docs ?? []).map((d) => d.description)].filter(Boolean).join('\n').slice(0, 1000)
        const r = await parseNeed(run, { text: withDocs, language })
        if (!r) {
          say(P('draft_failed', { link: `${input.appUrl}/app/rfq/new` }))
          return out
        }
        parse = r.parse
        transcript = r.transcript_english
        parser = r.vendor?.parser ?? null
        draft.description = need || r.parse.description_english
        if (r.clarify && !draft.clarified) {
          out.patch = { ...out.patch, states: ['drafting'], draft, pending: { kind: 'clarify', question: r.clarify.question, gap: r.clarify.gap, qlocale: r.clarify.locale, extraction_id: r.clarify.extraction_id, transcript_english: r.transcript_english, parse: r.parse, via: via === 'audio' ? 'audio' : 'text' } }
          say(P('clarify', { question: r.clarify.question }))
          return out
        }
      }
      const category = parse?.category_slug ?? (draft.docs ?? []).map((d) => d.suggested_category_slug).find(Boolean) ?? null
      const description = (parse?.description_english || draft.description || (draft.docs ?? []).map((d) => d.description).join('\n')).trim()
      if (!category || description.length < 10) {
        out.patch = { ...out.patch, states: ['drafting'], draft, pending: null }
        say(P('need_more'))
        return out
      }
      if (capped()) {
        out.patch = { ...out.patch, states: ['drafting'], draft, pending: null }
        say(P('proposal_cap', { link: `${input.appUrl}/app/rfq/new` }))
        return out
      }
      const payload = rfqCreateBody({ categorySlug: category, description, via: draft.via ?? via, parse, transcript, sttStub, parser, clarified: draft.clarified ?? null, docs: draft.docs ?? [] })
      draft.payload = payload
      await propose('create_rfq', payload)
      out.patch = { ...out.patch, states: ['awaiting_create'], draft, pending: null, title: String(payload['title']) }
      say(P('draft_card', { summary: draftSummary(payload) }), { kind: 'decision', edit: true })
      return out
    }

    // 5. the S1.5 quality answers (the request is saved, not yet sent)
    if (s.pending?.kind === 'quality' && s.rfqId && (turn.route === 'answer_to_agent' || turn.route === 'need_detail' || turn.route === 'other')) {
      if (turn.route === 'other' && !SEND_AS_IS.test(text)) {
        say(P('reask'))
        return out
      }
      if (capped()) {
        say(P('proposal_cap', { link: rfqLink(input.appUrl, s.rfqId) }))
        return out
      }
      if (SEND_AS_IS.test(text)) {
        await propose('complete_rfq', { rfq_id: s.rfqId, mode: 'send' })
        say(P('quality_send_card', { title: s.title ?? '' }), { kind: 'decision', edit: false })
        return out
      }
      const pend = s.pending
      const q = pend.questions.find((x) => !pend.answers[x.field])
      const answers = { ...pend.answers, ...(q ? { [q.field]: text.slice(0, 1000) } : {}) }
      const next = pend.questions.find((x) => !answers[x.field])
      if (next) {
        out.patch.pending = { kind: 'quality', questions: pend.questions, answers }
        say(P('clarify', { question: next.question }))
        return out
      }
      await propose('complete_rfq', { rfq_id: s.rfqId, mode: 'answer', answers })
      out.patch.pending = { kind: 'quality', questions: pend.questions, answers }
      say(P('quality_card', { title: s.title ?? '', answers: pend.questions.map((x) => `• ${x.question} — ${answers[x.field]}`).join('\n') }), { kind: 'decision', edit: false })
      return out
    }

    // 6. a relayed provider question: the buyer's reply becomes the proposed answer (they confirm before it posts)
    if (s.pending?.kind === 'relay' && s.rfqId && (turn.route === 'answer_to_agent' || turn.route === 'need_detail' || turn.route === 'other')) {
      if (turn.route === 'other' && text.length < 2) {
        say(P('reask'))
        return out
      }
      if (capped()) {
        say(P('proposal_cap', { link: rfqLink(input.appUrl, s.rfqId) }))
        return out
      }
      const answer = text.slice(0, 1000)
      await propose('answer_clarification', { rfq_id: s.rfqId, clarification_id: s.pending.clarification_id, answer })
      say(P('clar_card', { title: s.title ?? '', answer }), { kind: 'decision', edit: true })
      return out
    }

    // 7. status: the S2.3 reply matrix over the buyer's own request (no model text)
    if (turn.route === 'status') {
      const rfq = s.rfqId ? await readRfq(run, s.rfqId) : null
      const view: SupportRfqView | null = rfq ? { id: rfq.id, title: rfq.title, status: rfq.status, quote_count: rfq.quoteCount, max_quotes: rfq.maxQuotes, expires_at: rfq.expiresAt ? new Date(rfq.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : null, my_quote: null } : null
      const base = { role: 'buyer' as const, rfqs_count: view ? 1 : 0, sla: { acknowledge_hours: 24, resolve_days: 15 }, support_contact: 'support@amclub.in' }
      const reply = resolveSupportReply('rfq_status', s.rfqId ? { ...base, rfq: view } : base)
      say({ source: 'support', key: reply.key, slots: reply.slots })
      return out
    }

    // everything below needs a live request with quotes
    if (!s.rfqId) {
      say(P(turn.route === 'other' ? 'reask' : 'need_more'))
      return out
    }
    const pickLabel = (candidate: string | null): string | null => {
      if (input.forced?.label) return input.forced.label
      if (candidate && labelMentioned(text, candidate)) return candidate
      // the model named none (or a letter the buyer never wrote): the letter only if it IS in the words
      for (const l of liveLabels) if (labelMentioned(text, l)) return l
      return null
    }

    // 8. choose / decline / ask a provider
    if (turn.route === 'choose' || turn.route === 'decline' || turn.route === 'ask_provider') {
      const rfq = await readRfq(run, s.rfqId)
      if (!rfq) {
        say(P('failed', { link: rfqLink(input.appUrl, s.rfqId) }))
        return out
      }
      const labels = labelsFor(rfq)
      out.patch.labels = labels
      const live = liveQuotes(rfq)
      const byLabel = new Map(Object.entries(labels).map(([qid, l]) => [l, qid]))
      const link = rfqLink(input.appUrl, s.rfqId)

      let body: string | null = null
      if (turn.route === 'ask_provider') {
        // the no-negotiation law: the buyer's own words, then the drafted message — either trips → refused
        const own = clampProviderMessage(turn.provider_question ?? text, s.locale)
        let draftBody = input.forced?.label && s.pending?.kind === 'label' ? s.pending.body ?? null : null
        if (!draftBody && own.ok) {
          const d = await run.callModel<ProviderMessageDraft>({
            taskClass: 'provider_message',
            prompt: getPrompt('provider_message', 'v1'),
            schema: providerMessageDraftSchema,
            parts: buildProviderMessageParts({ text, messageId: input.message.id, channel: input.message.channel, locale: s.locale, requestTitle: s.title, providerLabel: pickLabel(turn.choose_label) ?? 'unknown' }),
            temperature: 0.2,
            feature: 'procurement',
            stub: () => (input.stubs?.providerMessage ?? stubProviderMessage)(turn.provider_question ?? text),
          })
          draftBody = d.body
        }
        const drafted = draftBody ? clampProviderMessage(draftBody, s.locale) : own
        if (!own.ok || !drafted.ok) {
          say(P('no_negotiation', { link }))
          return out
        }
        body = drafted.body
      }

      const label = pickLabel(turn.route === 'decline' ? turn.decline_label : turn.choose_label) ?? (turn.route === 'ask_provider' && live.length === 1 ? labels[live[0]!.id]! : null)
      if (!label) {
        const choices = live.map((q) => labels[q.id]!).slice(0, 3)
        out.patch.pending = { kind: 'label', purpose: turn.route === 'decline' ? 'decline' : turn.route === 'ask_provider' ? 'ask' : 'choose', reason: turn.route === 'decline' ? procurementDeclineReason(turn.decline_reason) : null, body }
        say(P('choose_which', { link }), choices.length ? { kind: 'labels', labels: choices } : null)
        return out
      }
      const quoteId = byLabel.get(label)
      const quote = quoteId ? rfq.quotes.find((q) => q.id === quoteId) : null
      if (!quote || quote.status !== 'submitted' || (rfq.status !== 'open' && rfq.status !== 'quoted')) {
        out.patch.pending = null
        say(P('choose_unknown', { label, title: s.title ?? rfq.title, link }))
        return out
      }
      if (capped()) {
        say(P('proposal_cap', { link }))
        return out
      }
      out.patch.pending = null
      if (turn.route === 'choose') {
        await propose('choose_quote', { rfq_id: rfq.id, quote_id: quote.id, label, price_paise: quote.pricePaise })
        say(P('choose_card', { label, price: priceSlot(quote.pricePaise), title: s.title ?? rfq.title }), { kind: 'decision', edit: false })
      } else if (turn.route === 'decline') {
        const reason = procurementDeclineReason(turn.decline_reason ?? (s.pending?.kind === 'label' ? (s.pending.reason as ProcurementTurn['decline_reason']) : null))
        await propose('decline_quote', { rfq_id: rfq.id, quote_id: quote.id, label, reason })
        say(P('decline_card', { label, title: s.title ?? rfq.title, reason: PROCUREMENT_DECLINE_REASON_LABELS[s.locale][reason] }), { kind: 'decision', edit: false })
      } else {
        await propose('message_provider', { quote_id: quote.id, label, body: body! })
        say(P('ask_card', { label, title: s.title ?? rfq.title, body: body! }), { kind: 'decision', edit: true })
      }
      return out
    }

    say(P('reask'))
    return out
  },
}

// ── the watch agent ──────────────────────────────────────────────────────────

export const procurementWatchAgent: AgentDefinition<ProcurementWatchInput, ProcurementAgentOutput & { close: { state: ProcurementSessionState; reason: string } | null }> = {
  name: 'procurement',
  persona: 'buyer',
  async run(run, input) {
    const out = { ...emptyOutput(), close: null as { state: ProcurementSessionState; reason: string } | null }
    const s = input.session
    const say = (r: ProcurementReply, buttons: ProcurementAgentOutput['replies'][number]['buttons'] = null) => out.replies.push({ reply: r, buttons })
    if (!s.rfqId) {
      if (new Date(s.expiresAt).getTime() < new Date(input.now).getTime()) {
        out.close = { state: 'expired', reason: 'ttl' }
        say(P('closed_ttl', { title: s.title ?? '', days: Math.max(1, Math.round((new Date(input.now).getTime() - new Date(s.createdAt).getTime()) / 86_400_000)), link: `${input.appUrl}/app/rfq` }))
      }
      return out
    }
    const rfq = await readRfq(run, s.rfqId)
    if (!rfq) {
      out.close = { state: 'failed', reason: 'rfq_unreadable' }
      return out
    }
    const title = s.title ?? rfq.title
    const link = rfqLink(input.appUrl, s.rfqId)

    // 1. the request closed → one final message, the session closes (the runtime cancels any open proposal)
    if (rfq.status === 'accepted' || rfq.status === 'expired' || rfq.status === 'cancelled') {
      out.close = { state: 'closed', reason: `rfq_${rfq.status}` }
      say(P(rfq.status === 'accepted' ? 'closed_accepted' : rfq.status === 'expired' ? 'closed_expired' : 'closed_cancelled', { title }))
      return out
    }
    // 2. the session TTL
    if (new Date(s.expiresAt).getTime() < new Date(input.now).getTime()) {
      out.close = { state: 'expired', reason: 'ttl' }
      say(P('closed_ttl', { title, days: Math.max(1, Math.round((new Date(input.now).getTime() - new Date(s.createdAt).getTime()) / 86_400_000)), link }))
      return out
    }

    const deferred = rfq.quality?.deferred === true
    const states: ProcurementSessionState[] = []
    if (s.state === 'quality' && !deferred) states.push('live')
    const labels = labelsFor(rfq)
    out.patch.labels = labels
    const live = liveQuotes(rfq)
    const setKey = quoteSetKey(live.map((q) => q.id))

    // 3. a new quote set → ONE three-line summary (pure code over the compare results; labels = the page's letters)
    if (live.length > 0 && setKey !== (s.lastSeen.quote_set ?? null)) {
      const cmp = await run.proposeTool('compare_quotes', { rfq_id: rfq.id })
      const parsed = cmp.status === 'done' ? compareResponseSchema.safeParse(cmp.result.body) : null
      const results = (parsed?.success ? parsed.data.results : []) as unknown as CompareQuoteResult[]
      const summary = summariseQuotesForChat(results, rfq.quotes.map((q) => ({ id: q.id, pricePaise: q.pricePaise, deliveryDays: q.deliveryDays ?? null, status: q.status })), s.locale, { order: parsed?.success ? parsed.data.ordering?.ids ?? null : null })
      say(P('quotes_summary', { title, line1: summary.lines[0], line2: summary.lines[1], line3: summary.lines[2], link }))
      out.patch.lastSeen = { ...(out.patch.lastSeen ?? {}), quote_set: setKey }
      if ((s.state === 'live' || states.includes('live')) && s.state !== 'quotes_in') states.push('quotes_in')
    }
    if (states.length) out.patch.states = states

    // one open proposal / one open question at a time: nothing new is proposed or relayed until it is answered
    if (s.openProposal || s.pending) return out

    // 4. a new provider question → a drafted answer from the buyer's own words, or relayed verbatim (masked by the route)
    const seen = new Set(s.lastSeen.clarification_ids ?? [])
    const fresh = (rfq.clarifications ?? []).filter((c) => !c.answer && !seen.has(c.id))
    if (fresh.length) {
      const c = fresh[0]!
      const lastSeen = { ...(out.patch.lastSeen ?? {}), clarification_ids: [...seen, c.id].slice(-50) }
      const draft = await run.callModel<ClarificationAnswerDraft>({
        taskClass: 'clarification_answer',
        prompt: getPrompt('clarification_answer', 'v1'),
        schema: clarificationAnswerDraftSchema,
        parts: buildClarificationAnswerParts({ clarificationId: c.id, question: c.question, locale: s.locale, today: input.today, requestTitle: title, buyerTurns: input.buyerTurns }),
        temperature: 0,
        feature: 'procurement',
        stub: () => (input.stubs?.clarification ?? stubClarificationAnswer)(c.question, input.buyerTurns),
      })
      const accepted = acceptClarificationDraft(draft, input.buyerTurns.map((t) => t.id), s.locale)
      out.patch.lastSeen = lastSeen
      if (accepted.answerable && accepted.answer && input.proposalsLeft > 0) {
        await run.proposeTool('answer_clarification', { rfq_id: rfq.id, clarification_id: c.id, answer: accepted.answer })
        out.proposal = { tool: 'answer_clarification', payload: { rfq_id: rfq.id, clarification_id: c.id, answer: accepted.answer } }
        out.proposed = true
        say(P('clar_draft', { title, question: c.question.slice(0, 500), answer: accepted.answer }), { kind: 'decision', edit: true })
        return out
      }
      out.patch.pending = { kind: 'relay', clarification_id: c.id, question: c.question.slice(0, 500) }
      say(P('clar_relay', { title, question: c.question.slice(0, 500) }))
      return out
    }

    // 5. the chase: fanned out, zero quotes after procurement_chase_hours, once per session
    const hours = (new Date(input.now).getTime() - new Date(rfq.createdAt).getTime()) / 3_600_000
    if ((s.state === 'live' || states.includes('live')) && rfq.quoteCount === 0 && !deferred && !s.lastChaseAt && hours >= input.chaseHours && input.proposalsLeft > 0) {
      await run.proposeTool('nudge_counterparty', { subject_kind: 'rfq', subject_id: rfq.id, via: input.nudgeVia })
      out.proposal = { tool: 'nudge_counterparty', payload: { subject_kind: 'rfq', subject_id: rfq.id, via: input.nudgeVia } }
      out.proposed = true
      out.patch.lastChaseAt = input.now
      say(P('chase', { title, hours: Math.floor(hours) }), { kind: 'decision', edit: false })
    }
    return out
  },
}

