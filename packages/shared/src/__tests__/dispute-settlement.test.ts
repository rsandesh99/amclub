import { describe, it, expect } from 'vitest'
import {
  disputeSettlementPaise,
  planDisputeSettlement,
  DISPUTE_SETTLEABLE_PAYOUT_STATUSES,
  DISPUTE_SETTLEMENT_CONFLICTS,
} from '../dispute-settlement'
import { computeOrderAmounts, type DisputeResolution } from '../money'
import { isValidPayoutTransition, PAYOUT_STATUSES, type PayoutStatus } from '../state-machines'

// The expression resolveDispute carried inline before ADR-014, pinned verbatim so
// the extraction can never drift from what already moved money.
function legacy(total: number, earning: number, resolution: DisputeResolution, amountPaise: number | undefined) {
  const refundPaise =
    resolution === 'refund_full' ? total : resolution === 'release' ? 0 : Math.max(0, Math.min(amountPaise ?? 0, total))
  const providerPaidPaise =
    resolution === 'release'
      ? earning
      : resolution === 'refund_full'
        ? 0
        : Math.round((earning * (total - refundPaise)) / Math.max(1, total))
  return { refundPaise, providerPaidPaise }
}

const RESOLUTIONS: DisputeResolution[] = ['refund_full', 'refund_partial', 'release']

// ₹20,000 taxable at 5 % commission: total ₹23,600, earning ₹19,000.
const A = computeOrderAmounts({ pricePaise: 20_000_00, discountBps: 0, commissionBps: 500 })
const base = { totalPaise: A.totalPaise, earningPaise: A.providerEarningPaise }

describe('disputeSettlementPaise — byte-identical to the pre-ADR-014 formula', () => {
  const orders = [
    { total: 1, earning: 1 },
    { total: 100, earning: 85 },
    { total: 2_358_82, earning: 1_799_10 },
    { total: A.totalPaise, earning: A.providerEarningPaise },
    { total: 999_999_99, earning: 812_345_67 },
  ]
  for (const o of orders) {
    const amounts = [undefined, 0, 1, Math.floor(o.total / 3), Math.floor(o.total / 2), o.total - 1, o.total, o.total + 1, -5]
    for (const resolution of RESOLUTIONS) {
      for (const amountPaise of amounts) {
        it(`total=${o.total} earning=${o.earning} ${resolution} amount=${String(amountPaise)}`, () => {
          expect(disputeSettlementPaise({ totalPaise: o.total, earningPaise: o.earning, resolution, amountPaise })).toEqual(
            legacy(o.total, o.earning, resolution, amountPaise),
          )
        })
      }
    }
  }

  it('worked example: ₹8,000 partial on a ₹23,600 order pays the provider 1,255,932 paise', () => {
    expect(base).toEqual({ totalPaise: 23_600_00, earningPaise: 19_000_00 })
    expect(disputeSettlementPaise({ ...base, resolution: 'refund_partial', amountPaise: 8_000_00 })).toEqual({
      refundPaise: 8_000_00,
      providerPaidPaise: 1_255_932,
    })
  })
})

describe('planDisputeSettlement — payout leg (H3: never pay twice)', () => {
  it('no payout row yet: release schedules the full earning, no refund', () => {
    expect(planDisputeSettlement({ ...base, resolution: 'release', payout: null, refund: null, resuming: false })).toEqual({
      ok: true,
      refundPaise: 0,
      providerPaidPaise: 19_000_00,
      payoutStep: 'schedule',
      refund: false,
    })
  })

  it('no payout row yet: refund_full owes the provider nothing and refunds the total', () => {
    const plan = planDisputeSettlement({ ...base, resolution: 'refund_full', payout: null, refund: null, resuming: false })
    expect(plan).toMatchObject({ ok: true, payoutStep: 'none', refund: true, refundPaise: 23_600_00, providerPaidPaise: 0 })
  })

  it('a held payout (the normal case: dispute holds it) is rescheduled at the settlement', () => {
    const plan = planDisputeSettlement({
      ...base,
      resolution: 'refund_partial',
      amountPaise: 8_000_00,
      payout: { status: 'held', amountPaise: 19_000_00 },
      refund: null,
      resuming: false,
    })
    expect(plan).toMatchObject({ ok: true, payoutStep: 'schedule', providerPaidPaise: 1_255_932, refund: true })
  })

  it('a failed transfer is retried at the settlement', () => {
    const plan = planDisputeSettlement({ ...base, resolution: 'release', payout: { status: 'failed', amountPaise: 19_000_00 }, refund: null, resuming: false })
    expect(plan).toMatchObject({ ok: true, payoutStep: 'schedule' })
  })

  it('refund_full voids a settleable payout', () => {
    for (const status of DISPUTE_SETTLEABLE_PAYOUT_STATUSES) {
      const plan = planDisputeSettlement({ ...base, resolution: 'refund_full', payout: { status, amountPaise: 19_000_00 }, refund: null, resuming: false })
      expect(plan).toMatchObject({ ok: true, payoutStep: 'void' })
    }
  })

  it('a transfer in flight refuses every resolution', () => {
    for (const resolution of RESOLUTIONS) {
      const plan = planDisputeSettlement({ ...base, resolution, amountPaise: 1_000_00, payout: { status: 'processing', amountPaise: 19_000_00 }, refund: null, resuming: false })
      expect(plan).toMatchObject({ ok: false, conflict: 'payout_in_flight', existingPaise: 19_000_00 })
    }
  })

  it('release on an already-paid order keeps the payout and moves nothing (the double-pay bug)', () => {
    const plan = planDisputeSettlement({ ...base, resolution: 'release', payout: { status: 'paid', amountPaise: 19_000_00 }, refund: null, resuming: false })
    expect(plan).toEqual({ ok: true, refundPaise: 0, providerPaidPaise: 19_000_00, payoutStep: 'keep', refund: false })
  })

  it('refund_partial on an already-paid order is refused: the provider was paid more than the settlement', () => {
    const plan = planDisputeSettlement({
      ...base,
      resolution: 'refund_partial',
      amountPaise: 8_000_00,
      payout: { status: 'paid', amountPaise: 19_000_00 },
      refund: null,
      resuming: false,
    })
    expect(plan).toEqual({ ok: false, conflict: 'provider_already_paid', refundPaise: 8_000_00, providerPaidPaise: 1_255_932, existingPaise: 19_000_00 })
  })

  it('refund_full on an already-paid order is refused and never rewrites the paid row', () => {
    const plan = planDisputeSettlement({ ...base, resolution: 'refund_full', payout: { status: 'paid', amountPaise: 19_000_00 }, refund: null, resuming: false })
    expect(plan).toMatchObject({ ok: false, conflict: 'provider_already_paid', existingPaise: 19_000_00 })
  })

  it('a resumed partial whose payout already went out at the settlement keeps it', () => {
    const plan = planDisputeSettlement({
      ...base,
      resolution: 'refund_partial',
      amountPaise: 8_000_00,
      payout: { status: 'paid', amountPaise: 1_255_932 },
      refund: { amountPaise: 8_000_00 },
      resuming: true,
    })
    expect(plan).toMatchObject({ ok: true, payoutStep: 'keep', refund: true })
  })

  it('never plans a write to a paid or in-flight payout, over the whole grid', () => {
    for (const status of PAYOUT_STATUSES) {
      for (const resolution of RESOLUTIONS) {
        for (const amountPaise of [0, 1_000_00, 8_000_00, 23_600_00]) {
          for (const paid of [0, 1_255_932, 19_000_00]) {
            for (const resuming of [false, true]) {
              const plan = planDisputeSettlement({ ...base, resolution, amountPaise, payout: { status, amountPaise: paid }, refund: null, resuming })
              if (status === 'paid' || status === 'processing') {
                expect(plan.ok && (plan.payoutStep === 'schedule' || plan.payoutStep === 'void')).toBe(false)
              }
            }
          }
        }
      }
    }
  })

  it('every schedule step is a legal payout transition (or already scheduled)', () => {
    for (const status of DISPUTE_SETTLEABLE_PAYOUT_STATUSES) {
      expect(status === 'scheduled' || isValidPayoutTransition(status, 'scheduled')).toBe(true)
    }
    const settleable = new Set<PayoutStatus>(DISPUTE_SETTLEABLE_PAYOUT_STATUSES)
    expect(settleable.has('paid')).toBe(false)
    expect(settleable.has('processing')).toBe(false)
  })
})

describe('planDisputeSettlement — refund leg (H4: one refund row, never a silent no-op)', () => {
  it('an earlier refund on the order refuses a refunding resolution', () => {
    for (const resolution of ['refund_full', 'refund_partial'] as const) {
      const plan = planDisputeSettlement({
        ...base,
        resolution,
        amountPaise: 8_000_00,
        payout: { status: 'held', amountPaise: 19_000_00 },
        refund: { amountPaise: 3_000_00 },
        resuming: false,
      })
      expect(plan).toMatchObject({ ok: false, conflict: 'refund_exists', existingPaise: 3_000_00 })
    }
  })

  it('an earlier refund with the SAME amount is still refused unless resuming (it is not this resolution’s)', () => {
    const plan = planDisputeSettlement({
      ...base,
      resolution: 'refund_partial',
      amountPaise: 8_000_00,
      payout: { status: 'held', amountPaise: 19_000_00 },
      refund: { amountPaise: 8_000_00 },
      resuming: false,
    })
    expect(plan).toMatchObject({ ok: false, conflict: 'refund_exists' })
  })

  it('release with an earlier refund refunds nothing more and is allowed', () => {
    const plan = planDisputeSettlement({ ...base, resolution: 'release', payout: { status: 'held', amountPaise: 19_000_00 }, refund: { amountPaise: 3_000_00 }, resuming: false })
    expect(plan).toMatchObject({ ok: true, refund: false, refundPaise: 0, payoutStep: 'schedule' })
  })

  it('a resumed attempt completes its own refund row', () => {
    const plan = planDisputeSettlement({
      ...base,
      resolution: 'refund_partial',
      amountPaise: 8_000_00,
      payout: { status: 'scheduled', amountPaise: 1_255_932 },
      refund: { amountPaise: 8_000_00 },
      resuming: true,
    })
    expect(plan).toMatchObject({ ok: true, refund: true, payoutStep: 'schedule' })
  })

  it('a resumed attempt with a different refund amount is refused', () => {
    const plan = planDisputeSettlement({
      ...base,
      resolution: 'refund_partial',
      amountPaise: 9_000_00,
      payout: null,
      refund: { amountPaise: 8_000_00 },
      resuming: true,
    })
    expect(plan).toMatchObject({ ok: false, conflict: 'refund_exists', existingPaise: 8_000_00 })
  })

  it('conflict codes are the closed list the API and console use', () => {
    expect([...DISPUTE_SETTLEMENT_CONFLICTS]).toEqual(['provider_already_paid', 'payout_in_flight', 'refund_exists'])
  })
})
