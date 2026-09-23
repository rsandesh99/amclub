import { describe, expect, it } from 'vitest'
import {
  AGENT_SETTING_DEFS,
  BENCHMARK_DEFAULT_GATES,
  BENCHMARK_LOCALES,
  BENCHMARK_NOTE_BANNED,
  BENCHMARK_VERSION,
  BENCHMARK_WINDOW_DAYS,
  benchmarkGate,
  benchmarkKeyId,
  benchmarkLine,
  benchmarkNoteViolations,
  benchmarkViewSchema,
  computeBenchmark,
  groupBenchmarkKeys,
  isGated,
  nearestRank,
  numbersIn,
  roundBenchmarkPaise,
  type BenchmarkInputRow,
  type BenchmarkSourceRow,
  type BenchmarkStats,
  type BenchmarkView,
} from '../index'

const R = (rupees: number) => rupees * 100
/** n rows spread over `providers` providers and `buyers` buyers, prices from a function of the index. */
function fixture(n: number, providers: number, buyers: number, price: (i: number) => number, days: (i: number) => number | null = () => null): BenchmarkInputRow[] {
  return Array.from({ length: n }, (_, i) => ({ price_paise: price(i), provider_id: `p${i % providers}`, msme_id: `b${i % buyers}`, delivery_days: days(i) }))
}
const good = (days: (i: number) => number | null = () => null) => fixture(40, 10, 12, (i) => R(18_000 + i * 250), days)
const stats = (o: ReturnType<typeof computeBenchmark>): BenchmarkStats => {
  if (isGated(o)) throw new Error(`gated: ${o.gated}`)
  return o
}

describe('S3.2 constants + settings', () => {
  it('version, window and default gates are the brief\'s', () => {
    expect(BENCHMARK_VERSION).toBe('v1')
    expect(BENCHMARK_WINDOW_DAYS).toBe(180)
    expect(BENCHMARK_DEFAULT_GATES).toEqual({ minSample: 30, minProviders: 8, minBuyers: 8, maxProviderShareBps: 2500 })
  })
  it('the six settings are registered with the right defaults (compute + display OFF)', () => {
    expect(AGENT_SETTING_DEFS.benchmark_compute_enabled.default).toBe(false)
    expect(AGENT_SETTING_DEFS.benchmark_display_enabled.default).toBe(false)
    expect(AGENT_SETTING_DEFS.benchmark_min_sample.default).toBe(30)
    expect(AGENT_SETTING_DEFS.benchmark_min_providers.default).toBe(8)
    expect(AGENT_SETTING_DEFS.benchmark_min_buyers.default).toBe(8)
    expect(AGENT_SETTING_DEFS.benchmark_max_provider_share_bps.default).toBe(2500)
  })
  it('the gate settings can only be TIGHTENED (the disclosure copy and the table CHECK state the floor)', () => {
    expect(AGENT_SETTING_DEFS.benchmark_min_sample.schema.safeParse(29).success).toBe(false)
    expect(AGENT_SETTING_DEFS.benchmark_min_sample.schema.safeParse(50).success).toBe(true)
    expect(AGENT_SETTING_DEFS.benchmark_min_providers.schema.safeParse(7).success).toBe(false)
    expect(AGENT_SETTING_DEFS.benchmark_min_buyers.schema.safeParse(7).success).toBe(false)
    expect(AGENT_SETTING_DEFS.benchmark_max_provider_share_bps.schema.safeParse(2600).success).toBe(false)
    expect(AGENT_SETTING_DEFS.benchmark_max_provider_share_bps.schema.safeParse(2000).success).toBe(true)
  })
})

describe('nearest-rank percentiles', () => {
  it('p25 / p50 / p75 on 1..8 are 2 / 4 / 6', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8]
    expect([nearestRank(a, 25), nearestRank(a, 50), nearestRank(a, 75)]).toEqual([2, 4, 6])
  })
  it('a single value is every percentile; an empty array throws', () => {
    expect(nearestRank([7], 25)).toBe(7)
    expect(nearestRank([7], 75)).toBe(7)
    expect(() => nearestRank([], 50)).toThrow()
  })
})

describe('rounding', () => {
  it('below ₹10,000 → nearest ₹100 (halves up)', () => {
    expect(roundBenchmarkPaise(R(4_349))).toBe(R(4_300))
    expect(roundBenchmarkPaise(R(4_350))).toBe(R(4_400))
    expect(roundBenchmarkPaise(R(9_999))).toBe(R(10_000))
  })
  it('₹10,000 to below ₹1,00,000 → nearest ₹500', () => {
    expect(roundBenchmarkPaise(R(10_000))).toBe(R(10_000))
    expect(roundBenchmarkPaise(R(18_249))).toBe(R(18_000))
    expect(roundBenchmarkPaise(R(18_250))).toBe(R(18_500))
    expect(roundBenchmarkPaise(R(99_700))).toBe(R(99_500))
    expect(roundBenchmarkPaise(R(99_750))).toBe(R(1_00_000))
  })
  it('₹1,00,000 and above → nearest ₹1,000', () => {
    expect(roundBenchmarkPaise(R(1_00_000))).toBe(R(1_00_000))
    expect(roundBenchmarkPaise(R(1_00_499))).toBe(R(1_00_000))
    expect(roundBenchmarkPaise(R(1_00_500))).toBe(R(1_01_000))
    expect(roundBenchmarkPaise(R(12_34_567))).toBe(R(12_35_000))
  })
  it('never below one step, never ₹0 (tiny and invalid values → ₹100)', () => {
    expect(roundBenchmarkPaise(R(30))).toBe(R(100))
    expect(roundBenchmarkPaise(0)).toBe(R(100))
    expect(roundBenchmarkPaise(Number.NaN)).toBe(R(100))
  })
  it('monotonic across both step boundaries (a ≤ b ⇒ round(a) ≤ round(b))', () => {
    const vals = [9_900, 9_949, 9_950, 9_999, 10_000, 10_001, 10_249, 10_250, 99_499, 99_500, 99_749, 99_750, 99_999, 1_00_000, 1_00_499, 1_00_500].map(R)
    for (let i = 1; i < vals.length; i++) expect(roundBenchmarkPaise(vals[i]!)).toBeGreaterThanOrEqual(roundBenchmarkPaise(vals[i - 1]!))
  })
  it('monotonic on a dense sweep', () => {
    let prev = 0
    for (let v = R(50); v <= R(3_00_000); v += 3_700) {
      const r = roundBenchmarkPaise(v)
      expect(r).toBeGreaterThanOrEqual(prev)
      prev = r
    }
  })
})

describe('the privacy gates', () => {
  it('a healthy key passes', () => {
    expect(benchmarkGate(good(), BENCHMARK_DEFAULT_GATES)).toBeNull()
  })
  it('the sample gate fails alone (29 jobs, 10 providers, 10 buyers)', () => {
    expect(computeBenchmark(fixture(29, 10, 10, () => R(20_000)))).toEqual({ gated: 'sample' })
  })
  it('the providers gate fails alone (40 jobs, 7 providers — share still ≤ 25 % is impossible, so check the order)', () => {
    // 7 providers over 40 jobs → the providers gate fires before the share gate
    expect(computeBenchmark(fixture(40, 7, 12, () => R(20_000)))).toEqual({ gated: 'providers' })
  })
  it('the buyers gate fails alone (40 jobs, 10 providers, 7 buyers)', () => {
    expect(computeBenchmark(fixture(40, 10, 7, () => R(20_000)))).toEqual({ gated: 'buyers' })
  })
  it('the share cap fails alone: one provider at 30 % of 40 jobs, 10 providers, 12 buyers', () => {
    const rows = fixture(40, 10, 12, () => R(20_000)).map((r, i) => (i < 12 ? { ...r, provider_id: 'dominant' } : { ...r, provider_id: `p${i % 9}` }))
    expect(new Set(rows.map((r) => r.provider_id)).size).toBe(10)
    expect(computeBenchmark(rows)).toEqual({ gated: 'provider_share' })
  })
  it('exactly 25 % passes (10 of 40); 26 % fails', () => {
    const at25 = fixture(40, 10, 12, () => R(20_000)).map((r, i) => (i < 10 ? { ...r, provider_id: 'big' } : { ...r, provider_id: `p${i % 9}` }))
    expect(isGated(computeBenchmark(at25))).toBe(false)
    const over = fixture(50, 10, 12, () => R(20_000)).map((r, i) => (i < 13 ? { ...r, provider_id: 'big' } : { ...r, provider_id: `p${i % 9}` }))
    expect(computeBenchmark(over)).toEqual({ gated: 'provider_share' })
  })
  it('the gates come from the settings (a tightened min sample gates a key that passes the default)', () => {
    const rows = fixture(40, 10, 12, () => R(20_000))
    expect(isGated(computeBenchmark(rows))).toBe(false)
    expect(computeBenchmark(rows, { ...BENCHMARK_DEFAULT_GATES, minSample: 50 })).toEqual({ gated: 'sample' })
  })
  it('invalid rows never count (zero / negative / fractional price, empty ids)', () => {
    const rows = [...fixture(29, 10, 10, () => R(20_000)), { price_paise: 0, provider_id: 'x', msme_id: 'y', delivery_days: null }, { price_paise: 12.5, provider_id: 'x', msme_id: 'y', delivery_days: null }, { price_paise: R(1), provider_id: '', msme_id: 'y', delivery_days: null }]
    expect(computeBenchmark(rows)).toEqual({ gated: 'sample' })
  })
})

describe('computeBenchmark', () => {
  it('the brief fixture: 40 jobs, 10 providers, 12 buyers → rounded nearest-rank percentiles', () => {
    const s = stats(computeBenchmark(good()))
    // prices ₹18,000 + i×₹250, i = 0..39: p25 = rank 10 → ₹20,250 → ₹20,500; p50 = rank 20 → ₹22,750 → ₹23,000; p75 = rank 30 → ₹25,250 → ₹25,500
    expect([s.p25_paise, s.p50_paise, s.p75_paise]).toEqual([R(20_500), R(23_000), R(25_500)])
    expect([s.sample_n, s.providers_n, s.buyers_n]).toEqual([40, 10, 12])
  })
  it('monotonic p25 ≤ p50 ≤ p75 on adversarial inputs (all equal, two clusters, reversed, one huge outlier)', () => {
    const cases: ((i: number) => number)[] = [() => R(20_000), (i) => (i % 2 ? R(9_990) : R(10_010)), (i) => R(60_000 - i * 1_000), (i) => (i === 39 ? R(9_00_00_000) : R(15_000))]
    for (const price of cases) {
      const s = stats(computeBenchmark(fixture(40, 10, 12, price)))
      expect(s.p25_paise).toBeLessThanOrEqual(s.p50_paise)
      expect(s.p50_paise).toBeLessThanOrEqual(s.p75_paise)
    }
  })
  it('one huge outlier does not move p75 (nearest rank, not a mean)', () => {
    const s = stats(computeBenchmark(fixture(40, 10, 12, (i) => (i === 39 ? R(9_00_00_000) : R(15_000)))))
    expect(s.p75_paise).toBe(R(15_000))
  })
  it('input order does not matter', () => {
    const rows = good()
    expect(computeBenchmark([...rows].reverse())).toEqual(computeBenchmark(rows))
  })
  it('no delivery data → the delivery range is null (the line omits "typically in")', () => {
    const s = stats(computeBenchmark(good()))
    expect([s.median_delivery_days, s.p25_delivery_days, s.p75_delivery_days]).toEqual([null, null, null])
  })
  it('delivery range from the delivered subset, days rounded up', () => {
    const s = stats(computeBenchmark(good((i) => 4.2 + (i % 5))))
    // ceil(4.2..8.2) = 5..9 in a repeating pattern → p25 6, p50 7, p75 8
    expect([s.p25_delivery_days, s.median_delivery_days, s.p75_delivery_days]).toEqual([6, 7, 8])
  })
  it('a delivered subset below the gates keeps the days null (a handful of deliveries is never readable)', () => {
    const s = stats(computeBenchmark(good((i) => (i < 5 ? 3 : null))))
    expect(s.median_delivery_days).toBeNull()
  })
  it('negative delivery days are ignored', () => {
    const s = stats(computeBenchmark(good((i) => (i < 5 ? -2 : 6))))
    expect(s.median_delivery_days).toBe(6)
  })
})

describe('keys', () => {
  const src = (n: number, state: string | null, cat = 'tax-accounting'): BenchmarkSourceRow[] => fixture(n, 10, 12, () => R(20_000)).map((r) => ({ ...r, category_slug: cat, state }))
  it('a stateful row counts in its state key AND the national key; a stateless row only nationally', () => {
    const g = groupBenchmarkKeys([...src(3, 'TS'), ...src(2, null)])
    expect(g.get('tax-accounting|state|TS')?.rows.length).toBe(3)
    expect(g.get('tax-accounting|national|')?.rows.length).toBe(5)
    expect(g.size).toBe(2)
  })
  it('categories never mix', () => {
    const g = groupBenchmarkKeys([...src(2, 'TS', 'a'), ...src(2, 'TS', 'b')])
    expect([...g.keys()].sort()).toEqual(['a|national|', 'a|state|TS', 'b|national|', 'b|state|TS'])
  })
  it('the key id is stable', () => {
    expect(benchmarkKeyId({ category_slug: 'x', scope: 'national', state: null })).toBe('x|national|')
  })
})

const VIEW: BenchmarkView = {
  category_slug: 'tax-accounting', scope: 'state', state: 'TS', p25_paise: R(18_000), p50_paise: R(22_000), p75_paise: R(26_000),
  median_delivery_days: 7, p25_delivery_days: 5, p75_delivery_days: 9, sample_n: 34, providers_n: 11, computed_at: '2026-09-23T04:15:00Z', note: null,
}

describe('the view + the line', () => {
  it('the view schema is strict and carries no id', () => {
    expect(benchmarkViewSchema.safeParse(VIEW).success).toBe(true)
    expect(benchmarkViewSchema.safeParse({ ...VIEW, provider_id: 'x' }).success).toBe(false)
    expect(benchmarkViewSchema.safeParse({ ...VIEW, order_ids: [] }).success).toBe(false)
    expect(Object.keys(benchmarkViewSchema.shape).some((k) => /(^|_)id(s)?$/.test(k))).toBe(false)
  })
  it('the brief line in English (state)', () => {
    expect(benchmarkLine(VIEW, 'en')).toBe('Similar jobs in Telangana closed at ₹18,000–₹26,000, typically in 5–9 days (based on 34 paid jobs from 11 providers).')
  })
  it('the national variant says "across India"', () => {
    expect(benchmarkLine({ ...VIEW, scope: 'national', state: null }, 'en')).toMatch(/^Similar jobs across India closed at ₹18,000–₹26,000/)
  })
  it('no delivery data → no "typically in" clause; equal days → one number', () => {
    expect(benchmarkLine({ ...VIEW, p25_delivery_days: null, p75_delivery_days: null }, 'en')).toBe('Similar jobs in Telangana closed at ₹18,000–₹26,000 (based on 34 paid jobs from 11 providers).')
    expect(benchmarkLine({ ...VIEW, p25_delivery_days: 7, p75_delivery_days: 7 }, 'en')).toContain('typically in 7 days')
  })
  it('all four locales render the numbers, the place and no hole', () => {
    for (const l of BENCHMARK_LOCALES) {
      const line = benchmarkLine(VIEW, l)
      expect(line).toContain('₹18,000')
      expect(line).toContain('₹26,000')
      expect(line).toContain('34')
      expect(line).toContain('11')
      expect(line).toContain('Telangana')
      expect(line).not.toMatch(/undefined|null|\{|\}/)
    }
  })
  it('an unknown locale falls back to English', () => {
    expect(benchmarkLine(VIEW, 'fr')).toBe(benchmarkLine(VIEW, 'en'))
  })
})

describe('the note policy (benchmark_explain@v1)', () => {
  it('a plain sentence using only the row\'s numbers passes', () => {
    expect(benchmarkNoteViolations('Most of the 34 similar jobs here were priced between ₹18,000 and ₹26,000, with ₹22,000 in the middle.', VIEW)).toEqual([])
  })
  it('a number that is not in the row is a violation (₹20,000 was never in the row)', () => {
    expect(benchmarkNoteViolations('Most jobs cost about ₹20,000.', VIEW)).toContain('number_not_in_row')
  })
  it('Indic digits are folded before the check', () => {
    expect(benchmarkNoteViolations('३४ कामों में ज़्यादातर ₹18,000 से ₹26,000 के बीच रहे।', VIEW)).toEqual([])
    expect(benchmarkNoteViolations('३५ कामों में।', VIEW)).toContain('number_not_in_row')
  })
  it('advice words are banned in every locale', () => {
    expect(benchmarkNoteViolations('You should pay around ₹22,000.', VIEW)).toContain('banned_word')
    expect(benchmarkNoteViolations('Anything above ₹26,000 is overpriced.', VIEW)).toContain('banned_word')
    expect(benchmarkNoteViolations('Try to negotiate below ₹22,000.', VIEW)).toContain('banned_word')
    expect(benchmarkNoteViolations('₹18,000 वाला सस्ता है।', VIEW)).toContain('banned_word')
    expect(benchmarkNoteViolations('₹18,000 చౌక.', VIEW)).toContain('banned_word')
    expect(benchmarkNoteViolations('₹18,000 மலிவு.', VIEW)).toContain('banned_word')
  })
  it('"inexpensive" style words inside other words are not a hit; an empty note is', () => {
    expect(benchmarkNoteViolations('Jobs ranged from ₹18,000 to ₹26,000.', VIEW)).toEqual([])
    expect(benchmarkNoteViolations('   ', VIEW)).toEqual(['empty'])
  })
  it('every locale has a banned list', () => {
    for (const l of BENCHMARK_LOCALES) expect(BENCHMARK_NOTE_BANNED[l].length).toBeGreaterThan(5)
  })
  it('numbersIn folds grouping and decimals', () => {
    expect(numbersIn('₹1,00,000 and 2.5 days, 34 jobs')).toEqual([100000, 2.5, 34])
  })
})
