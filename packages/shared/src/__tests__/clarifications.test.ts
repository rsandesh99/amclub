import { describe, expect, it } from 'vitest'
import {
  AGENT_TOOLS,
  CLARIFICATION_MAX_OPEN_PER_PROVIDER,
  MAX_QUOTE_REVISIONS,
  agentTool,
  clarificationAnswerSchema,
  clarificationAskSchema,
  clarificationViewSchema,
  hoursToAnswer,
  isInClarification,
  openQuestionCount,
  quoteRevisionSchema,
  quoteSchema,
  sortClarifications,
  type ClarificationView,
} from '../index'

const U = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const view = (over: Partial<ClarificationView> = {}): ClarificationView => ({
  id: U(1), question: 'Is the price inclusive of filing fees?', answer: null, askedAt: '2026-09-20T10:00:00.000Z', answeredAt: null,
  mine: false, questionRedacted: false, answerRedacted: false, ...over,
})

describe('S1.3 clarification schemas', () => {
  it('ask: trims, needs 10–500 chars', () => {
    expect(clarificationAskSchema.safeParse({ question: '  Is GST included in the quoted price?  ' }).success).toBe(true)
    expect(clarificationAskSchema.parse({ question: '  Is GST included?  ' }).question).toBe('Is GST included?')
    expect(clarificationAskSchema.safeParse({ question: 'too short' }).success).toBe(false)
    expect(clarificationAskSchema.safeParse({ question: 'x'.repeat(501) }).success).toBe(false)
    expect(clarificationAskSchema.safeParse({}).success).toBe(false)
  })
  it('answer: trims, 1–1000 chars', () => {
    expect(clarificationAnswerSchema.parse({ answer: ' Yes ' }).answer).toBe('Yes')
    expect(clarificationAnswerSchema.safeParse({ answer: '   ' }).success).toBe(false)
    expect(clarificationAnswerSchema.safeParse({ answer: 'y'.repeat(1001) }).success).toBe(false)
  })
  it('view schema never carries provider_id', () => {
    const parsed = clarificationViewSchema.safeParse({ ...view(), provider_id: U(9) })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect('provider_id' in parsed.data).toBe(false)
  })
  it('cap constant is three open questions per provider', () => {
    expect(CLARIFICATION_MAX_OPEN_PER_PROVIDER).toBe(3)
  })
})

describe('S1.3 derived "in clarification"', () => {
  it('counts only unanswered questions', () => {
    expect(openQuestionCount([])).toBe(0)
    expect(openQuestionCount([view(), view({ answeredAt: '2026-09-20T11:00:00.000Z', answer: 'Yes' })])).toBe(1)
  })
  it('is true only for an ACTIVE RFQ with an open question — never a status', () => {
    expect(isInClarification('open', [view()])).toBe(true)
    expect(isInClarification('quoted', [view()])).toBe(true)
    expect(isInClarification('open', [view({ answeredAt: '2026-09-20T11:00:00.000Z' })])).toBe(false)
    expect(isInClarification('open', [])).toBe(false)
    for (const closed of ['expired', 'cancelled', 'accepted']) expect(isInClarification(closed, [view()])).toBe(false)
  })
  it('sorts unanswered first, then oldest asked first', () => {
    const a = view({ id: U(1), askedAt: '2026-09-20T09:00:00.000Z', answeredAt: '2026-09-20T09:30:00.000Z' })
    const b = view({ id: U(2), askedAt: '2026-09-20T10:00:00.000Z' })
    const c = view({ id: U(3), askedAt: '2026-09-20T08:00:00.000Z' })
    expect(sortClarifications([a, b, c]).map((x) => x.id)).toEqual([U(3), U(2), U(1)])
  })
  it('hours to answer: one decimal, never negative', () => {
    expect(hoursToAnswer('2026-09-20T10:00:00.000Z', '2026-09-20T13:30:00.000Z')).toBe(3.5)
    expect(hoursToAnswer('2026-09-20T10:00:00.000Z', '2026-09-20T09:00:00.000Z')).toBe(0)
  })
})

describe('S1.3 quote revision schema', () => {
  const full = {
    price_paise: 1_000_000, delivery_days: 7,
    scope: 'GST filing for FY 2025-26 including the annual return and reconciliation.',
    gst_included: true, transport_included: false, valid_until: '2026-12-31', advance_percent: 25,
  }
  it('accepts a full restatement and mirrors quoteSchema rules', () => {
    expect(quoteRevisionSchema.safeParse(full).success).toBe(true)
    expect(quoteRevisionSchema.safeParse({ ...full, scope: 'short' }).success).toBe(false)
    expect(quoteRevisionSchema.safeParse({ ...full, advance_percent: 101 }).success).toBe(false)
  })
  it('rejects extraction_id and rfq_id (a revision is never a confirmation)', () => {
    expect(quoteRevisionSchema.safeParse({ ...full, extraction_id: U(5) }).success).toBe(false)
    expect(quoteRevisionSchema.safeParse({ ...full, rfq_id: U(6) }).success).toBe(false)
    // …while the submit schema still takes extraction_id.
    expect(quoteSchema.safeParse({ ...full, rfq_id: U(6), extraction_id: U(5) }).success).toBe(true)
  })
  it('goods terms rules are unchanged (same sub-schema as submit)', () => {
    const goods = { unit_price_paise: 12_000, gst_rate_bps: 1800, hsn_code: '4819' }
    expect(quoteRevisionSchema.safeParse({ ...full, goods }).success).toBe(true)
    expect(quoteRevisionSchema.safeParse({ ...full, goods: { ...goods, hsn_code: 'abc' } }).success).toBe(false)
    expect(quoteRevisionSchema.safeParse({ ...full, goods: { ...goods, gst_rate_bps: 1234 } }).success).toBe(false)
  })
  it('MAX_QUOTE_REVISIONS counts submissions (original = 1)', () => {
    expect(MAX_QUOTE_REVISIONS).toBe(3)
  })
})

describe('S1.3 tools (taint law: every write tool is confirm:true)', () => {
  it('registers the three S1.3 tools with the right persona and wrapped route', () => {
    expect(agentTool('ask_clarification')).toMatchObject({ persona: 'provider', confirm: true, wraps: 'POST /rfq/[id]/clarifications' })
    expect(agentTool('answer_clarification')).toMatchObject({ persona: 'buyer', confirm: true, wraps: 'POST /rfq/[id]/clarifications/[cid]/answer' })
    expect(agentTool('revise_quote')).toMatchObject({ persona: 'provider', confirm: true, wraps: 'PATCH /rfq/[id]/quote' })
  })
  it('every tool that wraps a POST/PATCH/PUT/DELETE route is confirm:true', () => {
    for (const t of AGENT_TOOLS) {
      if (/^(POST|PATCH|PUT|DELETE) /.test(t.wraps)) expect(t.confirm, `${t.name} wraps ${t.wraps}`).toBe(true)
    }
  })
})
