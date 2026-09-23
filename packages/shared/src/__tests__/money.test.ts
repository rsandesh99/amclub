import { describe, it, expect } from 'vitest'
import {
  computeGstInclusiveOrderAmounts,
  computeOrderAmounts,
  computeRefundPaise,
  DEFAULT_GST_BPS,
} from '../money'

describe('computeOrderAmounts', () => {
  it('computes a no-discount order with 18% GST and 10% commission', () => {
    const a = computeOrderAmounts({ pricePaise: 1_99_900, discountBps: 0, commissionBps: 1000 })
    expect(a.pricePaise).toBe(199900)
    expect(a.discountPaise).toBe(0)
    expect(a.taxablePaise).toBe(199900)
    expect(a.gstPaise).toBe(Math.round((199900 * 1800) / 10000)) // 35982
    expect(a.gstPaise).toBe(35982)
    expect(a.totalPaise).toBe(199900 + 35982) // 235882
    expect(a.commissionPaise).toBe(19990) // 10% of taxable
    expect(a.providerEarningPaise).toBe(199900 - 19990) // 179910
  })

  it('applies discount before GST and commission', () => {
    const a = computeOrderAmounts({ pricePaise: 1_00_000, discountBps: 1000, commissionBps: 1200 })
    expect(a.discountPaise).toBe(10000) // 10%
    expect(a.taxablePaise).toBe(90000)
    expect(a.gstPaise).toBe(16200) // 18% of 90000
    expect(a.totalPaise).toBe(106200)
    expect(a.commissionPaise).toBe(10800) // 12% of 90000
    expect(a.providerEarningPaise).toBe(79200)
  })

  it('keeps the invariant: total = taxable + gst, earning = taxable − commission', () => {
    const a = computeOrderAmounts({ pricePaise: 7_77_777, discountBps: 333, commissionBps: 850 })
    expect(a.totalPaise).toBe(a.taxablePaise + a.gstPaise)
    expect(a.providerEarningPaise).toBe(a.taxablePaise - a.commissionPaise)
    expect(a.taxablePaise).toBe(a.pricePaise - a.discountPaise)
  })

  it('produces only integer paise (no floats)', () => {
    const a = computeOrderAmounts({ pricePaise: 100001, discountBps: 777, commissionBps: 999 })
    for (const v of Object.values(a)) expect(Number.isInteger(v)).toBe(true)
  })

  it('honours a custom GST rate', () => {
    const a = computeOrderAmounts({ pricePaise: 100000, discountBps: 0, commissionBps: 1000, gstBps: 0 })
    expect(a.gstPaise).toBe(0)
    expect(a.totalPaise).toBe(100000)
    expect(DEFAULT_GST_BPS).toBe(1800)
  })

  it('stacks a flat coupon after the percentage discount', () => {
    const a = computeOrderAmounts({
      pricePaise: 100_000,
      discountBps: 1000,
      commissionBps: 1000,
      extraDiscountPaise: 5_000,
    })
    expect(a.discountPaise).toBe(15_000) // 10,000 pkg + 5,000 coupon
    expect(a.taxablePaise).toBe(85_000)
  })

  it('clamps discounts so taxable never goes negative', () => {
    const a = computeOrderAmounts({
      pricePaise: 10_000,
      discountBps: 9000,
      commissionBps: 1000,
      extraDiscountPaise: 50_000,
    })
    expect(a.discountPaise).toBe(10_000)
    expect(a.taxablePaise).toBe(0)
    expect(a.totalPaise).toBe(0)
    expect(a.providerEarningPaise).toBe(0)
  })

  it('ignores a negative extra discount', () => {
    const a = computeOrderAmounts({
      pricePaise: 10_000,
      discountBps: 0,
      commissionBps: 1000,
      extraDiscountPaise: -5_000,
    })
    expect(a.discountPaise).toBe(0)
    expect(a.taxablePaise).toBe(10_000)
  })
})

describe('computeRefundPaise — policy matrix (§9.2)', () => {
  const total = 100000

  it('refunds 100% pre-accept (placed)', () => {
    expect(computeRefundPaise({ totalPaise: total, fromStatus: 'placed' })).toBe(100000)
  })

  it('refunds 100% when accepted but work not started', () => {
    expect(computeRefundPaise({ totalPaise: total, fromStatus: 'accepted' })).toBe(100000)
    expect(computeRefundPaise({ totalPaise: total, fromStatus: 'requirements_submitted' })).toBe(100000)
  })

  it('refunds 50% in_progress', () => {
    expect(computeRefundPaise({ totalPaise: total, fromStatus: 'in_progress' })).toBe(50000)
  })

  it('refunds 0% once delivered (dispute-only)', () => {
    expect(computeRefundPaise({ totalPaise: total, fromStatus: 'delivered' })).toBe(0)
  })

  it('dispute resolution: full → total, release → 0', () => {
    expect(computeRefundPaise({ totalPaise: total, fromStatus: 'disputed', resolution: 'refund_full' })).toBe(100000)
    expect(computeRefundPaise({ totalPaise: total, fromStatus: 'disputed', resolution: 'release' })).toBe(0)
  })

  it('dispute partial: clamps the resolution amount to [0, total]', () => {
    expect(
      computeRefundPaise({ totalPaise: total, fromStatus: 'disputed', resolution: 'refund_partial', resolutionAmountPaise: 30000 }),
    ).toBe(30000)
    expect(
      computeRefundPaise({ totalPaise: total, fromStatus: 'disputed', resolution: 'refund_partial', resolutionAmountPaise: 999999 }),
    ).toBe(100000)
    expect(
      computeRefundPaise({ totalPaise: total, fromStatus: 'disputed', resolution: 'refund_partial', resolutionAmountPaise: -5 }),
    ).toBe(0)
  })

  it('unknown/terminal status refunds nothing by default', () => {
    expect(computeRefundPaise({ totalPaise: total, fromStatus: 'completed' })).toBe(0)
  })
})

describe('computeGstInclusiveOrderAmounts — ADR-015 (quotes marked "GST included")', () => {
  it('₹11,800 incl. GST at 18 % → taxable ₹10,000, GST ₹1,800, buyer pays exactly ₹11,800', () => {
    const a = computeGstInclusiveOrderAmounts({ grossPaise: 11_800_00, commissionBps: 1000 })
    expect(a).toEqual({
      pricePaise: 10_000_00,
      discountPaise: 0,
      taxablePaise: 10_000_00,
      gstPaise: 1_800_00,
      totalPaise: 11_800_00,
      commissionBps: 1000,
      commissionPaise: 1_000_00,
      providerEarningPaise: 9_000_00,
    })
  })

  it('never charges more than the quoted figure (the bug: exclusive math on an inclusive price)', () => {
    const exclusive = computeOrderAmounts({ pricePaise: 11_800_00, discountBps: 0, commissionBps: 1000 })
    const inclusive = computeGstInclusiveOrderAmounts({ grossPaise: 11_800_00, commissionBps: 1000 })
    expect(exclusive.totalPaise).toBe(13_924_00)
    expect(inclusive.totalPaise).toBe(11_800_00)
  })

  it('an exclusive price and its inclusive gross give the same order', () => {
    const excl = computeOrderAmounts({ pricePaise: 10_000_00, discountBps: 0, commissionBps: 1200 })
    const incl = computeGstInclusiveOrderAmounts({ grossPaise: excl.totalPaise, commissionBps: 1200 })
    expect(incl).toEqual(excl)
  })

  it('invariants hold over a grid of odd amounts, rates and commissions', () => {
    for (const gross of [0, 1, 2, 99, 118, 12_345, 99_999, 2_35_882, 1_00_00_001]) {
      for (const gstBps of [0, 500, 1200, 1800, 2800]) {
        for (const commissionBps of [0, 500, 1000, 1500]) {
          const a = computeGstInclusiveOrderAmounts({ grossPaise: gross, commissionBps, gstBps })
          expect(a.totalPaise).toBe(gross)
          expect(a.taxablePaise + a.gstPaise).toBe(gross)
          expect(a.pricePaise).toBe(a.taxablePaise)
          expect(a.gstPaise).toBeGreaterThanOrEqual(0)
          expect(Math.abs(a.gstPaise - Math.round((a.taxablePaise * gstBps) / 10000))).toBeLessThanOrEqual(1)
          expect(a.commissionPaise + a.providerEarningPaise).toBe(a.taxablePaise)
          for (const v of Object.values(a)) expect(Number.isInteger(v)).toBe(true)
        }
      }
    }
  })
})
