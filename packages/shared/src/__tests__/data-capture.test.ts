import { describe, expect, it } from 'vitest'
import { declaredVsActual, intakeCorrections, normaliseSearch, sampledSearch, searchAttributionSchema, synonymKey } from '../index'

describe('E15 F5 — search telemetry', () => {
  it('sampling is deterministic per id and honours 0 / 100', () => {
    const id = '5b3c9d9e-1f2a-4b3c-8d4e-5f6a7b8c9d0e'
    expect(sampledSearch(id, 20)).toBe(sampledSearch(id, 20))
    expect(sampledSearch(id, 0)).toBe(false)
    expect(sampledSearch(id, 100)).toBe(true)
    const n = Array.from({ length: 2000 }, (_, i) => sampledSearch(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 20)).filter(Boolean).length
    expect(n).toBeGreaterThan(300)
    expect(n).toBeLessThan(500)
  })
  it('normalises the query and drops paging / view', () => {
    const r = normaliseSearch({ query: '  GST   Filing ', category: 'tax-accounting', page: 3, view: 'list' })
    expect(r.query).toBe('gst filing')
    expect(r.params).toEqual({ category: 'tax-accounting' })
  })
  it('attribution is a strict id + position', () => {
    expect(searchAttributionSchema.safeParse({ search_id: '5b3c9d9e-1f2a-4b3c-8d4e-5f6a7b8c9d0e', position: 2 }).success).toBe(true)
    expect(searchAttributionSchema.safeParse({ search_id: 'x' }).success).toBe(false)
    expect(searchAttributionSchema.safeParse({ search_id: '5b3c9d9e-1f2a-4b3c-8d4e-5f6a7b8c9d0e', user_id: 'u' }).success).toBe(false)
  })
})

describe('E15 F4 — declared vs actual', () => {
  it('flags only above 50 % outside, at n ≥ 5', () => {
    expect(declaredVsActual(['tax'], ['legal', 'legal', 'legal', 'tax', 'tax'])).toMatchObject({ n: 5, outside: 3, share: 0.6, flag: true, topActual: 'legal' })
    expect(declaredVsActual(['tax'], ['legal', 'legal', 'legal', 'legal'])).toMatchObject({ n: 4, flag: false })
    expect(declaredVsActual(['tax'], ['legal', 'legal', 'tax', 'tax'])).toMatchObject({ share: 0.5, flag: false })
    expect(declaredVsActual(['tax'], [])).toMatchObject({ n: 0, share: null, flag: false, topActual: null })
  })
})

describe('E15 F6 — corpora helpers', () => {
  it('synonym keys fold case, width and punctuation', () => {
    expect(synonymKey('  GST  Return-Filing! ')).toBe('gst return filing')
    expect(synonymKey('జీఎస్టీ   ఫైలింగ్')).toBe('జీఎస్టీ ఫైలింగ్')
  })
  it('intake corrections list only what the buyer changed', () => {
    expect(intakeCorrections({ suggested_title: 'GST notice reply', suggested_category_slug: 'legal' }, { title: 'GST notice reply', categorySlug: 'tax-accounting' })).toEqual(['category'])
    expect(intakeCorrections(null, { title: 'x', categorySlug: null })).toEqual([])
  })
})
