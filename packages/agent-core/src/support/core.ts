import {
  SUPPORT_COPY,
  numbersAccountedFor,
  renderSupportReply,
  resolveSupportReply,
  statusLabel,
  type SupportIntent,
  type SupportIntentOutput,
  type SupportLocale,
  type SupportLookupResult,
  type SupportOrderView,
  type SupportReply,
  type SupportRfqView,
} from '@amclub/shared'
import type { ChatParts } from '../llm/gateway'
import { buildSupportIntentParts } from './parts'
import { isSupportCapabilitiesQuestion } from './capabilities'

/**
 * The ONE support engine (S2.3), used by the web / mobile route (session
 * client, RLS) and by the WhatsApp runtime (delegated token GETs). The model
 * classifies; the engine resolves references through the injected lookups,
 * picks a template (`resolveSupportReply`, pure) and renders it. It never
 * asks the model for text, and it reports the numbers rule on every reply.
 */

export interface SupportLookups {
  /** Latest first, ≤ 10, money and dates pre-formatted by the surface. */
  listOrders(role: 'buyer' | 'provider'): Promise<SupportOrderView[]>
  /** By order number as written (case-insensitive) — the surface enforces the party check. */
  getOrder(ref: string, role: 'buyer' | 'provider'): Promise<SupportOrderView | null>
  listRfqs(role: 'buyer' | 'provider'): Promise<SupportRfqView[]>
  getRfq(ref: string, role: 'buyer' | 'provider'): Promise<SupportRfqView | null>
  /** Is the subject still active and has this user nudged it within the cooldown? */
  nudgeState(subject: { kind: 'order' | 'rfq'; id: string }, role: 'buyer' | 'provider'): Promise<{ active: boolean; capped: boolean }>
}

export interface SupportTurnInput {
  text: string
  messageId: string
  channel: 'whatsapp' | 'support_chat'
  roles: readonly ('buyer' | 'provider')[]
  locale: SupportLocale
  history: { intents: readonly SupportIntent[]; unclearStreak: number; previousText?: string | null; previousMessageId?: string | null }
  /** An open ticket on this conversation / thread: store only, reply the escalated_open template, no model call. */
  openTicket: boolean
  ticketRef?: string | null
  /** S3.1 — the procurement agent is enabled for this buyer on this channel: a new_need gets the offer (else the create-request how-to). */
  procurementAvailable?: boolean
}

export interface SupportTurnDeps {
  classify: (parts: ChatParts) => Promise<SupportIntentOutput>
  lookups: SupportLookups
  settings: { escalateAfterTurns: number; nudgeCooldownHours: number }
  sla: { acknowledge_hours: number; resolve_days: number }
  supportContact: string
}

export interface SupportTurnResult {
  intent: SupportIntentOutput | null
  role: 'buyer' | 'provider'
  reply: { key: SupportReply['key']; text: string; slots: Record<string, string | number> }
  action?: SupportReply['action']
  escalate?: { reason: string; summary: string | null }
  /** Ids only — what the reply was built from (stored on the message, never content). */
  lookupRefs: { order_id?: string; rfq_id?: string }
  unclearStreak: number
  /** The numbers rule, checked on every reply: every digit run in the text is in the lookup payload or the copy. */
  numbers: { ok: boolean; missing: string[] }
}

const ORDER_INTENTS: readonly SupportIntent[] = ['order_status', 'payment_status', 'payout_status']
const RFQ_INTENTS: readonly SupportIntent[] = ['rfq_status', 'quote_status']
const ESCALATING: readonly SupportIntent[] = ['complaint', 'dispute_language', 'payment_problem']

function pickRole(intent: SupportIntentOutput, roles: readonly ('buyer' | 'provider')[]): 'buyer' | 'provider' {
  if (intent.as_role && roles.includes(intent.as_role)) return intent.as_role
  if (roles.length === 1) return roles[0]!
  // both hats: payout / quote questions are the provider's; the rest default to the buyer
  if (intent.intent === 'payout_status' || intent.intent === 'quote_status') return roles.includes('provider') ? 'provider' : roles[0]!
  return roles.includes('buyer') ? 'buyer' : roles[0]!
}

function normRef(ref: string | null): string | null {
  if (!ref) return null
  const r = ref.trim()
  return r.length ? r : null
}

export async function runSupportTurn(deps: SupportTurnDeps, input: SupportTurnInput): Promise<SupportTurnResult> {
  const baseLookup = (role: 'buyer' | 'provider'): SupportLookupResult => ({ role, sla: deps.sla, support_contact: deps.supportContact, ticket_ref: input.ticketRef ?? null, nudge_cooldown_hours: deps.settings.nudgeCooldownHours })
  const finish = (role: 'buyer' | 'provider', intent: SupportIntentOutput | null, lookup: SupportLookupResult, refs: SupportTurnResult['lookupRefs'], unclearStreak: number, escalate?: SupportTurnResult['escalate'], forceKey?: SupportReply['key']): SupportTurnResult => {
    const resolved: SupportReply = forceKey ? { key: forceKey, slots: { sla_hours: deps.sla.acknowledge_hours, sla_days: deps.sla.resolve_days, contact: deps.supportContact, ticket_ref: input.ticketRef ?? '' } } : resolveSupportReply(intent?.intent ?? 'other', lookup)
    const slots = { ...resolved.slots }
    if (lookup.order && typeof slots['status'] === 'string') slots['status_label'] = statusLabel('order', lookup.order.status, input.locale)
    if (lookup.rfq && !slots['status_label']) slots['status_label'] = statusLabel('rfq', lookup.rfq.status, input.locale)
    const text = renderSupportReply(resolved.key, slots, input.locale)
    // the copy constants are an allowed source: a template may carry fixed numbers (5–7 working days, 72 hours, 5 %)
    const sources = [SUPPORT_COPY[input.locale][resolved.key], JSON.stringify(lookup.order ?? null), JSON.stringify(lookup.rfq ?? null), JSON.stringify(deps.sla), deps.supportContact, String(input.ticketRef ?? ''), String(deps.settings.nudgeCooldownHours)]
    const numbers = numbersAccountedFor(text, sources)
    return { intent, role, reply: { key: resolved.key, text, slots }, ...(resolved.action ? { action: resolved.action } : {}), ...(escalate ? { escalate } : {}), lookupRefs: refs, unclearStreak, numbers }
  }

  const defaultRole: 'buyer' | 'provider' = input.roles.includes('buyer') ? 'buyer' : (input.roles[0] ?? 'buyer')
  if (input.openTicket) return finish(defaultRole, null, baseLookup(defaultRole), {}, input.history.unclearStreak, undefined, 'escalated_open')

  // 1. classify (the only model call; the output has no reply text by construction)
  const [orders0, rfqs0] = await Promise.all([deps.lookups.listOrders(defaultRole).catch(() => [] as SupportOrderView[]), deps.lookups.listRfqs(defaultRole).catch(() => [] as SupportRfqView[])])
  const parts = buildSupportIntentParts({
    text: input.text,
    messageId: input.messageId,
    channel: input.channel,
    roles: input.roles,
    locale: input.locale,
    recentIntents: input.history.intents,
    unclearStreak: input.history.unclearStreak,
    orders: orders0.map((o) => ({ number: o.order_number })),
    rfqs: rfqs0.map((r) => ({ title: r.title })),
    previousText: input.history.previousText ?? null,
    previousMessageId: input.history.previousMessageId ?? null,
  })
  let intent: SupportIntentOutput
  try {
    intent = await deps.classify(parts)
  } catch {
    // a refused / failed classification is an unclear turn, never a guess
    intent = { intent: 'other', as_role: null, order_ref: null, rfq_ref: null, how_to_topic: null, escalate: false, escalate_reason: null, ops_summary: null, language: input.locale }
  }
  const role = pickRole(intent, input.roles)
  const lookup = baseLookup(role)
  const refs: SupportTurnResult['lookupRefs'] = {}

  // 2. escalation decided by code from the classification + the streak.
  // "What can you help me with?" has no intent of its own: on a turn the model left unclear (and did not escalate),
  // a deterministic text match answers with the capabilities template instead, and the turn is not unclear.
  const capabilities = !intent.escalate && (intent.intent === 'other' || (intent.intent === 'how_to' && (intent.how_to_topic ?? 'other') === 'other')) && isSupportCapabilitiesQuestion(input.text)
  const unclear = intent.intent === 'other' && !capabilities
  const streak = unclear ? input.history.unclearStreak + 1 : 0
  const escalateReason = intent.escalate && intent.escalate_reason ? intent.escalate_reason : ESCALATING.includes(intent.intent) ? (intent.intent as string) : intent.escalate ? 'other' : unclear && streak >= deps.settings.escalateAfterTurns ? 'unclear_twice' : null
  if (escalateReason) return finish(role, intent, lookup, refs, streak, { reason: escalateReason, summary: intent.ops_summary }, 'escalated')

  // 3. resolve references through the lookups (the user's own data only)
  if (ORDER_INTENTS.includes(intent.intent) || (intent.intent === 'nudge_request' && normRef(intent.order_ref))) {
    const orders = role === defaultRole ? orders0 : await deps.lookups.listOrders(role).catch(() => [] as SupportOrderView[])
    lookup.orders_count = orders.length
    const ref = normRef(intent.order_ref)
    const order = !ref || ref.toLowerCase() === 'latest' ? (orders[0] ?? null) : ((orders.find((o) => o.order_number.toLowerCase() === ref.toLowerCase()) ?? (await deps.lookups.getOrder(ref, role).catch(() => null))) ?? null)
    lookup.order = order
    if (order) {
      refs.order_id = order.id
      const ns = await deps.lookups.nudgeState({ kind: 'order', id: order.id }, role).catch(() => ({ active: false, capped: true }))
      lookup.nudge_subject = { kind: 'order', id: order.id, ...ns }
    }
  }
  if (RFQ_INTENTS.includes(intent.intent) || (intent.intent === 'nudge_request' && !lookup.nudge_subject)) {
    const rfqs = role === defaultRole ? rfqs0 : await deps.lookups.listRfqs(role).catch(() => [] as SupportRfqView[])
    lookup.rfqs_count = rfqs.length
    const ref = normRef(intent.rfq_ref)
    const rfq = !ref || ref.toLowerCase() === 'latest' ? (rfqs[0] ?? null) : ((rfqs.find((r) => r.title.toLowerCase() === ref.toLowerCase()) ?? (await deps.lookups.getRfq(ref, role).catch(() => null))) ?? null)
    lookup.rfq = rfq
    if (rfq) {
      refs.rfq_id = rfq.id
      const ns = await deps.lookups.nudgeState({ kind: 'rfq', id: rfq.id }, role).catch(() => ({ active: false, capped: true }))
      lookup.nudge_subject = { kind: 'rfq', id: rfq.id, ...ns }
    }
  }
  if (intent.intent === 'how_to') lookup.how_to_topic = intent.how_to_topic ?? 'other'
  if (intent.intent === 'new_need') lookup.procurement_available = input.procurementAvailable === true && role === 'buyer'

  const forceKey: SupportReply['key'] | undefined = capabilities ? 'capabilities' : unclear && streak > 0 && input.history.unclearStreak > 0 ? 'unclear_again' : undefined
  return finish(role, intent, lookup, refs, streak, undefined, forceKey)
}
