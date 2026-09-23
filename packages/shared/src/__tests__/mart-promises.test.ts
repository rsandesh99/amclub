import { describe, expect, it } from 'vitest'
import {
  activePromiseBadges,
  effectiveReturnFreightPayer,
  goodsItcSplit,
  groupPastGoodsLines,
  martPromisesSchema,
  measurePromiseBreaches,
  nextReorderReminderAt,
  parseMartSetting,
  productInputSchema,
  returnAllowed,
  usualReorderIntervalDays,
} from '../index'

const H = 3_600_000
const placed = '2026-09-01T00:00:00.000Z'
const at = (hours: number) => new Date(Date.parse(placed) + hours * H).toISOString()

describe('mart promises (E16 N41)', () => {
  it('ships_48h: on time, late, missing, not yet due', () => {
    const base = { placedAt: placed, dispatchedAt: null, invoiceDocAt: null }
    expect(measurePromiseBreaches(['ships_48h'], { ...base, dispatchPhotoAt: at(47) }, new Date(at(100)))).toEqual([])
    const late = measurePromiseBreaches(['ships_48h'], { ...base, dispatchPhotoAt: at(50) }, new Date(at(100)))
    expect(late).toEqual([{ promise: 'ships_48h', detail: { reason: 'late', hours_late: 2, deadline: at(48) } }])
    expect(measurePromiseBreaches(['ships_48h'], { ...base, dispatchPhotoAt: null }, new Date(at(49)))[0]?.detail.reason).toBe('missing')
    expect(measurePromiseBreaches(['ships_48h'], { ...base, dispatchPhotoAt: null }, new Date(at(47)))).toEqual([])
    // Not promised → never measured.
    expect(measurePromiseBreaches([], { ...base, dispatchPhotoAt: null }, new Date(at(500)))).toEqual([])
  })

  it('gst_invoice_24h counts from the dispatch photo', () => {
    const t = { placedAt: placed, dispatchPhotoAt: at(10), dispatchedAt: at(10) }
    expect(measurePromiseBreaches(['gst_invoice_24h'], { ...t, invoiceDocAt: at(20) }, new Date(at(100)))).toEqual([])
    expect(measurePromiseBreaches(['gst_invoice_24h'], { ...t, invoiceDocAt: at(40) }, new Date(at(100)))[0]?.detail).toEqual({ reason: 'late', hours_late: 6, deadline: at(34) })
    expect(measurePromiseBreaches(['gst_invoice_24h'], { ...t, invoiceDocAt: null }, new Date(at(35)))[0]?.detail.reason).toBe('missing')
    expect(measurePromiseBreaches(['gst_invoice_24h'], { ...t, invoiceDocAt: null }, new Date(at(33)))).toEqual([])
    // Not dispatched yet → nothing to measure for the invoice.
    expect(measurePromiseBreaches(['gst_invoice_24h'], { placedAt: placed, dispatchPhotoAt: null, dispatchedAt: null, invoiceDocAt: null }, new Date(at(500)))).toEqual([])
  })

  it('badges drop at the breach limit; return shipping covered makes the seller pay freight', () => {
    expect(activePromiseBadges(['ships_48h', 'gst_invoice_24h'], { ships_48h: 3, gst_invoice_24h: 2 }, { count: 3 })).toEqual(['gst_invoice_24h'])
    expect(activePromiseBadges(['return_shipping_covered'], {}, { count: 1 })).toEqual(['return_shipping_covered'])
    expect(effectiveReturnFreightPayer('buyer', ['return_shipping_covered'])).toBe('seller')
    expect(effectiveReturnFreightPayer('split', [])).toBe('split')
  })

  it('schemas: promises unique and known; the breach limit is a registered setting', () => {
    expect(martPromisesSchema.safeParse(['ships_48h', 'ships_48h']).success).toBe(false)
    expect(martPromisesSchema.safeParse(['free_lunch']).success).toBe(false)
    const base = { category_slug: 'fasteners', name: 'Hex bolt M12', hsn_code: '7318', gst_rate_bps: 1800, unit: 'pcs', tiers: [{ min_qty: 1, unit_price_paise: 1000 }] }
    expect(productInputSchema.parse(base).promises).toEqual([])
    expect(parseMartSetting('promise_breach_limit', { count: 3, window_days: 90 }).ok).toBe(true)
    expect(parseMartSetting('promise_breach_limit', { count: 0, window_days: 90 }).ok).toBe(false)
  })
})

describe('non-returnable + ITC (E16 N43)', () => {
  it('non-returnable refuses quality / other, never damaged / wrong / short', () => {
    expect(returnAllowed(false, 'quality')).toBe(false)
    expect(returnAllowed(false, 'other')).toBe(false)
    for (const r of ['damaged', 'wrong_item', 'short_quantity']) expect(returnAllowed(false, r)).toBe(true)
    expect(returnAllowed(true, 'quality')).toBe(true)
  })

  it('ITC only on eligible lines; all eligible = the taxable value', () => {
    // taxable 10,000 + 1,800 GST and 5,000 + 1,400 GST; total 18,200.
    expect(goodsItcSplit([{ gstPaise: 1800, itcEligible: true }, { gstPaise: 1400, itcEligible: true }], 18_200)).toEqual({ itcPaise: 3200, afterItcPaise: 15_000 })
    expect(goodsItcSplit([{ gstPaise: 1800, itcEligible: true }, { gstPaise: 1400, itcEligible: false }], 18_200)).toEqual({ itcPaise: 1800, afterItcPaise: 16_400 })
    expect(goodsItcSplit([{ gstPaise: 1800, itcEligible: false }], 11_800)).toEqual({ itcPaise: 0, afterItcPaise: 11_800 })
  })
})

describe('samples + reorder (E16 N42 / N44)', () => {
  it('product input carries an optional sample price (default null)', () => {
    const base = { category_slug: 'fasteners', name: 'Hex bolt M12', hsn_code: '7318', gst_rate_bps: 1800, unit: 'pcs', tiers: [{ min_qty: 1, unit_price_paise: 1000 }] }
    expect(productInputSchema.parse(base).sample_price_paise).toBeNull()
    expect(productInputSchema.safeParse({ ...base, sample_price_paise: 0 }).success).toBe(false)
    expect(productInputSchema.parse({ ...base, sample_price_paise: 2500 }).sample_price_paise).toBe(2500)
  })

  it('usual interval = median gap, clamped; next reminder never in the past', () => {
    const d = (iso: string) => `${iso}T10:00:00.000Z`
    expect(usualReorderIntervalDays([d('2026-06-01')])).toBe(30)
    expect(usualReorderIntervalDays([d('2026-06-01'), d('2026-06-15'), d('2026-07-15'), d('2026-07-29')])).toBe(14)
    expect(usualReorderIntervalDays([d('2026-06-01'), d('2026-06-03')])).toBe(7)
    expect(usualReorderIntervalDays([d('2025-01-01'), d('2026-06-01')])).toBe(365)
    const now = new Date('2026-09-23T00:00:00.000Z')
    expect(nextReorderReminderAt('2026-09-10T00:00:00.000Z', 30, now)).toBe('2026-10-10T00:00:00.000Z')
    expect(nextReorderReminderAt('2026-01-10T00:00:00.000Z', 30, now)).toBe('2026-09-24T00:00:00.000Z')
  })

  it('groups past lines by listing, newest first; skips samples and quoted lines', () => {
    const lines = groupPastGoodsLines([
      { created_at: '2026-08-01T00:00:00Z', line_items: [{ product_id: 'a', name: 'Bolt', unit: 'pcs', qty: 100, tier_unit_price_paise: 400 }, { product_id: 'b', name: 'Sample', unit: 'pcs', qty: 1, tier_unit_price_paise: 900, sample: true }] },
      { created_at: '2026-09-01T00:00:00Z', line_items: [{ product_id: 'a', name: 'Bolt', unit: 'pcs', qty: 200, tier_unit_price_paise: 380, gst_rate_bps: 1800 }, { product_id: null, name: 'Custom', unit: 'pcs', qty: 5, tier_unit_price_paise: 5000 }] },
    ])
    expect(lines).toEqual([{ productId: 'a', name: 'Bolt', unit: 'pcs', lastQty: 200, lastUnitPricePaise: 380, gstRateBps: 1800, lastOrderedAt: '2026-09-01T00:00:00Z', orderedAt: ['2026-09-01T00:00:00Z', '2026-08-01T00:00:00Z'] }])
  })
})
