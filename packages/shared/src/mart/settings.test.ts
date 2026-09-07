import { describe, it, expect } from 'vitest'
import { MART_SETTING_KEYS, parseMartSetting, martSettingPutSchema, martCategoryPatchSchema } from './settings'

describe('mart settings registry (§9 config, never constants)', () => {
  it('declares every key the runtime reads', () => {
    for (const k of ['eway_bill_threshold_paise', 'auto_approve_after_listings', 'tds', 'goods_delivery_days', 'pool_payment_mode', 'pool_pay_window_hours', 'pool_order_model', 'pool_categories', 'pool_schedule_day_of_month', 'pool_open_limits']) {
      expect(MART_SETTING_KEYS).toContain(k)
    }
  })
  it('rejects unknown keys (closed registry)', () => {
    expect(parseMartSetting('razorpay_key', 'x').ok).toBe(false)
    expect(martSettingPutSchema.safeParse({ key: 'razorpay_key', value: 1 }).success).toBe(false)
  })
  it('validates per key', () => {
    expect(parseMartSetting('pool_payment_mode', 'block_capture').ok).toBe(true)
    expect(parseMartSetting('pool_payment_mode', 'upi_mandate').ok).toBe(false)
    expect(parseMartSetting('tds', { section: '194C', rate_bps: 100, threshold_paise: 3_000_000 }).ok).toBe(true)
    expect(parseMartSetting('tds', { section: '194C', rate_bps: 100 }).ok).toBe(false)
    expect(parseMartSetting('pool_categories', ['fasteners']).ok).toBe(true)
    expect(parseMartSetting('goods_delivery_days', 0).ok).toBe(false)
    expect(parseMartSetting('eway_bill_threshold_paise', 5_000_000).ok).toBe(true)
  })
  it('category patch is strict and non-empty', () => {
    expect(martCategoryPatchSchema.safeParse({}).success).toBe(false)
    expect(martCategoryPatchSchema.safeParse({ commission_bps: 6000 }).success).toBe(false)
    expect(martCategoryPatchSchema.safeParse({ return_window_hours: 72, return_freight_payer: 'seller' }).success).toBe(true)
    expect(martCategoryPatchSchema.safeParse({ slug: 'x' }).success).toBe(false)
  })
})
