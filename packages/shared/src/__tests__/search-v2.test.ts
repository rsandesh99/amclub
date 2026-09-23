import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  parseSearchV2,
  searchV2ToQueryString,
  withSearchV2,
  searchV2Window,
  isWeakSearch,
  toSearchFacets,
  searchFeedbackSchema,
  BEST_SORT_SIGNALS,
  type SearchV2,
} from '../search-v2'

const roundTrip = (s: SearchV2) => parseSearchV2(Object.fromEntries(new URLSearchParams(searchV2ToQueryString(s))))

describe('search v2 URL codec (FR-2.1 — every filter round-trips)', () => {
  it('round-trips every key', () => {
    const full: SearchV2 = {
      query: 'gst registration', category: 'tax-accounting', service: 'gst-filing', state: 'TS', city: 'Hyderabad',
      credential: 'icai', responseMaxHours: 4, deliveryMaxDays: 7, price: '2kto5k', minRating: 4.5, language: 'te',
      verifiedOnly: true, sort: 'fastest', view: 'list', page: 3, more: true,
    }
    expect(roundTrip(full)).toEqual(full)
    for (const k of Object.keys(full) as (keyof SearchV2)[]) {
      const one = { [k]: full[k] } as SearchV2
      if (k === 'more') one.page = 2
      expect(roundTrip(one)).toEqual(one)
    }
  })
  it('drops what it does not trust', () => {
    expect(parseSearchV2({ state: 'XX', credential: 'pan', sort: 'paid', price: 'constructor', minRating: '3', service: 'nope', category: 'x', view: 'table', page: '0', language: 'eng', city: '<script>' })).toEqual({})
  })
  it('keeps v1 links working (offset → page) and lower-case states', () => {
    expect(parseSearchV2({ offset: '48', state: 'ts' })).toEqual({ page: 3, state: 'TS' })
  })
  it('a filter change goes back to page 1; a view change does not', () => {
    const s: SearchV2 = { query: 'x', page: 3 }
    expect(withSearchV2(s, 'state', 'TS')).toEqual({ query: 'x', state: 'TS' })
    expect(withSearchV2(s, 'view', 'list')).toEqual({ query: 'x', page: 3, view: 'list' })
  })
})

describe('paging (FR-2.10)', () => {
  it('numbered pages show one page; load more shows 1..N capped', () => {
    expect(searchV2Window({ page: 3 })).toEqual({ limit: 24, offset: 48 })
    expect(searchV2Window({ page: 2, more: true })).toEqual({ limit: 48, offset: 0 })
    expect(searchV2Window({ page: 9, more: true })).toEqual({ limit: 96, offset: 0 })
  })
})

describe('weak results (FR-2.7)', () => {
  it('fewer than 3, or every result below the rank threshold', () => {
    expect(isWeakSearch({ total: 2, topRank: 0.4, hasQuery: true })).toBe(true)
    expect(isWeakSearch({ total: 30, topRank: 0.01, hasQuery: true })).toBe(true)
    expect(isWeakSearch({ total: 30, topRank: 0.01, hasQuery: false })).toBe(false)
    expect(isWeakSearch({ total: 30, topRank: 0.1, hasQuery: true })).toBe(false)
  })
})

describe('facets', () => {
  it('normalises rating values to the URL form', () => {
    expect(toSearchFacets([{ facet: 'rating', value: '4.0', n: '3' }, { facet: 'state', value: 'TS', n: 4 }, { facet: 'service', value: null, n: 1 }])).toEqual({ rating: { '4': 3 }, state: { TS: 4 } })
  })
})

describe('feedback schema (FR-2.6)', () => {
  it('reason is optional; unknown reasons and > 24 ids are refused', () => {
    expect(searchFeedbackSchema.safeParse({ query: 'x', filters: {}, resultIds: [], helpful: false, reason: null }).success).toBe(true)
    expect(searchFeedbackSchema.safeParse({ query: 'x', filters: {}, resultIds: [], helpful: false, reason: 'ugly' }).success).toBe(false)
    const ids = Array.from({ length: 25 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    expect(searchFeedbackSchema.safeParse({ query: 'x', filters: {}, resultIds: ids, helpful: true, reason: null }).success).toBe(false)
  })
})

describe('best sort never uses a paid signal (FR-2.1)', () => {
  const sql = readFileSync(path.resolve(__dirname, '../../../db/src/migrations/0051_search_v2.sql'), 'utf8')
  const block = sql.slice(sql.indexOf('-- best:begin'), sql.indexOf('-- best:end'))
  const code = block.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  it('the best block exists and names only the allowed signals', () => {
    expect(code).toContain("p_sort = 'best'")
    const columns = [...code.matchAll(/\bb\.([a-z_]+)/g)].map((m) => m[1])
    expect(columns.length).toBeGreaterThan(0)
    for (const c of columns) expect(BEST_SORT_SIGNALS as readonly string[]).toContain(c)
  })
  it('mentions nothing that looks paid', () => {
    expect(code).not.toMatch(/paid|sponsor|promot|boost|featured|advert|\bads?\b|bid|plan|tier|member|commission/i)
  })
})
