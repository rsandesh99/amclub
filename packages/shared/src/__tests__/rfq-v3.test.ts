import { describe, expect, it } from 'vitest'
import { rfqQualityPrecheck, type RfqQualityPrecheckInput } from '../rfq-quality'
import {
  rfqQualityScore,
  scoreFromPrecheck,
  RFQ_SCORE_PENALTY,
  rfqMustHavesSchema,
  isEmptyMustHaves,
  parseRfqPrefill,
  budgetBandOf,
  RFQ_BUDGET_BANDS,
  quoteSlaHours,
} from '../rfq-v3'
import type { RfqTemplate } from '../index'

const TEMPLATE: RfqTemplate = {
  fields: [
    { name: 'filing_type', type: 'select', label_en: 'Filing', required: true, options: ['GSTR-1', 'GSTR-3B', 'Annual'] },
    { name: 'turnover', type: 'select', label_en: 'Turnover', required: true, options: ['<40L', '40L–1.5Cr', '>1.5Cr'] },
    { name: 'city', type: 'text', label_en: 'City', required: false },
    { name: 'notes', type: 'textarea', label_en: 'Notes', required: false },
  ],
} as RfqTemplate

// 40 fixtures: every combination of title / details / budget / deadline / duplicate.
const titles = ['GST', 'GST returns FY 25-26 for my trading firm', 'Need GST filing, call 9876543210', 'GST returns for FY 25-26 monthly']
const detailSets: Record<string, unknown>[] = [
  {},
  { filing_type: 'GSTR-3B' },
  { filing_type: 'GSTR-3B', turnover: '<40L' },
  { filing_type: 'GSTR-3B', turnover: '<40L', city: 'Hyderabad', notes: 'Monthly GSTR-1 and 3B for a trading business with about 200 invoices a month, need by 10th' },
  { filing_type: 'GSTR-1', turnover: '>1.5Cr', notes: 'short' },
]
const FIXTURES: RfqQualityPrecheckInput[] = []
for (const title of titles) for (const details of detailSets) {
  FIXTURES.push({ categorySlug: 'tax-accounting', template: TEMPLATE, title, details, budgetMinPaise: null, budgetMaxPaise: null, neededBy: null, recentOpenSameCategory: false })
  FIXTURES.push({ categorySlug: 'tax-accounting', template: TEMPLATE, title, details, budgetMinPaise: 200_000, budgetMaxPaise: 500_000, neededBy: '2026-10-10', recentOpenSameCategory: FIXTURES.length % 3 === 0 })
}

describe('rfqQualityScore = the server pre-check (FR-6.2, 40 fixtures)', () => {
  it('has 40 fixtures', () => expect(FIXTURES.length).toBe(40))
  it('client score equals the score of the server rules on every fixture', () => {
    for (const f of FIXTURES) {
      const server = rfqQualityPrecheck(f)
      const client = rfqQualityScore(f)
      expect(client).toEqual(scoreFromPrecheck(server))
      const findings = server.missingRequired.length + server.gaps.length + server.risks.filter((r) => RFQ_SCORE_PENALTY.risk[r] > 0).length
      expect(client.score === 100).toBe(findings === 0)
      if (client.next) expect(client.next.gain).toBeGreaterThan(0)
    }
  })
  it('points at the biggest fix first', () => {
    const r = rfqQualityScore(FIXTURES[0]!)
    expect(r.next?.reason).toBe('required')
    expect(r.score).toBeLessThan(50)
  })
  it('a complete request is strong', () => {
    const full = FIXTURES.find((f) => f.neededBy && f.title.includes('trading firm') && (f.details as Record<string, unknown>)['city'])!
    expect(rfqQualityScore(full).bucket).toBe('strong')
  })
})

describe('must-haves (FR-6.4)', () => {
  it('defaults to empty; never PAN or bank; ≤ 5 each', () => {
    const empty = rfqMustHavesSchema.parse({})
    expect(isEmptyMustHaves(empty)).toBe(true)
    expect(rfqMustHavesSchema.safeParse({ credentials: ['pan'] }).success).toBe(false)
    expect(rfqMustHavesSchema.safeParse({ credentials: ['icai'], languages: ['te'], onSite: true }).success).toBe(true)
    expect(rfqMustHavesSchema.safeParse({ extra: 1 }).success).toBe(false)
  })
})

describe('prefill contract (FR-6.6)', () => {
  it('keeps each valid key and drops the rest', () => {
    expect(parseRfqPrefill({ q: ' GST returns ', category: 'tax-accounting', service: 'gst-filing', entry: 'search' })).toEqual({ q: 'GST returns', category: 'tax-accounting', service: 'gst-filing', entry: 'search' })
    expect(parseRfqPrefill({ category: 'nope', service: 'x', from_package: 'not-a-uuid', from_provider: 'Bad Slug!' })).toEqual({})
  })
})

describe('budget bands + SLA line', () => {
  it('maps a stored min/max back to its chip', () => {
    expect(budgetBandOf(RFQ_BUDGET_BANDS['2kto5k'].min, RFQ_BUDGET_BANDS['2kto5k'].max)).toBe('2kto5k')
    expect(budgetBandOf(null, 200_000)).toBe('under2k')
    expect(budgetBandOf(123, 456)).toBeNull()
  })
  it('measured only with n ≥ 20; else 72 h', () => {
    expect(quoteSlaHours({ medianMinutes: 530, n: 25 })).toEqual({ hours: 9, measured: true })
    expect(quoteSlaHours({ medianMinutes: 530, n: 19 })).toEqual({ hours: 72, measured: false })
    expect(quoteSlaHours(null)).toEqual({ hours: 72, measured: false })
  })
})
