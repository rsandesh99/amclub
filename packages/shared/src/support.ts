/**
 * S2.3 — Support Agent contract (BUILD_PROMPTS S2.3).
 *
 * The ONE rule: the model never writes a sentence the user reads. It classifies
 * a message into an intent (+ which order / request it is about, + an escalate
 * flag, + an ops-facing summary) — `supportIntentSchema` has NO reply field by
 * design. Every user-visible reply is a template key from `support-copy.ts`
 * whose slots are filled from `/api/v1` reads under the user's own identity
 * (`resolveSupportReply`, pure), so the numbers rule is provable: every digit
 * run in a reply appears in the lookup payload or in the copy constants.
 *
 * One action: `nudge_counterparty` (confirm-gated, capped). Escalation halts
 * the agent on that conversation until a human resolves the ticket.
 */
import { z } from 'zod'
import { uuidSchema } from './schemas/index'

// ── intents ──────────────────────────────────────────────────────────────────

export const SUPPORT_INTENTS = [
  'order_status',
  'quote_status',
  'rfq_status',
  'payment_status',
  'payout_status',
  'how_to',
  'nudge_request',
  'complaint',
  'dispute_language',
  'payment_problem',
  'greeting',
  // S3.1 — the user describes something they need done ("I need a CA for GST filing"): the procurement agent's
  // entry point when it is enabled for them; otherwise the how-to for creating a request.
  'new_need',
  'other',
] as const
export type SupportIntent = (typeof SUPPORT_INTENTS)[number]

export const HOW_TO_TOPICS = [
  'create_rfq',
  'compare_quotes',
  'accept_quote',
  'pay',
  'refund',
  'cancel',
  'verification',
  'fees',
  'kyc_bank',
  'payout_timing',
  'dispute',
  'contact_human',
  'other',
] as const
export type HowToTopic = (typeof HOW_TO_TOPICS)[number]

export const SUPPORT_ESCALATE_REASONS = ['complaint', 'dispute_language', 'payment_problem', 'asked_for_human', 'unclear_twice', 'abuse', 'other'] as const
export type SupportEscalateReason = (typeof SUPPORT_ESCALATE_REASONS)[number]

export const SUPPORT_LOCALES = ['en', 'hi', 'te', 'ta'] as const
export type SupportLocale = (typeof SUPPORT_LOCALES)[number]
export function toSupportLocale(l: string | null | undefined): SupportLocale {
  const base = (l ?? 'en').toLowerCase().split(/[-_]/)[0] ?? 'en'
  return (SUPPORT_LOCALES as readonly string[]).includes(base) ? (base as SupportLocale) : 'en'
}

/** The classifier's output — no reply text, by design. */
export const supportIntentSchema = z
  .object({
    intent: z.enum(SUPPORT_INTENTS),
    /** When the user holds both roles: which hat the question wears. */
    as_role: z.enum(['buyer', 'provider']).nullable(),
    /** An order number as written in the trusted list, or 'latest'. */
    order_ref: z.string().max(40).nullable(),
    rfq_ref: z.string().max(40).nullable(),
    how_to_topic: z.enum(HOW_TO_TOPICS).nullable(),
    escalate: z.boolean(),
    escalate_reason: z.enum(SUPPORT_ESCALATE_REASONS).nullable(),
    /** Ops-facing only; customerFacingText(contact, urls) applied in agent-core. */
    ops_summary: z.string().max(400).nullable(),
    language: z.enum(SUPPORT_LOCALES),
  })
  .strict()
export type SupportIntentOutput = z.infer<typeof supportIntentSchema>

export const SUPPORT_SUGGESTED_NEXT = ['call_user', 'check_order', 'check_payment', 'check_payout', 'refund_review', 'no_action'] as const
export const supportTicketSummarySchema = z
  .object({
    summary: z.string().min(1).max(600),
    suggested_next: z.enum(SUPPORT_SUGGESTED_NEXT),
  })
  .strict()
export type SupportTicketSummary = z.infer<typeof supportTicketSummarySchema>

/** The short human reference for a ticket id (the user sees it in the escalated template). */
export function ticketRefFromId(id: string): string {
  return `T-${id.slice(0, 8).toUpperCase()}`
}

export const nudgeSchema = z.object({ subject_kind: z.enum(['order', 'rfq']), subject_id: uuidSchema }).strict()
export type NudgeInput = z.infer<typeof nudgeSchema>

export const SUPPORT_TICKET_STATUSES = ['open', 'in_progress', 'resolved'] as const
export type SupportTicketStatus = (typeof SUPPORT_TICKET_STATUSES)[number]
export const SUPPORT_CHANNELS = ['whatsapp', 'web', 'mobile'] as const
export type SupportChannel = (typeof SUPPORT_CHANNELS)[number]

// ── reply keys (intent × outcome) ────────────────────────────────────────────

export const SUPPORT_REPLY_KEYS = [
  'order_status.placed',
  'order_status.accepted',
  'order_status.requirements_submitted',
  'order_status.in_progress',
  'order_status.delivered',
  'order_status.revision_requested',
  'order_status.completed',
  'order_status.reviewed',
  'order_status.disputed',
  'order_status.resolved',
  'order_status.cancelled',
  'order_status.refunded',
  'order_status.not_found',
  'order_status.none',
  'quote_status.submitted',
  'quote_status.accepted',
  'quote_status.declined',
  'quote_status.withdrawn',
  'quote_status.expired',
  'quote_status.none',
  'quote_status.not_found',
  'quote_status.no_matches',
  'rfq_status.open_no_quotes',
  'rfq_status.open_quoted',
  'rfq_status.accepted',
  'rfq_status.expired',
  'rfq_status.cancelled',
  'rfq_status.not_found',
  'rfq_status.none',
  'payment_status.paid',
  'payment_status.refunded',
  'payment_status.refund_pending',
  'payment_status.not_found',
  'payment_status.none',
  'payout_status.not_due',
  'payout_status.scheduled',
  'payout_status.processing',
  'payout_status.paid',
  'payout_status.failed',
  'payout_status.held_dispute',
  'payout_status.held',
  'payout_status.not_found',
  'payout_status.none',
  'how_to.create_rfq',
  'how_to.compare_quotes',
  'how_to.accept_quote',
  'how_to.pay',
  'how_to.refund',
  'how_to.cancel',
  'how_to.verification',
  'how_to.fees',
  'how_to.kyc_bank',
  'how_to.payout_timing',
  'how_to.dispute',
  'how_to.contact_human',
  'how_to.other',
  'nudge.confirm',
  'nudge.sent',
  'nudge.capped',
  'nudge.no_subject',
  'nudge.out_of_window',
  'new_need.offer',
  'greeting',
  // "What can you help me with?" — chosen by the engine (a deterministic text match on an unclear turn), never by the model.
  'capabilities',
  'unclear',
  'unclear_again',
  'escalated',
  'escalated_open',
  'resolved',
] as const
export type SupportReplyKey = (typeof SUPPORT_REPLY_KEYS)[number]

// ── the lookup payload (what the surfaces read for the user) ─────────────────

export interface SupportOrderView {
  id: string
  order_number: string
  title: string
  status: string
  /** Pre-formatted by the surface from paise (money never rendered client-side from raw numbers). */
  amount: string
  /** Provider's earning for the provider hat; buyer sees the total. */
  earning: string | null
  eta_date: string | null
  updated_at: string
  /** Optional payout facts when the surface could read them (web: service role AFTER the party check). */
  payout: { status: string; scheduled_for: string | null; amount: string | null } | null
  /** Optional refund facts (a refund row exists). */
  refund: { status: string } | null
}

export interface SupportRfqView {
  id: string
  title: string
  status: string
  quote_count: number
  max_quotes: number
  expires_at: string | null
  /** The provider's own quote on this RFQ, when the provider hat asks. */
  my_quote: { status: string; price: string } | null
}

export interface SupportLookupResult {
  role: 'buyer' | 'provider'
  /** The resolved order (the referenced one, or the latest), null when none matched, undefined when not looked up. */
  order?: SupportOrderView | null
  orders_count?: number
  rfq?: SupportRfqView | null
  rfqs_count?: number
  how_to_topic?: HowToTopic | null
  /** The nudge subject the reply may offer. */
  nudge_subject?: { kind: 'order' | 'rfq'; id: string; active: boolean; capped: boolean } | null
  /** Fixed facts every surface passes (from lib/legal/grievance.ts): quoted verbatim in the copy. */
  sla: { acknowledge_hours: number; resolve_days: number }
  support_contact: string
  ticket_ref?: string | null
  /** The nudge cap the reply quotes (`support_nudge_cooldown_hours`); defaults to 24. */
  nudge_cooldown_hours?: number
  /** S3.1 — the procurement agent is enabled for this user on this channel (the new_need offer instead of the how-to). */
  procurement_available?: boolean
}

export interface SupportReply {
  key: SupportReplyKey
  slots: Record<string, string | number>
  action?: { tool: 'nudge_counterparty'; subject: { kind: 'order' | 'rfq'; id: string } }
}

const ORDER_STATUS_KEY: Record<string, SupportReplyKey> = {
  placed: 'order_status.placed',
  accepted: 'order_status.accepted',
  requirements_submitted: 'order_status.requirements_submitted',
  in_progress: 'order_status.in_progress',
  delivered: 'order_status.delivered',
  revision_requested: 'order_status.revision_requested',
  completed: 'order_status.completed',
  reviewed: 'order_status.reviewed',
  disputed: 'order_status.disputed',
  resolved_refund: 'order_status.resolved',
  resolved_release: 'order_status.resolved',
  resolved_partial: 'order_status.resolved',
  cancelled_by_buyer: 'order_status.cancelled',
  auto_cancelled: 'order_status.cancelled',
  cancelled_duplicate: 'order_status.cancelled',
  refunded: 'order_status.refunded',
}

export const ORDER_TERMINAL_STATUSES = ['completed', 'reviewed', 'resolved_refund', 'resolved_release', 'resolved_partial', 'cancelled_by_buyer', 'auto_cancelled', 'refunded', 'cancelled_duplicate'] as const
export function orderIsActive(status: string): boolean {
  return !(ORDER_TERMINAL_STATUSES as readonly string[]).includes(status)
}

function orderSlots(o: SupportOrderView, role: 'buyer' | 'provider'): Record<string, string | number> {
  return {
    order_number: o.order_number,
    title: o.title,
    status: o.status,
    amount: role === 'provider' && o.earning ? o.earning : o.amount,
    eta_date: o.eta_date ?? '',
  }
}

/**
 * Pure: (intent, what was looked up) → the template key + slots (+ the one
 * offered action). Never a sentence; never a number that is not in `lookup`.
 */
export function resolveSupportReply(intent: SupportIntent, lookup: SupportLookupResult): SupportReply {
  const base = { sla_hours: lookup.sla.acknowledge_hours, sla_days: lookup.sla.resolve_days, contact: lookup.support_contact }
  const nudge = (): SupportReply['action'] | undefined => (lookup.nudge_subject && lookup.nudge_subject.active && !lookup.nudge_subject.capped ? { tool: 'nudge_counterparty', subject: { kind: lookup.nudge_subject.kind, id: lookup.nudge_subject.id } } : undefined)

  switch (intent) {
    case 'greeting':
      return { key: 'greeting', slots: base }
    case 'new_need':
      return lookup.procurement_available ? { key: 'new_need.offer', slots: base } : { key: 'how_to.create_rfq', slots: base }
    case 'complaint':
    case 'dispute_language':
    case 'payment_problem':
      return { key: 'escalated', slots: { ...base, ticket_ref: lookup.ticket_ref ?? '' } }
    case 'how_to': {
      const topic = lookup.how_to_topic ?? 'other'
      return { key: `how_to.${topic}` as SupportReplyKey, slots: base }
    }
    case 'order_status': {
      if (lookup.order === undefined || (lookup.order === null && (lookup.orders_count ?? 0) === 0)) return { key: 'order_status.none', slots: base }
      if (!lookup.order) return { key: 'order_status.not_found', slots: base }
      const key = ORDER_STATUS_KEY[lookup.order.status] ?? 'order_status.not_found'
      const slots = { ...base, ...orderSlots(lookup.order, lookup.role) }
      const action = orderIsActive(lookup.order.status) && ['placed', 'accepted', 'requirements_submitted', 'in_progress', 'delivered', 'revision_requested'].includes(lookup.order.status) ? nudge() : undefined
      return action ? { key, slots, action } : { key, slots }
    }
    case 'payment_status': {
      if (lookup.order === undefined || (lookup.order === null && (lookup.orders_count ?? 0) === 0)) return { key: 'payment_status.none', slots: base }
      if (!lookup.order) return { key: 'payment_status.not_found', slots: base }
      const o = lookup.order
      const slots = { ...base, ...orderSlots(o, lookup.role) }
      if (o.status === 'refunded' || o.status === 'resolved_refund') return { key: 'payment_status.refunded', slots }
      if (o.refund || o.status === 'resolved_partial' || o.status === 'cancelled_by_buyer' || o.status === 'auto_cancelled' || o.status === 'cancelled_duplicate') return { key: 'payment_status.refund_pending', slots }
      // an order row exists only after the payment webhook (webhooks are the payment truth)
      return { key: 'payment_status.paid', slots }
    }
    case 'payout_status': {
      if (lookup.order === undefined || (lookup.order === null && (lookup.orders_count ?? 0) === 0)) return { key: 'payout_status.none', slots: base }
      if (!lookup.order) return { key: 'payout_status.not_found', slots: base }
      const o = lookup.order
      const slots = { ...base, ...orderSlots(o, 'provider'), scheduled_for: o.payout?.scheduled_for ?? '' }
      if (o.status === 'disputed') return { key: 'payout_status.held_dispute', slots }
      if (o.payout) {
        const p = o.payout.status
        if (p === 'paid') return { key: 'payout_status.paid', slots }
        if (p === 'processing') return { key: 'payout_status.processing', slots }
        if (p === 'failed') return { key: 'payout_status.failed', slots }
        if (p === 'held') return { key: 'payout_status.held', slots }
        return { key: 'payout_status.scheduled', slots }
      }
      if (o.status === 'completed' || o.status === 'reviewed' || o.status === 'resolved_release' || o.status === 'resolved_partial') return { key: 'payout_status.scheduled', slots }
      return { key: 'payout_status.not_due', slots }
    }
    case 'quote_status': {
      // no matched / quoted request at all: its own key (quote_status.none names a request title)
      if (lookup.rfq === undefined || (lookup.rfq === null && (lookup.rfqs_count ?? 0) === 0)) return { key: 'quote_status.no_matches', slots: base }
      if (!lookup.rfq) return { key: 'quote_status.not_found', slots: base }
      const r = lookup.rfq
      const slots = { ...base, title: r.title, quote_count: r.quote_count, max_quotes: r.max_quotes, expires_date: r.expires_at ?? '', price: r.my_quote?.price ?? '' }
      if (!r.my_quote) return { key: 'quote_status.none', slots }
      const s = r.my_quote.status
      const key: SupportReplyKey = s === 'accepted' ? 'quote_status.accepted' : s === 'declined' ? 'quote_status.declined' : s === 'withdrawn' ? 'quote_status.withdrawn' : s === 'expired' ? 'quote_status.expired' : 'quote_status.submitted'
      const action = key === 'quote_status.submitted' && r.status !== 'expired' && r.status !== 'cancelled' ? nudge() : undefined
      return action ? { key, slots, action } : { key, slots }
    }
    case 'rfq_status': {
      if (lookup.rfq === undefined || (lookup.rfq === null && (lookup.rfqs_count ?? 0) === 0)) return { key: 'rfq_status.none', slots: base }
      if (!lookup.rfq) return { key: 'rfq_status.not_found', slots: base }
      const r = lookup.rfq
      const slots = { ...base, title: r.title, quote_count: r.quote_count, max_quotes: r.max_quotes, expires_date: r.expires_at ?? '' }
      if (r.status === 'accepted') return { key: 'rfq_status.accepted', slots }
      if (r.status === 'expired') return { key: 'rfq_status.expired', slots }
      if (r.status === 'cancelled') return { key: 'rfq_status.cancelled', slots }
      const key: SupportReplyKey = r.quote_count > 0 ? 'rfq_status.open_quoted' : 'rfq_status.open_no_quotes'
      const action = r.quote_count === 0 ? nudge() : undefined
      return action ? { key, slots, action } : { key, slots }
    }
    case 'nudge_request': {
      if (!lookup.nudge_subject) return { key: 'nudge.no_subject', slots: base }
      if (!lookup.nudge_subject.active) return { key: 'nudge.out_of_window', slots: base }
      if (lookup.nudge_subject.capped) return { key: 'nudge.capped', slots: { ...base, hours: lookup.nudge_cooldown_hours ?? 24 } }
      return { key: 'nudge.confirm', slots: base, action: { tool: 'nudge_counterparty', subject: { kind: lookup.nudge_subject.kind, id: lookup.nudge_subject.id } } }
    }
    case 'other':
    default:
      return { key: 'unclear', slots: base }
  }
}

/** Every digit run in a rendered reply must appear in the lookup payload or in the copy constants (the numbers rule). */
export function digitRuns(text: string): string[] {
  return (text.match(/\d+/g) ?? []).map((d) => d)
}

export function numbersAccountedFor(replyText: string, allowedSources: readonly string[]): { ok: boolean; missing: string[] } {
  const pool = allowedSources.join('\n')
  const missing = digitRuns(replyText).filter((d) => !pool.includes(d))
  return { ok: missing.length === 0, missing }
}
