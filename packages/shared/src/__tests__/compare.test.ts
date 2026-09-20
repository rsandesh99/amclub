import { describe, expect, it } from 'vitest'
import {
  ADVANCE_HIGH_PERCENT,
  COMPARE_FLAGS,
  DEFAULT_GST_BPS,
  compareQuotes,
  daysUntil,
  findBannedPhrases,
  goodsQuoteMoney,
  sanitizePointers,
  servicesGstPaise,
  type CompareQuoteInput,
} from '../index'

const TODAY = '2026-09-20'
const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`

const base = (over: Partial<CompareQuoteInput> = {}): CompareQuoteInput => ({
  id: U(1),
  kind: 'service',
  pricePaise: 10_000_00, // ₹10,000
  deliveryDays: 10,
  gstIncluded: true,
  transportIncluded: true,
  validUntil: null,
  advancePercent: 0,
  ...over,
})

/** The 7-quote mixed fixture reused by the golden set (docs/agents/COMPARE_DECLINE.md). */
export const SEVEN: CompareQuoteInput[] = [
  base({ id: U(1), pricePaise: 10_000_00, deliveryDays: 10, gstIncluded: true, transportIncluded: true, advancePercent: 0 }),
  base({ id: U(2), pricePaise: 9_000_00, deliveryDays: 12, gstIncluded: false, transportIncluded: null, advancePercent: null }), // +18% GST → 10,620
  base({ id: U(3), pricePaise: 11_500_00, deliveryDays: 5, gstIncluded: true, transportIncluded: false, advancePercent: 60 }),
  base({ id: U(4), pricePaise: 8_800_00, deliveryDays: null, gstIncluded: null, transportIncluded: true, advancePercent: 10 }),
  base({ id: U(5), pricePaise: 12_000_00, deliveryDays: 7, gstIncluded: true, transportIncluded: true, validUntil: '2026-09-22', advancePercent: 25 }),
  base({ id: U(6), pricePaise: 9_900_00, deliveryDays: 9, gstIncluded: true, transportIncluded: true, validUntil: '2026-09-01', advancePercent: 50 }),
  base({ id: U(7), pricePaise: 10_000_00, deliveryDays: 5, gstIncluded: true, transportIncluded: true, validUntil: '2026-12-31', advancePercent: 30 }),
]

const byId = (rs: ReturnType<typeof compareQuotes>, id: string) => rs.find((r) => r.id === id)!

describe('money helpers', () => {
  it('servicesGstPaise rounds to the paise', () => {
    expect(servicesGstPaise(9_000_00, 1800)).toBe(1_620_00)
    expect(servicesGstPaise(1, 1800)).toBe(0)
    expect(servicesGstPaise(3, 1800)).toBe(1)
  })
  it('goodsQuoteMoney is the M2 math (qty × unit + GST at the slab)', () => {
    expect(goodsQuoteMoney({ unitPricePaise: 12000, qty: 500, gstRateBps: 1800 })).toEqual({ taxablePaise: 6_000_000, gstPaise: 1_080_000, totalInclGstPaise: 7_080_000 })
    expect(goodsQuoteMoney({ unitPricePaise: 4800, qty: 2000, gstRateBps: 500 })).toEqual({ taxablePaise: 9_600_000, gstPaise: 480_000, totalInclGstPaise: 10_080_000 })
  })
  it('daysUntil counts calendar days (negative when past)', () => {
    expect(daysUntil('2026-09-23', TODAY)).toBe(3)
    expect(daysUntil('2026-09-20', TODAY)).toBe(0)
    expect(daysUntil('2026-09-19', TODAY)).toBe(-1)
    expect(daysUntil('2026-10-01', TODAY)).toBe(11)
  })
})

describe('compareQuotes — normalisation', () => {
  // The second quote in each pair has a different delivery so no fastest tie-note appears.
  it('GST excluded → added at the services rate and flagged', () => {
    const [r] = compareQuotes([base({ gstIncluded: false, pricePaise: 9_000_00 }), base({ id: U(2), deliveryDays: 20 })], { today: TODAY })
    expect(r!.normalizedTotalPaise).toBe(9_000_00 + servicesGstPaise(9_000_00, DEFAULT_GST_BPS))
    expect(r!.normalizationNotes).toEqual([{ code: 'gst_added', paise: 1_620_00 }])
    expect(r!.flags).toContain('gst_not_included')
  })
  it('GST included → unchanged, no gst flag', () => {
    const [r] = compareQuotes([base({ gstIncluded: true }), base({ id: U(2) })], { today: TODAY })
    expect(r!.normalizedTotalPaise).toBe(10_000_00)
    expect(r!.flags.some((f) => f.startsWith('gst_'))).toBe(false)
  })
  it('GST unstated → unchanged AND flagged gst_unstated with a note (never assumed)', () => {
    const [r] = compareQuotes([base({ gstIncluded: null }), base({ id: U(2), deliveryDays: 20, pricePaise: 12_000_00 })], { today: TODAY })
    expect(r!.normalizedTotalPaise).toBe(10_000_00)
    expect(r!.normalizationNotes).toEqual([{ code: 'gst_assumed_none' }])
    expect(r!.flags).toContain('gst_unstated')
  })
  it('a custom servicesGstBps is honoured', () => {
    const [r] = compareQuotes([base({ gstIncluded: false }), base({ id: U(2) })], { today: TODAY, servicesGstBps: 500 })
    expect(r!.normalizedTotalPaise).toBe(10_500_00)
  })
  it('goods: qty × unit + GST at the quote slab; no gst_* flags', () => {
    const g: CompareQuoteInput = { ...base({ id: U(1), kind: 'goods', pricePaise: 6_000_000 }), goods: { unitPricePaise: 12000, qty: 500, gstRateBps: 1800 } }
    const [r] = compareQuotes([g, base({ id: U(2), deliveryDays: 20 })], { today: TODAY })
    expect(r!.normalizedTotalPaise).toBe(7_080_000)
    expect(r!.normalizationNotes).toEqual([{ code: 'gst_added', paise: 1_080_000 }])
    expect(r!.flags.some((f) => f.startsWith('gst_'))).toBe(false)
  })
  it('goods with 0 % GST adds nothing and writes no note', () => {
    const g: CompareQuoteInput = { ...base({ id: U(1), kind: 'goods' }), goods: { unitPricePaise: 100, qty: 10, gstRateBps: 0 } }
    const [r] = compareQuotes([g, base({ id: U(2), deliveryDays: 20 })], { today: TODAY })
    expect(r!.normalizedTotalPaise).toBe(1000)
    expect(r!.normalizationNotes).toEqual([])
  })
  it('transport is never added — flag only', () => {
    const rs = compareQuotes([base({ transportIncluded: false }), base({ id: U(2), transportIncluded: null }), base({ id: U(3), transportIncluded: true })], { today: TODAY })
    expect(rs.map((r) => r.normalizedTotalPaise)).toEqual([10_000_00, 10_000_00, 10_000_00])
    expect(byId(rs, U(1)).flags).toContain('transport_not_included')
    expect(byId(rs, U(2)).flags).toContain('transport_unstated')
    expect(byId(rs, U(3)).flags.some((f) => f.startsWith('transport_'))).toBe(false)
  })
})

describe('compareQuotes — flags', () => {
  it('delivery_unstated when null or non-positive', () => {
    const rs = compareQuotes([base({ deliveryDays: null }), base({ id: U(2), deliveryDays: 0 }), base({ id: U(3), deliveryDays: 3 })], { today: TODAY })
    expect(byId(rs, U(1)).flags).toContain('delivery_unstated')
    expect(byId(rs, U(2)).flags).toContain('delivery_unstated')
    expect(byId(rs, U(3)).flags).not.toContain('delivery_unstated')
  })
  it('validity_short within 3 days (inclusive), validity_expired before today, neither when far', () => {
    const rs = compareQuotes([base({ validUntil: '2026-09-23' }), base({ id: U(2), validUntil: '2026-09-19' }), base({ id: U(3), validUntil: '2026-09-24' }), base({ id: U(4), validUntil: TODAY })], { today: TODAY })
    expect(byId(rs, U(1)).flags).toContain('validity_short')
    expect(byId(rs, U(2)).flags).toContain('validity_expired')
    expect(byId(rs, U(3)).flags.some((f) => f.startsWith('validity_'))).toBe(false)
    expect(byId(rs, U(4)).flags).toContain('validity_short')
  })
  it('advance_high strictly above 50; advance_unstated when null; 50 itself is fine', () => {
    const rs = compareQuotes([base({ advancePercent: 51 }), base({ id: U(2), advancePercent: null }), base({ id: U(3), advancePercent: ADVANCE_HIGH_PERCENT })], { today: TODAY })
    expect(byId(rs, U(1)).flags).toContain('advance_high')
    expect(byId(rs, U(2)).flags).toContain('advance_unstated')
    expect(byId(rs, U(3)).flags.some((f) => f.startsWith('advance_'))).toBe(false)
  })
  it('a single quote gets only_quote and never cheapest/fastest', () => {
    const [r] = compareQuotes([base()], { today: TODAY })
    expect(r!.flags).toContain('only_quote')
    expect(r!.flags).not.toContain('cheapest_after_normalization')
    expect(r!.flags).not.toContain('fastest')
  })
  it('empty input → empty output', () => {
    expect(compareQuotes([], { today: TODAY })).toEqual([])
  })
  it('exactly one cheapest_after_normalization (after GST), exactly one fastest', () => {
    const rs = compareQuotes(SEVEN, { today: TODAY })
    expect(rs.filter((r) => r.flags.includes('cheapest_after_normalization'))).toHaveLength(1)
    expect(rs.filter((r) => r.flags.includes('fastest'))).toHaveLength(1)
  })
  it('the 7-quote fixture: exact totals and flags', () => {
    const rs = compareQuotes(SEVEN, { today: TODAY })
    expect(rs.map((r) => r.normalizedTotalPaise)).toEqual([10_000_00, 10_620_00, 11_500_00, 8_800_00, 12_000_00, 9_900_00, 10_000_00])
    expect(byId(rs, U(4)).flags).toEqual(expect.arrayContaining(['gst_unstated', 'delivery_unstated', 'cheapest_after_normalization']))
    expect(byId(rs, U(2)).flags).toEqual(expect.arrayContaining(['gst_not_included', 'transport_unstated', 'advance_unstated']))
    expect(byId(rs, U(3)).flags).toEqual(expect.arrayContaining(['transport_not_included', 'advance_high', 'fastest']))
    expect(byId(rs, U(5)).flags).toContain('validity_short')
    expect(byId(rs, U(6)).flags).toContain('validity_expired')
    expect(byId(rs, U(7)).flags).not.toContain('fastest') // ties → earlier id (U3) wins
    expect(byId(rs, U(3)).normalizationNotes).toEqual([{ code: 'tie_broken' }])
    expect(byId(rs, U(1)).flags).toEqual([])
  })
  it('cheapest tie → earlier input id, with a tie_broken note', () => {
    const rs = compareQuotes([base({ id: U(9), pricePaise: 5_000_00 }), base({ id: U(8), pricePaise: 5_000_00 })], { today: TODAY })
    expect(byId(rs, U(9)).flags).toContain('cheapest_after_normalization')
    expect(byId(rs, U(9)).normalizationNotes).toEqual([{ code: 'tie_broken' }])
    expect(byId(rs, U(8)).flags).not.toContain('cheapest_after_normalization')
  })
  it('order-independent apart from tie-breaking', () => {
    const a = compareQuotes(SEVEN, { today: TODAY })
    const b = compareQuotes([...SEVEN].reverse(), { today: TODAY })
    for (const r of a) {
      const other = byId(b, r.id)
      expect(other.normalizedTotalPaise).toBe(r.normalizedTotalPaise)
      const strip = (fs: string[]) => fs.filter((f) => f !== 'fastest' && f !== 'cheapest_after_normalization').sort()
      expect(strip(other.flags)).toEqual(strip(r.flags))
    }
  })
  it('fastest ignores quotes with no delivery and a non-positive delivery', () => {
    const rs = compareQuotes([base({ deliveryDays: null }), base({ id: U(2), deliveryDays: 0 }), base({ id: U(3), deliveryDays: 20 })], { today: TODAY })
    expect(byId(rs, U(3)).flags).toContain('fastest')
  })
  it('no fastest at all when nobody states delivery', () => {
    const rs = compareQuotes([base({ deliveryDays: null }), base({ id: U(2), deliveryDays: null })], { today: TODAY })
    expect(rs.some((r) => r.flags.includes('fastest'))).toBe(false)
  })
  it('every emitted flag is a member of COMPARE_FLAGS', () => {
    for (const r of compareQuotes(SEVEN, { today: TODAY })) for (const f of r.flags) expect(COMPARE_FLAGS).toContain(f)
  })
  it('a malformed validUntil is ignored (no validity flag, no throw)', () => {
    const [r] = compareQuotes([base({ validUntil: '20/09/2026' }), base({ id: U(2) })], { today: TODAY })
    expect(r!.flags.some((f) => f.startsWith('validity_'))).toBe(false)
  })
  it('flags never depend on any feature flag or locale (pure function of the inputs)', () => {
    const a = compareQuotes(SEVEN, { today: TODAY })
    const b = compareQuotes(SEVEN, { today: TODAY })
    expect(a).toEqual(b)
  })
})

describe('pointer banned-phrase gate', () => {
  it('finds banned phrases case-insensitively per locale', () => {
    expect(findBannedPhrases('Quote B is the BEST value', 'en')).toEqual(['best'])
    expect(findBannedPhrases('Quote B adds GST later; the gap after GST is ₹4,600', 'en')).toEqual([])
    expect(findBannedPhrases('कोटेशन B सबसे अच्छा है', 'hi')).toEqual(['सबसे अच्छा'])
    expect(findBannedPhrases('கோட் B சிறந்த', 'ta')).toEqual(['சிறந்த'])
    expect(findBannedPhrases('కోట్ B ఉత్తమం', 'te')).toEqual(['ఉత్తమ'])
  })
  it('sanitizePointers drops only the offending quote lines and reports the ids', () => {
    const { pointers, dropped } = sanitizePointers(
      { pointers: [{ quote_id: U(1), lines: ['GST not included; total after GST ₹10,620'] }, { quote_id: U(2), lines: ['Choose this one'] }] },
      'en',
    )
    expect(dropped).toEqual([U(2)])
    expect(pointers.pointers[0]!.lines).toHaveLength(1)
    expect(pointers.pointers[1]!.lines).toEqual([])
  })
})
