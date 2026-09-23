import { describe, expect, it } from 'vitest'
import { cadBandError, cadFeaturesFromDrawing, cadFeaturesSchema, cadPriceBand, deliverableFormat, deliverableLabel, fitError, mfgSpecSchema, packageDeliverableSchema, providerFitRules, weeklyShadowReport, type DrawingSummary } from '../index'

const drawing: DrawingSummary = { format: 'step', product_name: 'BRACKET', units: 'mm', bbox_mm: [120, 80, 10], counts: { faces: 42 }, hole_estimate: 6, layers: [], summary_english: 'x', spec_rows: [] }

describe('E15 F3 — typed specs', () => {
  it('CAD features come from the deterministic parse only (no names, no prose)', () => {
    const f = cadFeaturesFromDrawing(drawing)
    expect(cadFeaturesSchema.parse(f)).toEqual({ format: 'step', units: 'mm', bbox_mm: [120, 80, 10], hole_estimate: 6, counts: { faces: 42 } })
    expect('product_name' in f).toBe(false)
  })
  it('mfg spec is strict and optional per field', () => {
    expect(mfgSpecSchema.safeParse({ process: 'cnc_machining', material: 'SS304', tolerance: '±0.05 mm', inspection: 'first_article' }).success).toBe(true)
    expect(mfgSpecSchema.safeParse({}).success).toBe(true)
    expect(mfgSpecSchema.safeParse({ process: 'welding-magic' }).success).toBe(false)
    expect(mfgSpecSchema.safeParse({ colour: 'red' }).success).toBe(false)
  })
  it('deliverables: typed rows pick the reader\'s language; prose rows stay', () => {
    const typed = { label_i18n: { en: 'GST filing acknowledgement', te: 'GST ఫైలింగ్ రసీదు' }, format: 'filing_ack' }
    expect(deliverableLabel(typed, 'te')).toBe('GST ఫైలింగ్ రసీదు')
    expect(deliverableLabel(typed, 'ta')).toBe('GST filing acknowledgement')
    expect(deliverableLabel('Signed audit report', 'hi')).toBe('Signed audit report')
    expect(deliverableFormat(typed)).toBe('filing_ack')
    expect(deliverableFormat('prose')).toBeNull()
    expect(packageDeliverableSchema.safeParse({ label_i18n: { hi: 'x' } }).success).toBe(false)
    expect(deliverableLabel(42, 'en')).toBeNull()
  })
})

describe('E15 F10 — shadow rules', () => {
  it('the CAD band grows with size and holes; error is 0 inside, the edge distance outside', () => {
    const small = cadPriceBand({ ...cadFeaturesFromDrawing(drawing) })
    const big = cadPriceBand({ ...cadFeaturesFromDrawing(drawing), bbox_mm: [1000, 800, 400], hole_estimate: 20 })
    expect(small.basis.sizeClass).toBe('small') // 120 × 80 × 10 = 96,000 mm³
    expect(big.lowPaise).toBeGreaterThan(small.highPaise)
    expect(small.lowPaise % 100_00).toBe(0)
    expect(cadBandError(small, Math.round((small.lowPaise + small.highPaise) / 2))).toBe(0)
    expect(cadBandError({ lowPaise: 1000_00, highPaise: 2000_00 }, 4000_00)).toBe(0.5)
    expect(cadBandError({ lowPaise: 1000_00, highPaise: 2000_00 }, 500_00)).toBe(1)
  })
  it('fit rules: must-haves and track record move the score; capped at 100', () => {
    const base = { providerLanguages: ['en', 'te'], providerCredentials: ['icai'], mustHaves: null, completedOrders: 0, avgRating: null, reviewCount: 0, nextAvailableOn: null, todayIst: '2026-09-23' }
    expect(providerFitRules(base).fitPct).toBe(80)
    expect(providerFitRules({ ...base, mustHaves: { credentials: ['icsi'], languages: ['ta'], onSite: false, inStateOnly: false } }).fitPct).toBe(50)
    expect(providerFitRules({ ...base, completedOrders: 9, avgRating: 4.8, reviewCount: 5 }).fitPct).toBe(100)
    expect(providerFitRules({ ...base, nextAvailableOn: '2026-10-30' }).reasons).not.toContain('available')
    expect(fitError(80, { quoted: true })).toBe(0.2)
    expect(fitError(80, { quoted: false })).toBe(0.8)
  })
  it('the weekly report buckets predictions and averages resolved errors', () => {
    const now = '2026-09-23T12:00:00Z'
    const r = weeklyShadowReport([
      { created_at: '2026-09-22T10:00:00Z', resolved_at: '2026-09-23T10:00:00Z', error: 0.2 },
      { created_at: '2026-09-21T10:00:00Z', resolved_at: '2026-09-22T10:00:00Z', error: 0 },
      { created_at: '2026-09-20T10:00:00Z', resolved_at: null, error: null },
      { created_at: '2026-09-10T10:00:00Z', resolved_at: '2026-09-12T10:00:00Z', error: 1 },
    ], now, 3)
    expect(r[0]).toMatchObject({ predicted: 3, resolved: 2, meanError: 0.1 })
    expect(r[1]).toMatchObject({ predicted: 1, resolved: 1, meanError: 1 })
    expect(r[2]).toMatchObject({ predicted: 0, resolved: 0, meanError: null })
  })
})
