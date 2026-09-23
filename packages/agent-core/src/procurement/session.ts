import {
  PROCUREMENT_SESSION_TERMINAL,
  formatRupees,
  isUnambiguousYes,
  isValidProcurementSessionTransition,
  procurementCheckoutPath,
  voiceMayConfirm,
  type ProcurementCopyKey,
  type ProcurementLocale,
  type ProcurementSessionState,
  type SupportReplyKey,
  type VoiceParse,
} from '@amclub/shared'
import type { ToolCallResult } from '../runner'

/**
 * The procurement session as the agent sees it (S3.1), and the PURE rules both
 * the runtime and the golden harness apply: the patch an agent run returns,
 * what an approved (resumed) tool means for the session and the buyer, and how
 * a typed / spoken reply to an open proposal is read. One implementation, so
 * the harness proves exactly what the runtime does.
 */

export type ProcurementWaiting = 'none' | 'clarify_answer' | 'quality_answers' | 'relay_answer' | 'label_pick'

export interface ProcurementDocIntake {
  extraction_id: string
  attachment: { url: string; name: string }
  description: string
  suggested_category_slug: string | null
  facts: string[]
}

export type ProcurementPending =
  | { kind: 'clarify'; question: string; gap: string; qlocale: string; extraction_id: string; transcript_english: string; parse: VoiceParse; via: 'audio' | 'text' }
  | { kind: 'quality'; questions: { field: string; question: string }[]; answers: Record<string, string> }
  | { kind: 'relay'; clarification_id: string; question: string }
  | { kind: 'label'; purpose: 'choose' | 'decline' | 'ask'; reason?: string | null; body?: string | null }

export interface ProcurementDraftState {
  /** The accumulated description of the need (the buyer's words, English after STT / parse). */
  description: string
  /** The RFQ create body last proposed (create_rfq payload), when one was. */
  payload?: Record<string, unknown> | null
  docs?: ProcurementDocIntake[]
  /** S1.8 clarify round done (a request carrying `prior` never gets another question). */
  clarified?: { question: string; gap: string; answer: string; extraction_id: string; via: 'audio' | 'text' } | null
  via?: 'audio' | 'text' | 'document'
}

export interface ProcurementSessionView {
  id: string
  state: ProcurementSessionState
  rfqId: string | null
  title: string | null
  locale: ProcurementLocale
  surface: 'whatsapp' | 'web' | 'mobile'
  /** quote id → the compare page's letter. */
  labels: Record<string, string>
  pending: ProcurementPending | null
  draft: ProcurementDraftState | null
  openProposal: { tool: string; runId: string } | null
  lastSeen: { clarification_ids?: string[]; quote_set?: string | null }
  lastChaseAt: string | null
  expiresAt: string
  createdAt: string
}

export type ProcurementReply =
  | { source: 'procurement'; key: ProcurementCopyKey; slots: Record<string, string | number> }
  | { source: 'support'; key: SupportReplyKey; slots: Record<string, string | number> }

export type ProcurementButtons =
  | { kind: 'decision'; edit: boolean }
  | { kind: 'labels'; labels: string[] }
  | { kind: 'session' }
  | null

export interface ProcurementPatch {
  /** Applied in order, each checked against PROCUREMENT_SESSION_TRANSITIONS (an illegal step is dropped, logged by the runtime). */
  states?: ProcurementSessionState[]
  rfqId?: string
  title?: string
  draft?: ProcurementDraftState | null
  pending?: ProcurementPending | null
  labels?: Record<string, string>
  lastSeen?: ProcurementSessionView['lastSeen']
  lastChaseAt?: string
  closeReason?: string
  /** A create_rfq proposal is superseded (the buyer added detail): the runtime cancels its parked run. */
  cancelOpenProposal?: boolean
}

export interface ProcurementAgentOutput {
  replies: { reply: ProcurementReply; buttons: ProcurementButtons }[]
  /** The proposal the run parked on (confirm:true), when it did. */
  proposal: { tool: string; payload: Record<string, unknown> } | null
  patch: ProcurementPatch
  escalate: boolean
  /** Counts toward procurement_max_proposals_per_day. */
  proposed: boolean
}

export function emptyOutput(): ProcurementAgentOutput {
  return { replies: [], proposal: null, patch: {}, escalate: false, proposed: false }
}

export function waitingFor(p: ProcurementPending | null): ProcurementWaiting {
  if (!p) return 'none'
  return p.kind === 'clarify' ? 'clarify_answer' : p.kind === 'quality' ? 'quality_answers' : p.kind === 'relay' ? 'relay_answer' : 'label_pick'
}

/** Apply a patch to a session view (the runtime persists the same fields). Illegal state steps are skipped and reported. */
export function applyProcurementPatch(s: ProcurementSessionView, p: ProcurementPatch): { session: ProcurementSessionView; illegal: string[] } {
  const next: ProcurementSessionView = { ...s, lastSeen: { ...s.lastSeen } }
  const illegal: string[] = []
  for (const to of p.states ?? []) {
    if (to === next.state) continue
    if (isValidProcurementSessionTransition(next.state, to)) next.state = to
    else illegal.push(`${next.state}->${to}`)
  }
  if (p.rfqId !== undefined) next.rfqId = p.rfqId
  if (p.title !== undefined) next.title = p.title
  if (p.draft !== undefined) next.draft = p.draft
  if (p.pending !== undefined) next.pending = p.pending
  if (p.labels !== undefined) next.labels = p.labels
  if (p.lastSeen !== undefined) next.lastSeen = { ...next.lastSeen, ...p.lastSeen }
  if (p.lastChaseAt !== undefined) next.lastChaseAt = p.lastChaseAt
  if ((PROCUREMENT_SESSION_TERMINAL as readonly string[]).includes(next.state)) next.pending = null
  return { session: next, illegal }
}

// ── reading a reply to an open proposal ──────────────────────────────────────

/**
 * A typed / spoken message while a proposal is open: an allow-listed yes approves ONLY a tool the voice may confirm;
 * for a button-only tool (choose_quote, decline_quote, the chase nudge) the buttons are sent again and nothing is
 * recorded; anything else is a new turn.
 */
export function readUtteranceOnProposal(tool: string, text: string, locale: string): 'approve' | 'resend_buttons' | 'not_a_yes' {
  if (!isUnambiguousYes(text, locale)) return 'not_a_yes'
  return voiceMayConfirm(tool) ? 'approve' : 'resend_buttons'
}

// ── what an approved (resumed) tool means ────────────────────────────────────

export interface ResumeEffectArgs {
  tool: string
  result: ToolCallResult | null
  error: string | null
  session: ProcurementSessionView
  payload: Record<string, unknown>
  decisionId: string | null
  appUrl: string
}

const rfqLink = (appUrl: string, rfqId: string | null) => (rfqId ? `${appUrl}/app/rfq/${rfqId}` : `${appUrl}/app/rfq`)

/** The session patch + the buyer's reply after the ordinary route ran (or refused). Pure. */
export function procurementResumeEffect(a: ResumeEffectArgs): { patch: ProcurementPatch; reply: ProcurementReply } {
  const s = a.session
  const title = s.title ?? ''
  const body = (a.result?.body ?? null) as Record<string, unknown> | null
  const err = (typeof body?.['error'] === 'string' ? (body['error'] as string) : null) ?? a.error
  const P = (key: ProcurementCopyKey, slots: Record<string, string | number> = {}): ProcurementReply => ({ source: 'procurement', key, slots })
  const failed = (): { patch: ProcurementPatch; reply: ProcurementReply } => ({ patch: { pending: null }, reply: P('failed', { link: rfqLink(a.appUrl, s.rfqId) }) })
  const gone = (patch: ProcurementPatch = {}): { patch: ProcurementPatch; reply: ProcurementReply } => ({ patch: { pending: null, ...patch }, reply: P('proposal_gone') })

  if (!a.result?.ok) {
    if (a.tool === 'create_rfq') return { patch: { states: ['drafting'], pending: null }, reply: P('failed', { link: `${a.appUrl}/app/rfq/new` }) }
    if (a.tool === 'nudge_counterparty' && a.result?.status === 429) {
      const hours = Number(body?.['cooldown_hours'] ?? 24)
      return { patch: {}, reply: P('nudge_capped', { hours: Number.isFinite(hours) ? hours : 24 }) }
    }
    if (a.result && (a.result.status === 409 || a.result.status === 404)) return gone()
    if (err === 'tool_out_of_scope') return failed()
    return failed()
  }

  switch (a.tool) {
    case 'create_rfq': {
      const rfqId = String(body?.['rfqId'] ?? '')
      const matched = Number(body?.['matched'] ?? 0)
      const quality = (body?.['quality'] ?? null) as { missing?: { field: string; question: string }[] } | null
      const deferred = body?.['deferred'] === true && Array.isArray(quality?.missing) && quality!.missing!.length > 0
      if (deferred) {
        const questions = quality!.missing!.slice(0, 3).map((m) => ({ field: String(m.field), question: String(m.question) }))
        return {
          patch: { states: ['quality'], rfqId, pending: { kind: 'quality', questions, answers: {} } },
          reply: P('created_deferred', { title, questions: questions.map((q, i) => `${i + 1}. ${q.question}`).join('\n') }),
        }
      }
      return { patch: { states: ['live'], rfqId, pending: null }, reply: P('created', { title, matched }) }
    }
    case 'complete_rfq':
      return { patch: { states: ['live'], pending: null }, reply: P('released', { title, matched: Number(body?.['matched'] ?? 0) }) }
    case 'answer_clarification':
      return { patch: { pending: null }, reply: P('clar_posted', { title }) }
    case 'message_provider':
      return { patch: { pending: null }, reply: P('asked', { label: String(a.payload['label'] ?? '') }) }
    case 'decline_quote':
      return { patch: { pending: null }, reply: P('declined', { label: String(a.payload['label'] ?? '') }) }
    case 'choose_quote': {
      const rfqId = String(a.payload['rfq_id'] ?? s.rfqId ?? '')
      const quoteId = String(a.payload['quote_id'] ?? '')
      if (!a.decisionId || !rfqId || !quoteId) return failed()
      return { patch: { states: ['chosen'], pending: null }, reply: P('choose_link', { label: String(a.payload['label'] ?? ''), link: `${a.appUrl}${procurementCheckoutPath(rfqId, quoteId, a.decisionId)}` }) }
    }
    case 'nudge_counterparty':
      return { patch: {}, reply: P('nudged', { title }) }
    default:
      return failed()
  }
}

/** The buyer tapped No / Edit on a proposal: the session patch + the reply (no route ran). */
export function procurementDeclineEffect(a: { tool: string; action: 'no' | 'edit'; session: ProcurementSessionView; appUrl: string }): { patch: ProcurementPatch; reply: ProcurementReply } {
  const s = a.session
  const P = (key: ProcurementCopyKey, slots: Record<string, string | number> = {}): ProcurementReply => ({ source: 'procurement', key, slots })
  if (a.action === 'edit') {
    const link = a.tool === 'create_rfq' ? `${a.appUrl}/app/rfq/new?assistant=${s.id}` : rfqLink(a.appUrl, s.rfqId)
    const states: ProcurementSessionState[] = a.tool === 'create_rfq' ? ['drafting'] : []
    return { patch: { states, pending: null }, reply: P('edit_link', { link }) }
  }
  if (a.tool === 'create_rfq') return { patch: { states: ['closed'], pending: null, closeReason: 'buyer_declined_draft' }, reply: P('closed_no') }
  return { patch: { pending: null }, reply: P('declined_no') }
}

/** The card slots for a proposal (the runtime and the web mirror render the same text). */
export function priceSlot(paise: unknown): string {
  const n = Number(paise)
  return Number.isInteger(n) && n > 0 ? formatRupees(n) : '—'
}
