import { describe, expect, it } from 'vitest'
import { compareQuotes, computeGstInclusiveOrderAmounts, computeOrderAmounts, quoteChargeAmounts, quotePreview, validUntilFromPreset, type CompareQuoteInput } from '../index'

const base = (gstIncluded: boolean | null, pricePaise = 4_500_00): CompareQuoteInput => ({ id: '11111111-1111-4111-8111-111111111111', kind: 'service', pricePaise, deliveryDays: 4, gstIncluded, transportIncluded: true, validUntil: null, advancePercent: 0 })

describe('E11 FR-11.4 — one number per quote (ADR-015 / ADR-017)', () => {
  for (const gst of [true, false, null] as const) {
    it(`gst_included = ${String(gst)}: preview total = compare normalised total = checkout charge`, () => {
      const commissionBps = 1000
      const preview = quotePreview({ pricePaise: 4_500_00, gstIncluded: gst, commissionBps })
      const [cmp] = compareQuotes([base(gst)], { today: '2026-09-23' })
      // checkout's quote branch, as written before the refactor (the rule it must keep)
      const checkout = gst === true
        ? computeGstInclusiveOrderAmounts({ grossPaise: 4_500_00, commissionBps })
        : computeOrderAmounts({ pricePaise: 4_500_00, discountBps: 0, commissionBps })
      expect(preview.totalPaise).toBe(cmp!.normalizedTotalPaise)
      expect(preview.totalPaise).toBe(checkout.totalPaise)
      expect(quoteChargeAmounts({ pricePaise: 4_500_00, gstIncluded: gst, commissionBps })).toEqual(checkout)
      // "You receive ≈" = taxable − commission at the current rate
      expect(preview.earningPaise).toBe(checkout.providerEarningPaise)
    })
  }
  it('the PRD example: ₹4,500 + 18 % = ₹5,310 all-in; you receive ₹4,050 at 10 %', () => {
    const p = quotePreview({ pricePaise: 4_500_00, gstIncluded: false, commissionBps: 1000 })
    expect(p).toMatchObject({ gstMode: 'extra', taxablePaise: 4_500_00, gstPaise: 810_00, totalPaise: 5_310_00, earningPaise: 4_050_00, payoutDaysAfterAcceptance: 2 })
  })
  it('validity presets are IST calendar days', () => {
    expect(validUntilFromPreset('2026-09-29', 3)).toBe('2026-10-02')
    expect(validUntilFromPreset('2026-12-30', 7)).toBe('2027-01-06')
  })
})
