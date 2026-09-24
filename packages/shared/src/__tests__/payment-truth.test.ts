import { describe, it, expect } from 'vitest'
import { disputeSettlementPaise, payoutAllowedWithRefund, planManualRefund } from '../dispute-settlement'
import { computeOrderAmounts } from '../money'
import {
  CAPTURE_EXCEPTION_STATUSES,
  CAPTURE_EXCEPTION_TRANSITIONS,
  isValidCaptureExceptionTransition,
  isValidPayoutTransition,
  PAYOUT_STATUSES,
  REFUND_STATUSES,
  REFUND_TRANSITIONS,
  RFQ_LIVE_STATUSES,
  type PayoutStatus,
} from '../state-machines'

// ADR 027 — payment truth: webhooks settle refunds / transfers, a manual refund
// follows the ADR-014 planner, and a refund never goes out beside a full payout.

// ₹20,000 taxable at 5 % commission: total ₹23,600, earning ₹19,000.
const A = computeOrderAmounts({ pricePaise: 20_000_00, discountBps: 0, commissionBps: 500 })
const base = { totalPaise: A.totalPaise, earningPaise: A.providerEarningPaise }

describe('payout state machine — ADR 027', () => {
  it('a paid payout may only become failed (the gateway reported transfer.failed / reversed)', () => {
    for (const to of PAYOUT_STATUSES) {
      expect(isValidPayoutTransition('paid', to)).toBe(to === 'failed')
    }
  })
  it('a failed payout is retried only by rescheduling it', () => {
    expect(isValidPayoutTransition('failed', 'scheduled')).toBe(true)
    expect(isValidPayoutTransition('failed', 'paid')).toBe(false)
  })
})

describe('refund row statuses', () => {
  it('pending → processed | failed; a processed refund can still fail at the gateway; failed is terminal', () => {
    expect(REFUND_STATUSES).toEqual(['pending', 'processed', 'failed'])
    expect(REFUND_TRANSITIONS.pending).toEqual(['processed', 'failed'])
    expect(REFUND_TRANSITIONS.processed).toEqual(['failed'])
    expect(REFUND_TRANSITIONS.failed).toEqual([])
  })
})

describe('capture exception statuses', () => {
  it('every status has a transition entry and refunded is reached only through refunding', () => {
    for (const s of CAPTURE_EXCEPTION_STATUSES) expect(CAPTURE_EXCEPTION_TRANSITIONS[s]).toBeDefined()
    for (const s of CAPTURE_EXCEPTION_STATUSES) {
      expect(isValidCaptureExceptionTransition(s, 'refunded')).toBe(s === 'refunding')
    }
  })
  it('a failed refund can be claimed again; a stale claim can be re-claimed', () => {
    expect(isValidCaptureExceptionTransition('refund_failed', 'refunding')).toBe(true)
    expect(isValidCaptureExceptionTransition('refunding', 'refunding')).toBe(true)
    expect(isValidCaptureExceptionTransition('refund_pending', 'refunded')).toBe(false)
  })
})

describe('RFQ claim guard (M21)', () => {
  it('a paid quote order may claim only an open or quoted RFQ', () => {
    expect([...RFQ_LIVE_STATUSES]).toEqual(['open', 'quoted'])
  })
})

describe('planManualRefund — the ADR-014 rules for an admin manual refund (L1)', () => {
  const partial = 200_000
  const share = disputeSettlementPaise({ ...base, resolution: 'refund_partial', amountPaise: partial }).providerPaidPaise

  it('no payout row yet → refund, nothing to hold', () => {
    const p = planManualRefund({ ...base, amountPaise: partial, payout: null, refund: null })
    expect(p.ok && p.refund && p.payoutStep === 'schedule' && p.providerPaidPaise === share).toBe(true)
  })

  it('a payout no money has left for is rewritten to the provider’s share (then held by the caller)', () => {
    for (const status of ['scheduled', 'held', 'failed'] as PayoutStatus[]) {
      const p = planManualRefund({ ...base, amountPaise: partial, payout: { status, amountPaise: A.providerEarningPaise }, refund: null })
      expect(p.ok).toBe(true)
      if (p.ok) {
        expect(p.payoutStep).toBe('schedule')
        expect(p.providerPaidPaise).toBe(share)
        expect(p.refundPaise).toBe(partial)
      }
    }
  })

  it('a full refund voids the payout', () => {
    const p = planManualRefund({ ...base, amountPaise: A.totalPaise, payout: { status: 'held', amountPaise: A.providerEarningPaise }, refund: null })
    expect(p.ok && p.payoutStep === 'void' && p.providerPaidPaise === 0 && p.refundPaise === A.totalPaise).toBe(true)
  })

  it('a transfer in flight → payout_in_flight, even when the platform would absorb it', () => {
    for (const platformAbsorbs of [false, true]) {
      const p = planManualRefund({ ...base, amountPaise: partial, payout: { status: 'processing', amountPaise: A.providerEarningPaise }, refund: null, platformAbsorbs })
      expect(!p.ok && p.conflict === 'payout_in_flight').toBe(true)
    }
  })

  it('a paid payout → provider_already_paid; with platformAbsorbs the refund goes ahead and the payout is kept', () => {
    const paid = { status: 'paid' as PayoutStatus, amountPaise: A.providerEarningPaise }
    const refused = planManualRefund({ ...base, amountPaise: partial, payout: paid, refund: null })
    expect(!refused.ok && refused.conflict === 'provider_already_paid' && refused.existingPaise === A.providerEarningPaise).toBe(true)
    const absorbed = planManualRefund({ ...base, amountPaise: partial, payout: paid, refund: null, platformAbsorbs: true })
    expect(absorbed.ok && absorbed.payoutStep === 'keep' && absorbed.refund && absorbed.refundPaise === partial).toBe(true)
  })

  it('an existing refund row → refund_exists, with or without platformAbsorbs', () => {
    for (const payout of [null, { status: 'held' as PayoutStatus, amountPaise: 1 }, { status: 'paid' as PayoutStatus, amountPaise: A.providerEarningPaise }]) {
      for (const platformAbsorbs of [false, true]) {
        const p = planManualRefund({ ...base, amountPaise: partial, payout, refund: { amountPaise: 5 }, platformAbsorbs })
        if (payout?.status === 'paid' && !platformAbsorbs) expect(!p.ok && p.conflict === 'provider_already_paid').toBe(true)
        else expect(!p.ok && p.conflict === 'refund_exists' && p.existingPaise === 5).toBe(true)
      }
    }
  })
})

describe('payoutAllowedWithRefund — the release rule beside a refund (L1)', () => {
  const refund = 200_000
  const share = disputeSettlementPaise({ ...base, resolution: 'refund_partial', amountPaise: refund }).providerPaidPaise

  it('no refund → any payout', () => {
    expect(payoutAllowedWithRefund({ ...base, orderStatus: 'completed', payoutPaise: A.providerEarningPaise, refundPaise: 0 })).toBe(true)
  })
  it('completed + a refund → only up to the provider’s share of what the buyer kept', () => {
    expect(payoutAllowedWithRefund({ ...base, orderStatus: 'completed', payoutPaise: A.providerEarningPaise, refundPaise: refund })).toBe(false)
    expect(payoutAllowedWithRefund({ ...base, orderStatus: 'completed', payoutPaise: share, refundPaise: refund })).toBe(true)
    expect(payoutAllowedWithRefund({ ...base, orderStatus: 'completed', payoutPaise: share + 1, refundPaise: refund })).toBe(false)
  })
  it('a full refund leaves nothing for the provider', () => {
    expect(payoutAllowedWithRefund({ ...base, orderStatus: 'completed', payoutPaise: 1, refundPaise: A.totalPaise })).toBe(false)
  })
  it('a dispute resolution was planned beside the refund: its payout is allowed', () => {
    for (const orderStatus of ['resolved_release', 'resolved_partial']) {
      expect(payoutAllowedWithRefund({ ...base, orderStatus, payoutPaise: A.providerEarningPaise, refundPaise: refund })).toBe(true)
    }
  })
})
