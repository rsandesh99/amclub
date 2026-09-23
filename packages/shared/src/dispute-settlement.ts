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
