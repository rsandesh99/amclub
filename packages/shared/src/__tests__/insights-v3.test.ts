import { describe, expect, it } from 'vitest'
import { INSIGHT_DELTA_MIN_N, isReviewFresh, istWeekStart, lossInsight, weeklyBuckets, type LossPair } from '../insights-v3'

const pair = (mine: number, winner: number, md: number | null = 5, wd: number | null = 5): LossPair => ({ mine: { totalPaise: mine, deliveryDays: md }, winner: { totalPaise: winner, deliveryDays: wd } })

describe('E11 insights — why you lost (deltas only, n ≥ 5)', () => {
  it('counts always; the median only from n = 5', () => {
    const four = [pair(110, 100), pair(120, 100), pair(130, 100), pair(90, 100)]
    const a = lossInsight(four)
    expect(a.price).toEqual({ n: 3, of: 4, medianPct: null })
    const many = [pair(110, 100), pair(112, 100), pair(115, 100), pair(120, 100), pair(130, 100), pair(90, 100, 9, 5)]
    const b = lossInsight(many)
    expect(b.price.n).toBe(5)
    expect(b.price.medianPct).toBe(15)
    expect(b.delivery).toEqual({ n: 1, of: 6, medianDays: null })
    expect(INSIGHT_DELTA_MIN_N).toBe(5)
  })
  it('the payload carries only counts and medians (no totals, no names)', () => {
    const out = JSON.stringify(lossInsight([pair(123456, 100000)]))
    expect(out).not.toContain('123456')
    expect(out).not.toContain('100000')
  })
})

describe('E11 weekly funnel buckets', () => {
  it('Monday IST weeks, zero-filled, oldest first', () => {
    expect(istWeekStart('2026-09-23T12:00:00Z')).toBe('2026-09-21') // a Wednesday
    expect(istWeekStart('2026-09-20T19:00:00Z')).toBe('2026-09-21') // Sun 19:00 UTC = Mon 00:30 IST
    const w = weeklyBuckets('2026-09-23T12:00:00Z', 3, { views: [{ day: '2026-09-22', n: 4 }], matched: ['2026-09-15T10:00:00Z'], quoted: [], won: ['2026-09-01T10:00:00Z'] })
    expect(w.map((x) => x.week)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21'])
    expect(w[2]!.views).toBe(4)
    expect(w[1]!.matched).toBe(1)
    expect(w.reduce((a, x) => a + x.won, 0)).toBe(0) // older than the window
  })
})

describe('E11 GeM checklist freshness', () => {
  it('hidden 180 days after the last review, and when never reviewed', () => {
    const now = Date.parse('2026-09-23T00:00:00Z')
    expect(isReviewFresh('2026-04-01T00:00:00Z', now)).toBe(true)
    expect(isReviewFresh('2026-03-01T00:00:00Z', now)).toBe(false)
    expect(isReviewFresh(null, now)).toBe(false)
  })
})
