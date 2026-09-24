import { describe, expect, it } from 'vitest'
import {
  addonIdsSchema,
  addonInvoiceLines,
  addonSelectionKey,
  computeOrderAmounts,
  couponBasePaise,
  packageAddonInputSchema,
  packageCharge,
  packageChargeDisplay,
  resolveAddonSelection,
  type PackageAddonRow,
} from '../index'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const fast: PackageAddonRow = { id: A, label_i18n: { en: 'Deliver 2 days faster' }, price_paise: 50_000, days_delta: -2, extra_revisions: 0 }
const rev: PackageAddonRow = { id: B, label_i18n: { en: 'One more revision', hi: 'एक और संशोधन' }, price_paise: 30_000, days_delta: 1, extra_revisions: 1 }

describe('packageCharge (ADR 019)', () => {
  it('is byte-identical to the pre-ADR call with no add-ons (with and without a coupon)', () => {
    for (const coupon of [0, 12_345]) {
      const c = packageCharge({ pricePaise: 500_000, discountBps: 1000, commissionBps: 1200, deliveryDays: 5, revisionCount: 1, addons: [], couponDiscountPaise: coupon })
      expect(c.amounts).toEqual(computeOrderAmounts({ pricePaise: 500_000, discountBps: 1000, commissionBps: 1200, extraDiscountPaise: coupon }))
      expect(c.deliveryDays).toBe(5)
      expect(c.revisionMax).toBe(1)
      expect(c.addons).toEqual([])
    }
  })

  it('adds add-ons at face value: the package discount applies to the package price only', () => {
    const c = packageCharge({ pricePaise: 500_000, discountBps: 1000, commissionBps: 1000, deliveryDays: 5, revisionCount: 1, addons: [fast, rev] })
    expect(c.amounts.pricePaise).toBe(580_000)
    expect(c.amounts.discountPaise).toBe(50_000) // 10 % of the package, not of the add-ons
    expect(c.amounts.taxablePaise).toBe(530_000) // 450,000 + 50,000 + 30,000
    expect(c.amounts.gstPaise).toBe(95_400)
    expect(c.amounts.totalPaise).toBe(625_400)
    expect(c.amounts.commissionPaise).toBe(53_000)
    expect(c.amounts.providerEarningPaise).toBe(477_000)
    expect(c.addonsPaise).toBe(80_000)
    expect(c.deliveryDays).toBe(4) // 5 − 2 + 1
    expect(c.revisionMax).toBe(2)
  })

  it('a coupon applies to the whole pre-GST subtotal', () => {
    const base = couponBasePaise({ pricePaise: 500_000, discountBps: 1000, addons: [fast] })
    expect(base).toBe(500_000)
    const c = packageCharge({ pricePaise: 500_000, discountBps: 1000, commissionBps: 1000, deliveryDays: 5, revisionCount: 1, addons: [fast], couponDiscountPaise: 20_000 })
    expect(c.amounts.discountPaise).toBe(70_000)
    expect(c.amounts.taxablePaise).toBe(480_000)
  })

  it('never lets delivery drop below one day; a null revision count counts as 0 once an add-on adds revisions', () => {
    const c = packageCharge({ pricePaise: 100_000, discountBps: 0, commissionBps: 1000, deliveryDays: 1, revisionCount: null, addons: [{ ...fast, days_delta: -5 }, { ...rev, days_delta: 0 }] })
    expect(c.deliveryDays).toBe(1)
    expect(c.revisionMax).toBe(1)
    const d = packageCharge({ pricePaise: 100_000, discountBps: 0, commissionBps: 1000, deliveryDays: 3, revisionCount: null, addons: [fast] })
    expect(d.revisionMax).toBeNull()
  })

  it('the display is the charge (the client renders it, never sums)', () => {
    const c = packageCharge({ pricePaise: 500_000, discountBps: 1000, commissionBps: 1000, deliveryDays: 5, revisionCount: 1, addons: [fast] })
    const d = packageChargeDisplay(c, { discountBps: 1000, buyerHasGstin: true })
    expect(d.totalPaise).toBe(c.amounts.totalPaise)
    expect(d.itcPaise).toBe(c.amounts.gstPaise)
    expect(d.discountPct).toBe(10)
  })

  it('invoice lines sum to the order price', () => {
    const c = packageCharge({ pricePaise: 500_000, discountBps: 1000, commissionBps: 1000, deliveryDays: 5, revisionCount: 1, addons: [fast, rev] })
    const lines = addonInvoiceLines({ title: 'GST filing', pricePaise: c.amounts.pricePaise }, c.addons)
    expect(lines.map((l) => l.paise)).toEqual([500_000, 50_000, 30_000])
    expect(lines.reduce((s, l) => s + l.paise, 0) - c.amounts.discountPaise + c.amounts.gstPaise).toBe(c.amounts.totalPaise)
  })
})

describe('selection and input', () => {
  it('resolves only active add-ons of this package; anything else is addon_changed', () => {
    expect(resolveAddonSelection([fast, rev], [B, A])).toEqual({ ok: true, rows: [fast, rev] })
    expect(resolveAddonSelection([fast], [A, B])).toEqual({ ok: false, code: 'addon_changed' })
    expect(resolveAddonSelection([], [A])).toEqual({ ok: false, code: 'addon_changed' })
    expect(resolveAddonSelection([fast], [])).toEqual({ ok: true, rows: [] })
  })

  it('the checkout selection is distinct and at most three', () => {
    expect(addonIdsSchema.safeParse([A, B, C]).success).toBe(true)
    expect(addonIdsSchema.safeParse([A, A]).success).toBe(false)
    expect(addonIdsSchema.safeParse([A, B, C, '44444444-4444-4444-8444-444444444444']).success).toBe(false)
    expect(addonSelectionKey([B, A])).toBe(addonSelectionKey([A, B]))
  })

  it('an add-on has a short label, a positive price and bounded days / revisions', () => {
    expect(packageAddonInputSchema.safeParse({ label_i18n: { en: 'Fast-track' }, price_paise: 50_000, days_delta: -2 }).success).toBe(true)
    expect(packageAddonInputSchema.safeParse({ label_i18n: { en: 'x'.repeat(41) }, price_paise: 50_000 }).success).toBe(false)
    expect(packageAddonInputSchema.safeParse({ label_i18n: { en: 'Free' }, price_paise: 0 }).success).toBe(false)
    expect(packageAddonInputSchema.safeParse({ label_i18n: { en: 'Too fast' }, price_paise: 1, days_delta: -31 }).success).toBe(false)
    expect(packageAddonInputSchema.safeParse({ label_i18n: { en: 'Revisions' }, price_paise: 1, extra_revisions: 6 }).success).toBe(false)
    expect(packageAddonInputSchema.safeParse({ label_i18n: { en: 'x' }, price_paise: 1, sneaky: true }).success).toBe(false)
  })
})
