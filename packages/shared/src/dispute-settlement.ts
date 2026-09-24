// ADR-014 — dispute settlement safety. The ONE place that decides what a
// dispute resolution may do to the order's payout row and refund row, given
// what already happened to them. Pure: `resolveDispute` (apps/web) reads the
// rows, asks this plan, and only then moves money.
//
// Two defects this closes (2026-09-23 code read):
//  • H3 — a dispute on a completed order whose payout was already PAID reset the
//    payout to 'scheduled' (PAYOUT_TRANSITIONS.paid is []), and runPayouts then
//    transferred the provider a second time.
//  • H4 — processRefund keeps ONE refund row per payment; an earlier refund
//    (cancellation or admin manual refund) made a later dispute refund a silent
//    no-op while the dispute was recorded as refunded.

import type { DisputeResolution } from './money'
import type { PayoutStatus } from './state-machines'

/**
 * The settlement formula `resolveDispute` has used since Phase 7, unchanged:
 *   • refund_full    → buyer refunded total; provider paid 0
 *   • release        → buyer refunded 0; provider paid the full earning
 *   • refund_partial → buyer refunded `amountPaise` (clamped to [0, total]);
 *                      provider paid round(earning × (total − refund) / total)
 */
export function disputeSettlementPaise(p: {
  totalPaise: number
  earningPaise: number
  resolution: DisputeResolution
  amountPaise?: number | undefined
}): { refundPaise: number; providerPaidPaise: number } {
  const total = p.totalPaise
  const earning = p.earningPaise
  const refundPaise =
    p.resolution === 'refund_full'
      ? total
      : p.resolution === 'release'
        ? 0
        : Math.max(0, Math.min(p.amountPaise ?? 0, total))
  const providerPaidPaise =
    p.resolution === 'release'
      ? earning
      : p.resolution === 'refund_full'
        ? 0
        : Math.round((earning * (total - refundPaise)) / Math.max(1, total))
  return { refundPaise, providerPaidPaise }
}

/** Payout statuses a dispute settlement may rewrite: no money has left for them.
 *  `paid` is terminal and `processing` is a transfer in flight — never touched. */
export const DISPUTE_SETTLEABLE_PAYOUT_STATUSES: readonly PayoutStatus[] = ['scheduled', 'held', 'failed']

/** Why a resolution is refused before any money moves (HTTP 409 codes). */
export const DISPUTE_SETTLEMENT_CONFLICTS = ['provider_already_paid', 'payout_in_flight', 'refund_exists'] as const
export type DisputeSettlementConflict = (typeof DISPUTE_SETTLEMENT_CONFLICTS)[number]

/**
 * What to do with the payout row:
 *  • none     — no row and nothing owed
 *  • schedule — create or rewrite a settleable row to the settlement amount, then transfer
 *  • void     — neutralise a settleable row (refund_full: provider owed nothing)
 *  • keep     — the row is already paid at exactly the settlement amount; move nothing
 */
export type DisputePayoutStep = 'none' | 'schedule' | 'void' | 'keep'

export type DisputeSettlementPlan =
  | {
      ok: true
      refundPaise: number
      providerPaidPaise: number
      payoutStep: DisputePayoutStep
      /** True when processRefund must run (it creates the row, or completes/returns the resumed one). */
      refund: boolean
    }
  | {
      ok: false
      conflict: DisputeSettlementConflict
      refundPaise: number
      providerPaidPaise: number
      /** The amount already on the conflicting row (payout or refund), in paise. */
      existingPaise: number
    }

export function planDisputeSettlement(p: {
  totalPaise: number
  earningPaise: number
  resolution: DisputeResolution
  amountPaise?: number | undefined
  /** The order's payout row, if any. */
  payout: { status: PayoutStatus; amountPaise: number } | null
  /** The order's single refund row, if any (any status). */
  refund: { amountPaise: number } | null
  /**
   * True when an earlier attempt of THIS resolution already claimed the order
   * (order status = the resolution's status) and stopped before finishing. Its
   * own rows are then expected and completed, not treated as conflicts.
   */
  resuming: boolean
}): DisputeSettlementPlan {
  const { refundPaise, providerPaidPaise } = disputeSettlementPaise(p)
  const refuse = (conflict: DisputeSettlementConflict, existingPaise: number): DisputeSettlementPlan => ({
    ok: false,
    conflict,
    refundPaise,
    providerPaidPaise,
    existingPaise,
  })

  // Payout leg (H3). Money that already left is never re-sent or rewritten.
  let payoutStep: DisputePayoutStep
  const payout = p.payout
  if (!payout) {
    payoutStep = providerPaidPaise > 0 ? 'schedule' : 'none'
  } else if (payout.status === 'processing') {
    return refuse('payout_in_flight', payout.amountPaise)
  } else if (payout.status === 'paid') {
    // Paid exactly what this resolution settles → nothing to do. Anything else
    // would need a second transfer or a clawback; neither exists (ADR-014 §2).
    if (payout.amountPaise !== providerPaidPaise) return refuse('provider_already_paid', payout.amountPaise)
    payoutStep = 'keep'
  } else {
    payoutStep = providerPaidPaise > 0 ? 'schedule' : 'void'
  }

  // Refund leg (H4). One refund row per order: an existing row is a conflict
  // unless it is this resolution's own row from an interrupted attempt.
  let refund = false
  if (refundPaise > 0) {
    if (p.refund) {
      if (!p.resuming || p.refund.amountPaise !== refundPaise) return refuse('refund_exists', p.refund.amountPaise)
    }
    refund = true
  }

  return { ok: true, refundPaise, providerPaidPaise, payoutStep, refund }
}

// ── ADR 027 (audit L1) — an admin manual refund follows the same rules ────────

/**
 * An admin manual refund of `amountPaise` is planned exactly like a dispute
 * resolution that refunds that amount (`refund_full` when it is the whole
 * total, otherwise `refund_partial`), so a refund and a full payout can never
 * both go out:
 *  • a `processing` payout (transfer in flight) → `payout_in_flight`;
 *  • a `paid` payout at any other amount than the settlement → `provider_already_paid`,
 *    unless `platformAbsorbs` — the founder's explicit ADR-014 §2 interim path
 *    (refund the buyer from the platform's own balance; the paid payout is kept);
 *  • an existing refund row → `refund_exists`.
 * On success `payoutStep` says what the caller does with the payout row in the
 * same audited action: `schedule` = rewrite it to `providerPaidPaise` and HOLD it
 * (it never moves without a later release), `void` = the provider is owed nothing,
 * `keep` / `none` = leave it.
 */
export function planManualRefund(p: {
  totalPaise: number
  earningPaise: number
  amountPaise: number
  payout: { status: PayoutStatus; amountPaise: number } | null
  refund: { amountPaise: number } | null
  platformAbsorbs?: boolean
}): DisputeSettlementPlan {
  const resolution: DisputeResolution = p.amountPaise >= p.totalPaise ? 'refund_full' : 'refund_partial'
  const plan = planDisputeSettlement({
    totalPaise: p.totalPaise,
    earningPaise: p.earningPaise,
    resolution,
    amountPaise: p.amountPaise,
    payout: p.payout,
    refund: p.refund,
    resuming: false,
  })
  if (plan.ok || plan.conflict !== 'provider_already_paid' || !p.platformAbsorbs) return plan
  // Paid already and the founder chose to absorb the refund: keep the payout; the one-refund-row rule still holds.
  if (p.refund) return { ok: false, conflict: 'refund_exists', refundPaise: plan.refundPaise, providerPaidPaise: plan.providerPaidPaise, existingPaise: p.refund.amountPaise }
  return { ok: true, refundPaise: plan.refundPaise, providerPaidPaise: plan.providerPaidPaise, payoutStep: 'keep', refund: plan.refundPaise > 0 }
}

/**
 * ADR 027 (audit L1) — may a payout of `payoutPaise` leave for an order that
 * also carries a refund of `refundPaise`? The run-time release rule
 * (`payoutRunBlockers`) asks this for every claimed payout.
 *  • A dispute resolution (`resolved_release` / `resolved_partial`) was already
 *    planned by `planDisputeSettlement`, which saw the refund row: allowed.
 *  • Otherwise (a plainly `completed` order) only up to the provider's share of
 *    what the buyer kept — the formula a `refund_partial` resolution uses — so a
 *    refund and a full payout never both go out.
 */
export function payoutAllowedWithRefund(p: {
  orderStatus: string
  totalPaise: number
  earningPaise: number
  payoutPaise: number
  refundPaise: number
}): boolean {
  if (p.refundPaise <= 0) return true
  if (p.orderStatus === 'resolved_release' || p.orderStatus === 'resolved_partial') return true
  const { providerPaidPaise } = disputeSettlementPaise({
    totalPaise: p.totalPaise,
    earningPaise: p.earningPaise,
    resolution: p.refundPaise >= p.totalPaise ? 'refund_full' : 'refund_partial',
    amountPaise: p.refundPaise,
  })
  return p.payoutPaise <= providerPaidPaise
}
