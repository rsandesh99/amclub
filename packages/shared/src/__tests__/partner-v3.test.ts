import { describe, expect, it } from 'vitest'
import { applyInboxQuery, budgetOverlapsBand, buildFunnel, inboxQueryToString, isBuyerVerified, parseInboxQuery, viewBeaconSchema, BOT_UA, type InboxFacts } from '../index'

const now = new Date('2026-09-23T12:00:00Z')
const h = (n: number) => new Date(now.getTime() + n * 3600e3).toISOString()
const row = (p: Partial<InboxFacts> & { title: string }): InboxFacts => ({ categorySlug: 'tax-accounting', buyerState: 'TS', budgetMinPaise: null, budgetMaxPaise: null, expiresAt: h(48), buyerVerified: false, hasFiles: false, notifiedAt: h(-1), ...p })

describe('E11 inbox query', () => {
  it('parses known params, drops the rest, and round-trips', () => {
    const q = parseInboxQuery({ tab: 'quoted', category: 'tax-accounting', state: 'ts', budget: '2kto5k', closing: '1', verified: '1', files: '1', q: '  GST ', sort: 'closing', page: '2', evil: 'x' })
    expect(q).toEqual({ tab: 'quoted', page: 2, category: 'tax-accounting', state: 'TS', budget: '2kto5k', closing: true, verified: true, files: true, q: 'GST', sort: 'closing' })
    expect(parseInboxQuery(Object.fromEntries(new URLSearchParams(inboxQueryToString(q))))).toEqual(q)
    expect(parseInboxQuery({ category: 'nope', state: 'XX', budget: 'lots', sort: 'random', tab: 'all' })).toEqual({ tab: 'open', page: 1, sort: 'newest' })
  })

  it('filters never add rows; search, closing-soon, budget overlap, verified, files', () => {
    const items = [
      row({ title: 'GST returns FY 25-26', expiresAt: h(9), budgetMinPaise: 400_000, budgetMaxPaise: 600_000, buyerVerified: true, hasFiles: true }),
      row({ title: 'Factory licence renewal', categorySlug: 'government-licensing', buyerState: 'AP', expiresAt: h(28) }),
      row({ title: 'Payroll setup', expiresAt: h(-1) }),
    ]
    const all = applyInboxQuery(items, parseInboxQuery({}), now)
    expect(all).toHaveLength(3)
    for (const q of [{ q: 'gst' }, { closing: '1' }, { budget: '2kto5k' }, { verified: '1' }, { files: '1' }]) {
      const got = applyInboxQuery(items, parseInboxQuery(q), now)
      expect(got.map((r) => r.title)).toEqual(['GST returns FY 25-26'])
    }
    expect(applyInboxQuery(items, parseInboxQuery({ state: 'AP' }), now).map((r) => r.title)).toEqual(['Factory licence renewal'])
    expect(applyInboxQuery(items, parseInboxQuery({ sort: 'closing' }), now)[0]!.title).toBe('Payroll setup')
  })

  it('a budget band overlaps; no budget never matches', () => {
    expect(budgetOverlapsBand(400_000, 600_000, '5kto10k')).toBe(true)
    expect(budgetOverlapsBand(null, null, '2kto5k')).toBe(false)
    expect(budgetOverlapsBand(3_000_000, null, 'over25k')).toBe(true)
  })
})

describe('E11 buyer verified (D2)', () => {
  it('identity verified AND at least one paid order', () => {
    expect(isBuyerVerified({ udyamVerified: true, gstinVerified: false, paidOrders: 1 })).toBe(true)
    expect(isBuyerVerified({ udyamVerified: false, gstinVerified: true, paidOrders: 0 })).toBe(false)
    expect(isBuyerVerified({ udyamVerified: false, gstinVerified: false, paidOrders: 9 })).toBe(false)
  })
})

describe('E11 funnel', () => {
  it('rates, and decline reasons only with n ≥ 3 (top 3)', () => {
    const f = buildFunnel('7d', { views: 212, matched: 14, quoted: 9, won: 3 }, ['price', 'price', 'price', 'price', 'timeline', 'timeline', 'other'])
    expect(f.quoteRate).toBe(64)
    expect(f.winRate).toBe(33)
    expect(f.declineReasons).toEqual([{ reason: 'price', n: 4 }])
    expect(buildFunnel('30d', { views: 0, matched: 0, quoted: 0, won: 0 }, []).quoteRate).toBeNull()
  })
})

describe('E11 view beacon', () => {
  it('strict payload; bots never count', () => {
    expect(viewBeaconSchema.safeParse({ kind: 'package', id: '11111111-1111-4111-8111-111111111111' }).success).toBe(true)
    expect(viewBeaconSchema.safeParse({ kind: 'package', id: 'x' }).success).toBe(false)
    expect(BOT_UA.test('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true)
    expect(BOT_UA.test('Mozilla/5.0 (Linux; Android 14) Chrome/128 Mobile')).toBe(false)
  })
})
