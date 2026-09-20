import { describe, expect, it } from 'vitest'
import {
  DECLINE_REASONS,
  RFQ_MAX_QUOTES_LEGACY,
  effectiveQuoteCap,
  parseAgentSetting,
  quoteWindowLapsed,
  rfqDeclineSchema,
} from '../index'

describe('quote cap as config (S0.4)', () => {
  it('unset falls back to the legacy hard-coded 7', () => {
    expect(effectiveQuoteCap(undefined)).toBe(RFQ_MAX_QUOTES_LEGACY)
    expect(effectiveQuoteCap(null)).toBe(7)
  })
  it('a configured cap is honoured and clamped to 3..7', () => {
    expect(effectiveQuoteCap(5)).toBe(5)
    expect(effectiveQuoteCap(2)).toBe(3)
    expect(effectiveQuoteCap(9)).toBe(7)
  })
  it('the registry rejects an out-of-band cap', () => {
    expect(parseAgentSetting('rfq_max_quotes', 5).ok).toBe(true)
    expect(parseAgentSetting('rfq_max_quotes', 8).ok).toBe(false)
    expect(parseAgentSetting('rfq_max_quotes', 2).ok).toBe(false)
  })
})

describe('quote-or-decline', () => {
  it('decline body needs a known reason', () => {
    for (const r of DECLINE_REASONS) expect(rfqDeclineSchema.safeParse({ reason: r }).success).toBe(true)
    expect(rfqDeclineSchema.safeParse({ reason: 'window_lapsed' }).success).toBe(false)
    expect(rfqDeclineSchema.safeParse({ reason: 'busy' }).success).toBe(false)
  })
  it('window lapse is inclusive of the boundary', () => {
    const notified = new Date('2026-09-20T00:00:00Z')
    expect(quoteWindowLapsed(notified, 48, new Date('2026-09-21T23:59:59Z'))).toBe(false)
    expect(quoteWindowLapsed(notified, 48, new Date('2026-09-22T00:00:00Z'))).toBe(true)
  })
  it('the registry bounds the window', () => {
    expect(parseAgentSetting('quote_window_hours', 48).ok).toBe(true)
    expect(parseAgentSetting('quote_window_hours', 1).ok).toBe(false)
  })
})
