import 'server-only'
import { PAYOUT_RELEASE_STATUSES, payoutAllowedWithRefund, type OrderStatus } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { getGoodsDossier } from '@/lib/mart/release'
import { getServicesEvidence } from '@/lib/orders/evidence'
import { paymentForOrder, refundForOrder } from './order-payment'
import { isSimulatedPayment, PAYMENT_SIMULATED } from './simulation'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/** ADR 027 (audit M20) — the chargeback webhooks and the order-event marker each records (hidden from the parties). */
export const CHARGEBACK_EVENTS = {
  'payment.dispute.created': 'chargeback_opened',
  'payment.dispute.lost': 'chargeback_lost',
  'payment.dispute.won': 'chargeback_won',
  'payment.dispute.closed': 'chargeback_closed',
} as const
export type ChargebackEvent = keyof typeof CHARGEBACK_EVENTS
const CHARGEBACK_MARKERS: string[] = Object.values(CHARGEBACK_EVENTS)

/**
 * Chargebacks the gateway opened on the order's payment and has not decided
 * yet (no lost / won / closed for the same dispute id). While one is open no
 * payout moves (`chargeback_open`); once decided, the held payout waits for an
 * explicit ops release.
 */
export async function openChargebacks(admin: Admin, orderId: string): Promise<string[]> {
  const { data } = await admin.from('order_events').select('event, payload').eq('order_id', orderId).in('event', CHARGEBACK_MARKERS)
  const open = new Set<string>()
  const decided = new Set<string>()
  for (const e of data ?? []) {
    const id = (e.payload as { razorpay_dispute_id?: string } | null)?.razorpay_dispute_id
    if (!id) continue
    if (e.event === CHARGEBACK_EVENTS['payment.dispute.created']) open.add(id)
    else decided.add(id)
  }
  return [...open].filter((id) => !decided.has(id))
}

/**
 * ADR 026 — the ONE run-time payout release rule. `runPayouts` applies it to
 * every payout it claims, so the daily cron, the admin release, dispute
 * settlement and the order-page retry all inherit it. Empty = money may move.
 *
 * - The order must be in PAYOUT_RELEASE_STATUSES (completed | resolved_release
 *   | resolved_partial). `disputed` is not, so an open dispute always blocks.
 * - ADR 027 (audit M2): never a real transfer for an order whose payment was
 *   simulated (`payment_simulated`) — the provider would be paid real money for
 *   an order nobody paid for.
 * - ADR 027 (audit L1): beside a refund, a plainly `completed` order pays out at
 *   most the provider's share of what the buyer kept (shared
 *   payoutAllowedWithRefund, the ADR-014 formula), else `refund_exists`. A
 *   `resolved_*` order's payout was planned by planDisputeSettlement, which saw
 *   the refund row.
 * - ADR 027 (audit M20): no payout while a chargeback on the payment is open.
 * - A plainly `completed` order must also clear its evidence gate: the goods
 *   release gate (delivery photo, receipt, return window, no open return), or
 *   the services evidence gate once its cutover is set.
 * - `resolved_*` orders skip the evidence gates: the dispute decision is the
 *   release authority there (ADR 014).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function payoutRunBlockers(
  admin: Admin,
  order: any | null,
  ctx: { payoutPaise?: number; gatewayIsReal?: boolean } = {},
): Promise<string[]> {
  if (!order) return ['order_missing']
  const status = order.status as OrderStatus
  if (!PAYOUT_RELEASE_STATUSES.includes(status)) return [`order_status:${status}`]

  const reasons: string[] = []
  const payment = await paymentForOrder<{ id: string; razorpay_payment_id: string | null; simulated: unknown }>(admin, order, 'id, razorpay_payment_id, simulated:webhook_payload->simulated')
  if (ctx.gatewayIsReal && isSimulatedPayment(payment)) reasons.push(PAYMENT_SIMULATED)
  if (payment && ctx.payoutPaise !== undefined) {
    const refund = await refundForOrder<{ amount_paise: number }>(admin, order, payment.id, 'amount_paise')
    const allowed = payoutAllowedWithRefund({
      orderStatus: status,
      totalPaise: Number(order.total_paise),
      earningPaise: Number(order.provider_earning_paise),
      payoutPaise: ctx.payoutPaise,
      refundPaise: Number(refund?.amount_paise ?? 0),
    })
    if (!allowed) reasons.push('refund_exists')
  }
  if (ctx.payoutPaise !== undefined && ctx.payoutPaise <= 0) reasons.push('nothing_to_pay')
  if ((await openChargebacks(admin, order.id)).length > 0) reasons.push('chargeback_open')
  if (status !== 'completed') return reasons

  if (order.kind === 'goods') {
    const goods = await getGoodsDossier(admin, order)
    return goods.gate.ok ? reasons : [...reasons, ...goods.gate.reasons]
  }
  const ev = await getServicesEvidence(admin, order)
  return ev.enforced && !ev.gate.ok ? [...reasons, ...ev.gate.reasons] : reasons
}
/* eslint-enable @typescript-eslint/no-explicit-any */
