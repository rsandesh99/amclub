import { describe, expect, it } from 'vitest'
import { redactContactInfo, rfqIsActive } from '../rfq'

/**
 * §9.3 anti-disintermediation — the masking regexes guard the pre-payment
 * quote thread. Its own docstring promised it was "unit-testable"; now it is.
 */

describe('redactContactInfo — phone numbers', () => {
  it('masks a bare 10-digit Indian mobile', () => {
    const r = redactContactInfo('call me on 9876543210 tomorrow')
    expect(r.redacted).toBe(true)
    expect(r.text).not.toContain('9876543210')
    expect(r.text).toContain('[contact hidden]')
  })

  it('masks +91 and spaced/dashed variants', () => {
    for (const s of ['+91 98765 43210', '+919876543210', '98765-43210', '9 8 7 6 5 4 3 2 1 0']) {
      const r = redactContactInfo(`reach me: ${s}`)
      expect(r.redacted, s).toBe(true)
      expect(r.text, s).toContain('[contact hidden]')
    }
  })

  it('does NOT mask amounts, years, or GSTIN-like strings', () => {
    for (const s of [
      'budget is 1500000 paise',
      'incorporated in 2019, turnover 4500000',
      'GSTIN 36AABCU9603R1ZM',
    ]) {
      const r = redactContactInfo(s)
      expect(r.redacted, s).toBe(false)
      expect(r.text, s).toBe(s)
    }
  })
})

describe('redactContactInfo — emails', () => {
  it('masks plain and dotted addresses', () => {
    for (const s of ['mail me at ravi@example.com', 'ravi.kumar+work@sub.domain.co.in ok?']) {
      const r = redactContactInfo(s)
      expect(r.redacted, s).toBe(true)
      expect(r.text, s).toContain('[contact hidden]')
      expect(r.text, s).not.toMatch(/@/)
    }
  })

  it('masks both an email and a phone in one message', () => {
    const r = redactContactInfo('ravi@ex.com / 9876543210')
    expect(r.text.match(/\[contact hidden\]/g)?.length).toBe(2)
  })

  it('leaves clean text untouched', () => {
    const s = 'I need monthly GST filing for my garments unit in Guntur.'
    expect(redactContactInfo(s)).toEqual({ text: s, redacted: false })
  })
})

describe('rfqIsActive', () => {
  it('open and quoted are active; the rest are not', () => {
    expect(rfqIsActive('open')).toBe(true)
    expect(rfqIsActive('quoted')).toBe(true)
    for (const s of ['accepted', 'expired', 'cancelled']) expect(rfqIsActive(s)).toBe(false)
  })
})
