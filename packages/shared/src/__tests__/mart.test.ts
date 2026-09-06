import { describe, it, expect } from 'vitest'
import {
  PRODUCT_STATUSES,
  PRODUCT_TRANSITIONS,
  isValidProductTransition,
  priceTiersSchema,
  productInputSchema,
  hsnCodeSchema,
  gstRateBpsSchema,
  resolveTier,
  computeGoodsOrderAmounts,
  effectiveCostAfterItcPaise,
  evaluateGoodsReleaseGate,
  goodsCheckoutSchema,
  POOL_STATUSES,
  POOL_TRANSITIONS,
  assertPoolTransition,
  PoolTransitionError,
  mayCapturePoolMember,
  poolCloseOutcome,
  isValidPoolMemberPaymentTransition,
  aiDecisionCorrectedFields,
  MART_CATEGORY_SEED,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  isValidOrderTransition,
} from '../index'

describe('product state machine', () => {
  it('is exhaustive — every status has a transition entry', () => {
    for (const s of PRODUCT_STATUSES) expect(PRODUCT_TRANSITIONS[s]).toBeDefined()
  })
  it('draft → pending_approval → active → suspended → active', () => {
    expect(isValidProductTransition('draft', 'pending_approval')).toBe(true)
    expect(isValidProductTransition('pending_approval', 'active')).toBe(true)
    expect(isValidProductTransition('pending_approval', 'draft')).toBe(true)
    expect(isValidProductTransition('active', 'suspended')).toBe(true)
    expect(isValidProductTransition('suspended', 'active')).toBe(true)
  })
  it('rejects a seller skipping approval', () => {
    expect(isValidProductTransition('draft', 'active')).toBe(false)
    expect(isValidProductTransition('suspended', 'pending_approval')).toBe(false)
  })
})

describe('catalog validation', () => {
  it('HSN is 4/6/8 digits', () => {
    expect(hsnCodeSchema.safeParse('7318').success).toBe(true)
    expect(hsnCodeSchema.safeParse('731815').success).toBe(true)
    expect(hsnCodeSchema.safeParse('73181500').success).toBe(true)
    expect(hsnCodeSchema.safeParse('73181').success).toBe(false)
    expect(hsnCodeSchema.safeParse('ABCD').success).toBe(false)
  })
  it('GST rate is a real slab in bps', () => {
    expect(gstRateBpsSchema.safeParse(1800).success).toBe(true)
    expect(gstRateBpsSchema.safeParse(18).success).toBe(false)
    expect(gstRateBpsSchema.safeParse(1500).success).toBe(false)
  })
  it('tiers start at 1, increase in qty and decrease in price', () => {
    expect(priceTiersSchema.safeParse([{ min_qty: 1, unit_price_paise: 1000 }]).success).toBe(true)
    expect(
      priceTiersSchema.safeParse([
        { min_qty: 1, unit_price_paise: 1000 },
        { min_qty: 100, unit_price_paise: 900 },
        { min_qty: 500, unit_price_paise: 850 },
      ]).success,
    ).toBe(true)
    expect(priceTiersSchema.safeParse([{ min_qty: 10, unit_price_paise: 1000 }]).success).toBe(false)
    expect(
      priceTiersSchema.safeParse([
        { min_qty: 1, unit_price_paise: 1000 },
        { min_qty: 100, unit_price_paise: 1000 },
      ]).success,
    ).toBe(false)
    expect(
      priceTiersSchema.safeParse([
        { min_qty: 1, unit_price_paise: 1000 },
        { min_qty: 1, unit_price_paise: 900 },
      ]).success,
    ).toBe(false)
  })
  it('product input carries hsn + gst + tiers', () => {
    const r = productInputSchema.safeParse({
      category_slug: 'fasteners',
      name: 'M8 hex bolt, zinc',
      hsn_code: '7318',
      gst_rate_bps: 1800,
      unit: 'pcs',
      tiers: [{ min_qty: 1, unit_price_paise: 450 }],
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.images).toEqual([])
      expect(r.data.min_order_qty).toBe(1)
      expect(r.data.country_of_origin).toBe('IN')
    }
  })
  it('checkout body never accepts prices', () => {
    const r = goodsCheckoutSchema.safeParse({
      items: [{ product_id: '2b1f4a0e-6b3c-4d0e-9a1f-1234567890ab', qty: 100, unit_price_paise: 1 }],
      delivery: { contact_name: 'Ravi', contact_phone: '9876543210', address: 'Plot 4, Industrial Estate', city: 'Kurnool', state: 'AP', pincode: '518001' },
      idempotencyKey: '2b1f4a0e-6b3c-4d0e-9a1f-1234567890ab',
    })
    expect(r.success).toBe(true)
    if (r.success) expect('unit_price_paise' in r.data.items[0]!).toBe(false)
  })
  it('seed blocks BIS-notified categories at launch', () => {
    expect(MART_CATEGORY_SEED.find((c) => c.slug === 'safety-gear')?.bis_blocked).toBe(true)
    expect(MART_CATEGORY_SEED.find((c) => c.slug === 'fasteners')?.bis_blocked).toBe(false)
  })
})

describe('tier resolution', () => {
  const tiers = [
    { min_qty: 1, unit_price_paise: 1000 },
    { min_qty: 100, unit_price_paise: 900 },
    { min_qty: 500, unit_price_paise: 850 },
  ]
  it('picks the largest min_qty ≤ qty regardless of order', () => {
    expect(resolveTier(tiers, 1)?.unit_price_paise).toBe(1000)
    expect(resolveTier(tiers, 99)?.unit_price_paise).toBe(1000)
    expect(resolveTier(tiers, 100)?.unit_price_paise).toBe(900)
    expect(resolveTier(tiers, 10_000)?.unit_price_paise).toBe(850)
    expect(resolveTier([...tiers].reverse(), 120)?.unit_price_paise).toBe(900)
  })
  it('returns null below the first tier', () => {
    expect(resolveTier([{ min_qty: 10, unit_price_paise: 5 }], 3)).toBeNull()
  })
})

describe('computeGoodsOrderAmounts', () => {
  it('rounds GST per line and mirrors the services split', () => {
    const a = computeGoodsOrderAmounts({
      lines: [
        { qty: 100, unitPricePaise: 450, gstRateBps: 1800 }, // 45,000 → gst 8,100
        { qty: 3, unitPricePaise: 33333, gstRateBps: 500 }, // 99,999 → gst 4,999.95 → 5,000
      ],
      commissionBps: 500,
    })
    expect(a.lines).toEqual([
      { taxablePaise: 45000, gstPaise: 8100 },
      { taxablePaise: 99999, gstPaise: 5000 },
    ])
    expect(a.pricePaise).toBe(144999)
    expect(a.discountPaise).toBe(0)
    expect(a.taxablePaise).toBe(144999)
    expect(a.gstPaise).toBe(13100)
    expect(a.totalPaise).toBe(158099)
    expect(a.commissionPaise).toBe(2250 + 5000) // per line: 5% of 45,000 + 5% of 99,999 (4,999.95 → 5,000)
    expect(a.providerEarningPaise).toBe(144999 - 7250)
    // Fee-headroom invariant the payout guard relies on: transfer + commission = taxable ≤ captured.
    expect(a.providerEarningPaise + a.commissionPaise).toBe(a.taxablePaise)
    expect(a.taxablePaise).toBeLessThanOrEqual(a.totalPaise)
  })
  it('honours a per-line commission for mixed categories', () => {
    const a = computeGoodsOrderAmounts({
      lines: [
        { qty: 10, unitPricePaise: 1000, gstRateBps: 1800, commissionBps: 500 }, // 10,000 → 500
        { qty: 10, unitPricePaise: 1000, gstRateBps: 1800, commissionBps: 800 }, // 10,000 → 800
      ],
      commissionBps: 500,
    })
    expect(a.commissionPaise).toBe(1300)
    expect(a.commissionBps).toBe(500)
    expect(a.providerEarningPaise).toBe(20000 - 1300)
  })
  it('refuses non-integer or non-positive input', () => {
    expect(() => computeGoodsOrderAmounts({ lines: [], commissionBps: 500 })).toThrow()
    expect(() => computeGoodsOrderAmounts({ lines: [{ qty: 0, unitPricePaise: 1, gstRateBps: 0 }], commissionBps: 500 })).toThrow()
    expect(() => computeGoodsOrderAmounts({ lines: [{ qty: 1.5, unitPricePaise: 1, gstRateBps: 0 }], commissionBps: 500 })).toThrow()
    expect(() => computeGoodsOrderAmounts({ lines: [{ qty: 1, unitPricePaise: 0.5, gstRateBps: 0 }], commissionBps: 500 })).toThrow()
  })
  it('ITC effective cost is the taxable value', () => {
    expect(effectiveCostAfterItcPaise({ taxablePaise: 144999 })).toBe(144999)
  })
})

describe('goods release gate', () => {
  const t0 = new Date('2026-09-01T10:00:00Z')
  const h = (n: number) => new Date(t0.getTime() + n * 3600 * 1000)
  const base = { deliveredPhotoAt: t0, buyerReceivedAt: null, returnOpenedAt: null, returnResolvedAt: null, returnWindowHours: 48 }

  it('holds without a delivery photo', () => {
    const g = evaluateGoodsReleaseGate({ ...base, deliveredPhotoAt: null, now: h(200) })
    expect(g.ok).toBe(false)
    expect(g.reasons).toContain('no_delivery_photo')
  })
  it('holds while awaiting receipt and inside the return window', () => {
    const g = evaluateGoodsReleaseGate({ ...base, now: h(1) })
    expect(g.ok).toBe(false)
    expect(g.reasons).toEqual(['awaiting_receipt', 'return_window_open'])
    expect(g.autoReceiptAt).toEqual(h(72))
    expect(g.returnWindowEndsAt).toEqual(h(48))
  })
  it('buyer confirmation clears receipt but not the window', () => {
    const g = evaluateGoodsReleaseGate({ ...base, buyerReceivedAt: h(2), now: h(3) })
    expect(g.reasons).toEqual(['return_window_open'])
  })
  it('releases after 72h auto-receipt AND window clear', () => {
    expect(evaluateGoodsReleaseGate({ ...base, now: h(72) }).ok).toBe(true)
    // A long window (7 days) keeps holding past auto-receipt.
    const g = evaluateGoodsReleaseGate({ ...base, returnWindowHours: 168, now: h(100) })
    expect(g.ok).toBe(false)
    expect(g.reasons).toEqual(['return_window_open'])
  })
  it('an open return blocks release until resolved', () => {
    const open = evaluateGoodsReleaseGate({ ...base, buyerReceivedAt: h(1), returnOpenedAt: h(10), now: h(100) })
    expect(open.ok).toBe(false)
    expect(open.reasons).toEqual(['return_open'])
    const resolved = evaluateGoodsReleaseGate({ ...base, buyerReceivedAt: h(1), returnOpenedAt: h(10), returnResolvedAt: h(20), now: h(100) })
    expect(resolved.ok).toBe(true)
  })
})

describe('pool state machine', () => {
  it('is exhaustive', () => {
    for (const s of POOL_STATUSES) expect(POOL_TRANSITIONS[s]).toBeDefined()
  })
  it('met / unmet / expiry / cancel / fulfil', () => {
    expect(assertPoolTransition('open', 'closed_met')).toBe('closed_met')
    expect(assertPoolTransition('open', 'closed_unmet')).toBe('closed_unmet')
    expect(assertPoolTransition('open', 'cancelled')).toBe('cancelled')
    expect(assertPoolTransition('closed_met', 'ordered')).toBe('ordered')
    expect(assertPoolTransition('ordered', 'fulfilled')).toBe('fulfilled')
  })
  it('THROWS on illegal transitions', () => {
    expect(() => assertPoolTransition('closed_unmet', 'ordered')).toThrow(PoolTransitionError)
    expect(() => assertPoolTransition('open', 'ordered')).toThrow(PoolTransitionError)
    expect(() => assertPoolTransition('fulfilled', 'open')).toThrow(PoolTransitionError)
    expect(() => assertPoolTransition('cancelled', 'closed_met')).toThrow(PoolTransitionError)
  })
  it('blocked funds are NEVER capturable on an unmet pool', () => {
    expect(mayCapturePoolMember('closed_met', 'blocked')).toBe(true)
    for (const s of POOL_STATUSES.filter((x) => x !== 'closed_met')) {
      expect(mayCapturePoolMember(s, 'blocked')).toBe(false)
    }
    expect(mayCapturePoolMember('closed_met', 'captured')).toBe(false)
    expect(mayCapturePoolMember('closed_met', 'released')).toBe(false)
  })
  it('close outcome + payment-state transitions', () => {
    expect(poolCloseOutcome(50, 50)).toBe('closed_met')
    expect(poolCloseOutcome(49, 50)).toBe('closed_unmet')
    expect(isValidPoolMemberPaymentTransition('blocked', 'captured')).toBe(true)
    expect(isValidPoolMemberPaymentTransition('released', 'captured')).toBe(false)
    expect(isValidPoolMemberPaymentTransition('captured', 'released')).toBe(false)
  })
})

describe('ai_decisions', () => {
  it('lists only the fields the human changed', () => {
    expect(
      aiDecisionCorrectedFields(
        { name: 'M8 bolt', hsn_code: '7318', gst_rate_bps: 1800, tiers: [{ min_qty: 1, unit_price_paise: 400 }] },
        { name: 'M8 hex bolt zinc', hsn_code: '7318', gst_rate_bps: 1800, tiers: [{ min_qty: 1, unit_price_paise: 450 }] },
      ),
    ).toEqual(['name', 'tiers'])
  })
})

describe('services order machine is byte-untouched by Mart (inertness)', () => {
  it('keeps the exact §3.7 status set and transition map', () => {
    expect([...ORDER_STATUSES]).toEqual([
      'placed', 'accepted', 'requirements_submitted', 'in_progress', 'delivered', 'revision_requested',
      'completed', 'disputed', 'resolved_refund', 'resolved_release', 'resolved_partial',
      'auto_cancelled', 'cancelled_by_buyer', 'refunded', 'reviewed',
    ])
    expect(ORDER_TRANSITIONS.accepted).toEqual(['requirements_submitted', 'cancelled_by_buyer'])
    expect(isValidOrderTransition('accepted', 'in_progress')).toBe(false)
    expect(isValidOrderTransition('completed', 'disputed')).toBe(true)
  })
})
