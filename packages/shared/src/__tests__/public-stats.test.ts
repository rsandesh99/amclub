import { describe, expect, it } from 'vitest'
import { formatStatPct, headlineStat, onTimePct, PUBLIC_STAT_FIELD_NAMES, publicStatsView, type PublicStatsRow } from '../public-stats'
import { scoreFieldPaths, SCORE_FIELD_NAMES } from '../score'

const row: PublicStatsRow = {
  completed_orders: 214, on_time_pct: 91.67, on_time_n: 12, repeat_buyer_pct: 38, repeat_n: 54,
  response_rate_pct: 80, response_n: 4, computed_at: '2026-09-23T00:00:00Z',
}

describe('public measured stats (N9, D1)', () => {
  it('is null while switched off (the D1 default)', () => {
    expect(publicStatsView(row, { enabled: false, minN: 10 })).toBeNull()
  })
  it('gates each stat on its own sample', () => {
    const v = publicStatsView(row, { enabled: true, minN: 10 })!
    expect(v.onTime).toEqual({ pct: 92, n: 12 })
    expect(v.repeatBuyers).toEqual({ pct: 38, n: 54 })
    expect(v.responseRate).toBeNull() // n = 4 < 10
  })
  it('never lets settings loosen the floor below 5', () => {
    expect(publicStatsView({ ...row, response_n: 4 }, { enabled: true, minN: 1 })!.responseRate).toBeNull()
  })
  it('fixture truth: 11 of 12 on time → 92 %', () => expect(onTimePct(11, 12)).toBe(92))
  it('headline: on-time first, then repeat buyers, else nothing', () => {
    expect(headlineStat(publicStatsView(row, { enabled: true, minN: 10 }))?.kind).toBe('on_time')
    expect(headlineStat(publicStatsView({ ...row, on_time_n: 3 }, { enabled: true, minN: 10 }))?.kind).toBe('repeat_buyers')
    expect(headlineStat(publicStatsView({ ...row, on_time_n: 3, repeat_n: 3 }, { enabled: true, minN: 10 }))).toBeNull()
  })
  it('the allow-list never overlaps a score field, and a view carries no score field', () => {
    for (const f of PUBLIC_STAT_FIELD_NAMES) expect(SCORE_FIELD_NAMES as readonly string[]).not.toContain(f)
    expect(scoreFieldPaths(publicStatsView(row, { enabled: true, minN: 10 }))).toEqual([])
  })
  it('percent formatting', () => {
    expect(formatStatPct(96)).toBe('96')
    expect(formatStatPct(7.5)).toBe('7.5')
  })
})

import { computeProviderPublicStats, type StatsOrderInput } from '../public-stats'
describe('computeProviderPublicStats (nightly)', () => {
  const now = Date.parse('2026-09-23T00:00:00Z')
  const day = 86400000
  const iso = (t: number) => new Date(t).toISOString()
  it('12 deliveries, 11 on time → 91.67 (shown as 92 %, n = 12)', () => {
    const orders: StatsOrderInput[] = Array.from({ length: 12 }, (_, i) => ({
      id: `o${i}`, providerId: 'p', msmeId: `b${i % 6}`, status: 'completed', createdAt: iso(now - 20 * day),
      dueAt: iso(now - 10 * day), firstDeliveredAt: iso(now - 10 * day + (i === 0 ? day : -day)),
    }))
    const r = computeProviderPublicStats('p', orders, [], now)
    expect(r).toMatchObject({ completed_orders: 12, on_time_n: 12, on_time_pct: 91.67, repeat_n: 6, repeat_buyer_pct: 100 })
    expect(publicStatsView(r, { enabled: true, minN: 10 })!.onTime).toEqual({ pct: 92, n: 12 })
  })
  it('response rate: quoted or declined-with-reason within 48 h; too-young matches are not judged', () => {
    const r = computeProviderPublicStats('p', [], [
      { providerId: 'p', rfqId: 'r1', notifiedAt: iso(now - 10 * day), quotedAt: iso(now - 10 * day + 3600e3), declinedAt: null, declineReason: null },
      { providerId: 'p', rfqId: 'r2', notifiedAt: iso(now - 10 * day), quotedAt: null, declinedAt: iso(now - 10 * day + 3600e3), declineReason: 'capacity' },
      { providerId: 'p', rfqId: 'r3', notifiedAt: iso(now - 10 * day), quotedAt: iso(now - 5 * day), declinedAt: null, declineReason: null },
      { providerId: 'p', rfqId: 'r4', notifiedAt: iso(now - day), quotedAt: null, declinedAt: null, declineReason: null },
    ], now)
    expect(r).toMatchObject({ response_n: 3, response_rate_pct: 66.67 })
  })
  it('other providers’ rows never count', () => {
    expect(computeProviderPublicStats('p', [{ id: 'x', providerId: 'q', msmeId: 'b', status: 'completed', createdAt: iso(now), dueAt: null, firstDeliveredAt: null }], [], now).completed_orders).toBe(0)
  })
})

import { isActiveThisWeek, LAST_SEEN_THROTTLE_MS, shouldTouchLastSeen } from '../public-stats'
describe('activity (N11)', () => {
  it('writes last_seen at most once per 15 minutes', () => {
    const t0 = Date.parse('2026-09-23T10:00:00Z')
    expect(shouldTouchLastSeen(null, t0)).toBe(true)
    expect(shouldTouchLastSeen(t0, t0 + LAST_SEEN_THROTTLE_MS - 1)).toBe(false)
    expect(shouldTouchLastSeen(t0, t0 + LAST_SEEN_THROTTLE_MS)).toBe(true)
  })
  it('active this week = seen in the last 7 days', () => {
    const now = Date.parse('2026-09-23T10:00:00Z')
    expect(isActiveThisWeek('2026-09-17T10:00:00Z', now)).toBe(true)
    expect(isActiveThisWeek('2026-09-15T10:00:00Z', now)).toBe(false)
    expect(isActiveThisWeek(null, now)).toBe(false)
  })
})

import { deriveAvailability } from '../public-stats'
describe('availability (N11)', () => {
  const base = { capacityPaused: false, nextAvailableOn: null, capacitySlots: 5, activeOrders: 2, earliestDueAt: null, today: '2026-09-23' }
  it('paused wins', () => expect(deriveAvailability({ ...base, capacityPaused: true })).toEqual({ kind: 'paused' }))
  it('the provider’s own future date', () => expect(deriveAvailability({ ...base, nextAvailableOn: '2026-09-29' })).toEqual({ kind: 'from', date: '2026-09-29' }))
  it('a past date is ignored', () => expect(deriveAvailability({ ...base, nextAvailableOn: '2026-09-01' })).toEqual({ kind: 'from', date: '2026-09-23' }))
  it('under capacity → today', () => expect(deriveAvailability(base)).toEqual({ kind: 'from', date: '2026-09-23' }))
  it('at capacity → the earliest due date (IST day)', () => {
    expect(deriveAvailability({ ...base, activeOrders: 5, earliestDueAt: '2026-09-28T20:00:00Z' })).toEqual({ kind: 'from', date: '2026-09-29' })
  })
})
