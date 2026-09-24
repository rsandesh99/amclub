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
  PRODUCT_MATERIAL_FIELDS,
  productEditReview,
  productReviewSchema,
  canOpenGoodsReturn,
  goodsReturnDeadline,
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
    expect(isValidProductTransition('draft', 'suspended')).toBe(false)
    expect(isValidProductTransition('pending_approval', 'suspended')).toBe(false)
  })
  it('audit M16: an approved listing can go back to review, never around it', () => {
    expect(isValidProductTransition('active', 'pending_approval')).toBe(true)
    expect(isValidProductTransition('suspended', 'pending_approval')).toBe(true)
    // Every edge INTO active starts at a reviewed state: pending_approval (the admin) or suspended (a reinstatement).
    for (const s of PRODUCT_STATUSES) {
      if (isValidProductTransition(s, 'active')) expect(['pending_approval', 'suspended']).toContain(s)
    }
  })
})

describe('listing edits (audit M16)', () => {
  it('only the material fields matter', () => {
    expect(PRODUCT_MATERIAL_FIELDS).toEqual(['category_slug', 'name', 'images', 'hsn_code', 'gst_rate_bps', 'unit'])
    expect(productEditReview([], false)).toBe('none')
    expect(productEditReview(['description', 'specs', 'promises', 'sample_price_paise'], false)).toBe('none')
  })
  it('a seller under the threshold goes back to review for any material change', () => {
    for (const f of PRODUCT_MATERIAL_FIELDS) expect(productEditReview([f], false)).toBe('required')
  })
  it('a trusted seller keeps the listing live, except for a category change', () => {
    expect(productEditReview(['name', 'images'], true)).toBe('auto')
    expect(productEditReview(['gst_rate_bps'], true)).toBe('auto')
    expect(productEditReview(['category_slug'], true)).toBe('required')
    expect(productEditReview(['name', 'category_slug'], true)).toBe('required')
  })
  it('an approval must name the version it reviewed', () => {
    expect(productReviewSchema.safeParse({ action: 'approve' }).success).toBe(false)
    expect(productReviewSchema.safeParse({ action: 'approve', reviewed_updated_at: '2026-09-24T10:00:00.123456+00:00' }).success).toBe(true)
    expect(productReviewSchema.safeParse({ action: 'approve', reviewed_updated_at: null }).success).toBe(true)
    expect(productReviewSchema.safeParse({ action: 'approve', reviewed_updated_at: 'yesterday' }).success).toBe(false)
    expect(productReviewSchema.safeParse({ action: 'reject', reason: 'blurry photos' }).success).toBe(true)
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

describe('opening a goods return (audit M14)', () => {
  const t0 = new Date('2026-09-01T10:00:00Z') // delivery photo
  const h = (n: number) => t0.getTime() + n * 3600 * 1000
  const iso = (n: number) => new Date(h(n)).toISOString()
  // 48 h category window from the photo; completed at +24 h; 7-day dispute window.
  const done = { status: 'completed' as const, returnWindowEndsAt: new Date(h(48)), completedAt: iso(24), disputeWindowDays: 7 }

  it('a delivered order (pre-completion) can always open a return', () => {
    expect(canOpenGoodsReturn({ ...done, status: 'delivered', returnWindowEndsAt: new Date(h(0)), now: h(70) })).toEqual({ ok: true })
    expect(goodsReturnDeadline({ ...done, status: 'delivered' })).toBeNull()
  })
  it('a completed order: the category window binds when it is the shorter bound', () => {
    expect(goodsReturnDeadline(done)).toBe(iso(48))
    expect(canOpenGoodsReturn({ ...done, now: h(47) })).toEqual({ ok: true })
    expect(canOpenGoodsReturn({ ...done, now: h(48) })).toEqual({ ok: false, reason: 'window_closed', endsAt: iso(48) })
    expect(canOpenGoodsReturn({ ...done, now: h(24 * 400) }).ok).toBe(false)
  })
  it('the dispute window caps a longer category window', () => {
    const long = { ...done, returnWindowEndsAt: new Date(h(720)) } // 30-day category
    expect(goodsReturnDeadline(long)).toBe(iso(24 + 7 * 24))
    expect(canOpenGoodsReturn({ ...long, now: h(24 + 7 * 24) - 1 })).toEqual({ ok: true })
    expect(canOpenGoodsReturn({ ...long, now: h(24 + 7 * 24) })).toEqual({ ok: false, reason: 'window_closed', endsAt: iso(24 + 7 * 24) })
  })
  it('fails safe: a missing bound means closed', () => {
    expect(canOpenGoodsReturn({ ...done, returnWindowEndsAt: null, now: h(1) })).toEqual({ ok: false, reason: 'window_closed', endsAt: null })
    expect(canOpenGoodsReturn({ ...done, completedAt: null, now: h(1) })).toEqual({ ok: false, reason: 'window_closed', endsAt: null })
  })
  it('a zero-hour category closes at the delivery evidence', () => {
    expect(canOpenGoodsReturn({ ...done, returnWindowEndsAt: new Date(h(0)), now: h(25) }).ok).toBe(false)
  })
  it('other statuses are refused', () => {
    for (const s of ['placed', 'accepted', 'in_progress', 'disputed', 'reviewed', 'refunded'] as const) {
      expect(canOpenGoodsReturn({ ...done, status: s, now: h(1) })).toEqual({ ok: false, reason: 'status' })
    }
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
      'cancelled_duplicate', // ADR-014 §7 (H6) — a services decision, not Mart
    ])
    // ADR-014 (H2) added the §3.7 "any-pre-completed → disputed" edges on purpose
    // (a services decision, not Mart); the pin stays exact.
    expect(ORDER_TRANSITIONS.accepted).toEqual(['requirements_submitted', 'cancelled_by_buyer', 'disputed'])
    expect(ORDER_TRANSITIONS.requirements_submitted).toEqual(['in_progress', 'disputed'])
    expect(ORDER_TRANSITIONS.revision_requested).toEqual(['in_progress', 'disputed'])
    expect(isValidOrderTransition('accepted', 'in_progress')).toBe(false)
    expect(isValidOrderTransition('completed', 'disputed')).toBe(true)
  })
})

// ── M1: pools ────────────────────────────────────────────────────────────────
import {
  POOL_MEMBER_PAYMENT_STATES,
  POOL_MEMBER_PAYMENT_TRANSITIONS,
  poolProgress,
  poolSaving,
  poolIsDueToClose,
  poolPayDeadline,
  poolMemberMayLeave,
  poolOpenProblem,
  poolDisciplineFactor,
  buildPoolCardText,
  poolDraftSchema,
  poolJoinSchema,
} from '../mart/pools'

describe('pool state machine — M1 acceptance (met / unmet / expiry / exit / capture-fail)', () => {
  it('every status and every payment state has a transition row (exhaustive)', () => {
    for (const s of POOL_STATUSES) expect(Array.isArray(POOL_TRANSITIONS[s])).toBe(true)
    for (const s of POOL_MEMBER_PAYMENT_STATES) expect(Array.isArray(POOL_MEMBER_PAYMENT_TRANSITIONS[s])).toBe(true)
  })
  it('terminal states have no exits', () => {
    for (const s of ['closed_unmet', 'fulfilled', 'cancelled'] as const) expect(POOL_TRANSITIONS[s]).toEqual([])
    for (const s of ['captured', 'released'] as const) expect(POOL_MEMBER_PAYMENT_TRANSITIONS[s]).toEqual([])
  })
  it('expiry: an open pool past closes_at is due; nothing else ever is', () => {
    const now = new Date('2026-09-10T00:00:00Z')
    expect(poolIsDueToClose('open', '2026-09-09T23:59:59Z', now)).toBe(true)
    expect(poolIsDueToClose('open', '2026-09-10T00:00:01Z', now)).toBe(false)
    for (const s of POOL_STATUSES.filter((x) => x !== 'open')) expect(poolIsDueToClose(s, '2026-09-01T00:00:00Z', now)).toBe(false)
  })
  it('exit: a member may leave only while the pool is open and still merely committed', () => {
    expect(poolMemberMayLeave('open', 'blocked')).toBe(true)
    expect(poolMemberMayLeave('closed_met', 'blocked')).toBe(false)
    expect(poolMemberMayLeave('open', 'released')).toBe(false)
    expect(poolMemberMayLeave('open', 'captured')).toBe(false)
  })
  it('capture-fail: failed may re-block, never jump to captured', () => {
    expect(isValidPoolMemberPaymentTransition('failed', 'blocked')).toBe(true)
    expect(isValidPoolMemberPaymentTransition('failed', 'captured')).toBe(false)
    expect(mayCapturePoolMember('closed_met', 'failed')).toBe(false)
  })
  it('the money rule, cross-product: capture is legal in exactly one (pool, member) cell', () => {
    const legal: string[] = []
    for (const p of POOL_STATUSES) for (const m of POOL_MEMBER_PAYMENT_STATES) if (mayCapturePoolMember(p, m)) legal.push(`${p}/${m}`)
    expect(legal).toEqual(['closed_met/blocked'])
  })
})

describe('pool math and rules', () => {
  it('progress against target with the minimum line', () => {
    expect(poolProgress(0, 50, 100)).toEqual({ pct: 0, metPct: 50, met: false, remainingToMin: 50 })
    expect(poolProgress(60, 50, 100)).toEqual({ pct: 60, metPct: 50, met: true, remainingToMin: 0 })
    expect(poolProgress(500, 50, 100).pct).toBe(100)
  })
  it('saving vs list price never negative', () => {
    expect(poolSaving(400, 500)).toEqual({ paise: 100, pct: 20 })
    expect(poolSaving(500, 500)).toEqual({ paise: 0, pct: 0 })
    expect(poolSaving(500, null)).toEqual({ paise: 0, pct: 0 })
  })
  it('pay-on-close deadline = close time + window', () => {
    expect(poolPayDeadline('2026-09-10T10:00:00Z', 48).toISOString()).toBe('2026-09-12T10:00:00.000Z')
  })
  it('open validation returns the first problem', () => {
    const now = new Date('2026-09-10T00:00:00Z')
    const base = { product_id: 'p', min_qty: 50, target_qty: 100, unit_price_paise: 400, closes_at: '2026-09-15T00:00:00Z', list_price_paise: 500 }
    expect(poolOpenProblem(base, now)).toBeNull()
    expect(poolOpenProblem({ ...base, product_id: null }, now)).toBe('product_required')
    expect(poolOpenProblem({ ...base, min_qty: 101 }, now)).toBe('min_exceeds_target')
    expect(poolOpenProblem({ ...base, closes_at: '2026-09-10T12:00:00Z' }, now)).toBe('closes_too_soon')
    expect(poolOpenProblem({ ...base, closes_at: '2026-11-10T12:00:00Z' }, now)).toBe('closes_too_late')
    expect(poolOpenProblem({ ...base, unit_price_paise: 500 }, now)).toBe('price_not_below_list')
  })
  it('discipline: neutral below the sample gate, honoured/due above, public at 5', () => {
    expect(poolDisciplineFactor({ due: 0, honoured: 0, defaulted: 0 })).toEqual({ factor: 1, sample: 0, public: false })
    expect(poolDisciplineFactor({ due: 2, honoured: 0, defaulted: 2 })).toEqual({ factor: 1, sample: 2, public: false })
    expect(poolDisciplineFactor({ due: 4, honoured: 3, defaulted: 1 })).toEqual({ factor: 0.75, sample: 4, public: false })
    expect(poolDisciplineFactor({ due: 6, honoured: 6, defaulted: 0 })).toEqual({ factor: 1, sample: 6, public: true })
  })
  it('schemas: draft min ≤ target; join needs a delivery snapshot', () => {
    expect(poolDraftSchema.safeParse({ product_id: null, category_slug: 'fasteners', title: 'M8 bolts', unit: 'pcs', target_qty: 100, min_qty: 200, unit_price_paise: 400, closes_at: '2026-09-15T00:00:00+05:30' }).success).toBe(false)
    expect(poolJoinSchema.safeParse({ qty: 10 }).success).toBe(false)
    expect(poolJoinSchema.safeParse({ qty: 10, delivery: { contact_name: 'Ravi', contact_phone: '9876543210', address: 'Plot 4, Estate', city: 'Kurnool', state: 'AP', pincode: '518001' } }).success).toBe(true)
  })
  it('card text carries the numbers in all three languages', () => {
    const inp = { title: 'M8 × 40 hex bolt', unit: 'pcs', unitPricePaise: 400, listPricePaise: 450, committedQty: 120, minQty: 200, targetQty: 500, memberCount: 3, closesAt: '2026-09-15T12:30:00Z', url: 'https://amclub.in/mart/pools/x' }
    for (const l of ['en', 'hi', 'te'] as const) {
      const t = buildPoolCardText(inp, l)
      expect(t).toContain('₹4/pcs')
      expect(t).toContain('120/500')
      expect(t).toContain('11%')
      expect(t).toContain('https://amclub.in/mart/pools/x')
    }
    expect(buildPoolCardText({ ...inp, committedQty: 250 }, 'en')).toContain('Minimum reached')
  })
})
