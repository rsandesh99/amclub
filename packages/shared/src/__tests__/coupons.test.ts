import { describe, expect, it } from 'vitest'
import { COUPON_CLAIM_RESULTS, adminCouponCreateSchema, couponClaimHeld, isCouponClaimResult, perBuyerLimitReached } from '../index'

const base = {
  code: ' welcome10 ',
  kind: 'percent' as const,
  value: 10,
  validFrom: '2026-09-24T00:00:00.000Z',
  validTo: '2026-10-24T00:00:00.000Z',
}

describe('coupons (audit M10, ADR 029)', () => {
  it('admin schema: code upper-cased, limits optional, per-buyer limit a positive integer', () => {
    const ok = adminCouponCreateSchema.parse({ ...base, usageLimit: 100, perBuyerLimit: 1 })
    expect(ok.code).toBe('WELCOME10')
    expect(ok.perBuyerLimit).toBe(1)
    expect(adminCouponCreateSchema.parse(base).perBuyerLimit).toBeUndefined()
    expect(adminCouponCreateSchema.safeParse({ ...base, perBuyerLimit: 0 }).success).toBe(false)
    expect(adminCouponCreateSchema.safeParse({ ...base, perBuyerLimit: 1.5 }).success).toBe(false)
  })

  it('admin schema: a percent above 100 or a per-buyer limit above the total is refused', () => {
    expect(adminCouponCreateSchema.safeParse({ ...base, value: 101 }).success).toBe(false)
    expect(adminCouponCreateSchema.safeParse({ ...base, kind: 'fixed', value: 500 }).success).toBe(true)
    expect(adminCouponCreateSchema.safeParse({ ...base, usageLimit: 2, perBuyerLimit: 3 }).success).toBe(false)
    expect(adminCouponCreateSchema.safeParse({ ...base, usageLimit: 3, perBuyerLimit: 3 }).success).toBe(true)
  })

  it('claim answers: only a claim (or its replay) holds a use', () => {
    expect(COUPON_CLAIM_RESULTS.filter(couponClaimHeld)).toEqual(['claimed', 'already_claimed'])
    expect(isCouponClaimResult('usage_exceeded')).toBe(true)
    expect(isCouponClaimResult('ok')).toBe(false)
    expect(isCouponClaimResult(null)).toBe(false)
  })

  it('per-buyer rule: null is unlimited; the limit is reached at equality', () => {
    expect(perBuyerLimitReached(null, 50)).toBe(false)
    expect(perBuyerLimitReached(undefined, 50)).toBe(false)
    expect(perBuyerLimitReached(1, 0)).toBe(false)
    expect(perBuyerLimitReached(1, 1)).toBe(true)
    expect(perBuyerLimitReached(3, 2)).toBe(false)
  })
})
