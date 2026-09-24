import { describe, expect, it } from 'vitest'
import { bundleMilestonesSchema, bundlePlan, bundlePlanSnapshot, bundlePlanSnapshotSchema, bundleProblems, computeOrderAmounts, isUnstartedChild, splitByShares, type BundleMilestoneRow } from '../index'

const ms: BundleMilestoneRow[] = [
  { seq: 1, label_i18n: { en: 'GST registration' }, due_offset_days: 15, share_bps: 4000 },
  { seq: 2, label_i18n: { en: 'Month 1 returns' }, due_offset_days: 45, share_bps: 3000 },
  { seq: 3, label_i18n: { en: 'Month 2 returns' }, due_offset_days: 75, share_bps: 3000 },
]

describe('bundles (ADR 021)', () => {
  it('splits exactly: the last part takes the remainder', () => {
    expect(splitByShares(100_001, [3333, 3333, 3334])).toEqual([33_330, 33_330, 33_341])
    expect(splitByShares(0, [5000, 5000])).toEqual([0, 0])
  })

  it('every column of the children sums to the whole, and each child is internally consistent', () => {
    for (const price of [999_999, 1_234_567, 500_000]) {
      const whole = computeOrderAmounts({ pricePaise: price, discountBps: 1250, commissionBps: 1100, extraDiscountPaise: 777 })
      const plan = bundlePlan(whole, ms)
      const sum = (k: keyof (typeof plan)[number]['amounts']) => plan.reduce((s, c) => s + c.amounts[k], 0)
      expect(sum('pricePaise')).toBe(whole.pricePaise)
      expect(sum('discountPaise')).toBe(whole.discountPaise)
      expect(sum('gstPaise')).toBe(whole.gstPaise)
      expect(sum('totalPaise')).toBe(whole.totalPaise)
      expect(sum('commissionPaise')).toBe(whole.commissionPaise)
      expect(sum('providerEarningPaise')).toBe(whole.providerEarningPaise)
      for (const c of plan) {
        expect(c.amounts.taxablePaise).toBe(c.amounts.pricePaise - c.amounts.discountPaise)
        expect(c.amounts.totalPaise).toBe(c.amounts.taxablePaise + c.amounts.gstPaise)
        expect(c.amounts.providerEarningPaise).toBe(c.amounts.taxablePaise - c.amounts.commissionPaise)
      }
    }
  })

  it('children start when the previous milestone is due; delivery is the gap', () => {
    const plan = bundlePlan(computeOrderAmounts({ pricePaise: 300_000, discountBps: 0, commissionBps: 1000 }), ms)
    expect(plan.map((c) => [c.startsOffsetDays, c.deliveryDays])).toEqual([[0, 15], [15, 30], [45, 30]])
    expect(bundlePlanSnapshotSchema.safeParse(bundlePlanSnapshot(plan)).success).toBe(true)
  })

  it('milestones: 2–6, shares sum to 10,000, offsets strictly increase, ≤ 92 days', () => {
    const input = ms.map((m) => ({ label_i18n: m.label_i18n, due_offset_days: m.due_offset_days, share_bps: m.share_bps }))
    expect(bundleMilestonesSchema.safeParse(input).success).toBe(true)
    expect(bundleProblems([{ due_offset_days: 10, share_bps: 5000 }, { due_offset_days: 10, share_bps: 4000 }])).toEqual(['shares_not_10000', 'offsets_not_increasing'])
    expect(bundleMilestonesSchema.safeParse([input[0]]).success).toBe(false)
    expect(bundleMilestonesSchema.safeParse([{ ...input[0], due_offset_days: 93 }, input[1]]).success).toBe(false)
  })

  it('unstarted = placed or accepted (the existing 100 % refund policy)', () => {
    expect(['placed', 'accepted', 'requirements_submitted', 'in_progress', 'completed'].map(isUnstartedChild)).toEqual([true, true, false, false, false])
  })
})
