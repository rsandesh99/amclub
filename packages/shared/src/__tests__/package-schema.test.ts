import { describe, expect, it } from 'vitest'
import { packageSchema, PACKAGE_MAX_DISCOUNT_BPS, PACKAGE_MAX_MEMBER_DISCOUNT_BPS } from '../schemas/index'
import { priceDisplay } from '../price-display'

// The partner package routes (POST / PATCH /api/v1/partner/packages) validate with this schema;
// the listing wizard reads the same bounds for its inline errors (QA F3: "150 % off" → ₹0 preview).
const base = {
  category_slug: 'tax-accounting',
  title: 'GST return filing (monthly)',
  scope_included: ['GSTR-1 and GSTR-3B'],
  deliverables: ['Filing acknowledgement'],
  price_paise: 123456700,
  delivery_days: 7,
}

describe('packageSchema discount bounds', () => {
  it('accepts 0 % and the maximum discount', () => {
    expect(packageSchema.safeParse({ ...base, discount_bps: 0 }).success).toBe(true)
    expect(packageSchema.safeParse({ ...base, discount_bps: PACKAGE_MAX_DISCOUNT_BPS }).success).toBe(true)
  })

  it('refuses a discount above the maximum (150 % off) or below zero', () => {
    expect(packageSchema.safeParse({ ...base, discount_bps: 15000 }).success).toBe(false)
    expect(packageSchema.safeParse({ ...base, discount_bps: PACKAGE_MAX_DISCOUNT_BPS + 1 }).success).toBe(false)
    expect(packageSchema.safeParse({ ...base, discount_bps: -100 }).success).toBe(false)
  })

  it('refuses a non-integer or NaN discount', () => {
    expect(packageSchema.safeParse({ ...base, discount_bps: 1250.5 }).success).toBe(false)
    expect(packageSchema.safeParse({ ...base, discount_bps: Number.NaN }).success).toBe(false)
  })

  it('bounds the member extra discount too', () => {
    expect(packageSchema.safeParse({ ...base, member_extra_discount_bps: PACKAGE_MAX_MEMBER_DISCOUNT_BPS }).success).toBe(true)
    expect(packageSchema.safeParse({ ...base, member_extra_discount_bps: PACKAGE_MAX_MEMBER_DISCOUNT_BPS + 1 }).success).toBe(false)
  })

  it('every accepted discount leaves the buyer a positive price', () => {
    const d = priceDisplay({ pricePaise: base.price_paise, discountBps: PACKAGE_MAX_DISCOUNT_BPS })
    expect(d.totalPaise).toBeGreaterThan(0)
    expect(d.taxablePaise).toBeGreaterThan(0)
  })
})
