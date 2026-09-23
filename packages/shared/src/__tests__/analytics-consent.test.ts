import { describe, expect, it } from 'vitest'
import { ANALYTICS_NOTICE_VERSION, consentRate, currentConsentFromCookie, currentConsentFromRecord, encodeConsentCookie } from '../index'

describe('analytics consent (E17)', () => {
  it('a cookie counts only for the current notice version', () => {
    expect(currentConsentFromCookie(encodeConsentCookie('granted'))).toBe('granted')
    expect(currentConsentFromCookie(encodeConsentCookie('denied'))).toBe('denied')
    expect(currentConsentFromCookie('granted.2020-01-01')).toBeNull()
    expect(currentConsentFromCookie('maybe.' + ANALYTICS_NOTICE_VERSION)).toBeNull()
    expect(currentConsentFromCookie(null)).toBeNull()
  })

  it('stored records: current only; the rate is over current choices', () => {
    const now = { choice: 'granted', version: ANALYTICS_NOTICE_VERSION, at: 'x' }
    expect(currentConsentFromRecord(now)).toBe('granted')
    expect(currentConsentFromRecord({ ...now, version: '2020-01-01' })).toBeNull()
    expect(consentRate([now, now, { ...now, choice: 'denied' }, { ...now, version: '2020-01-01' }, null])).toEqual({ granted: 2, denied: 1, rate: 2 / 3 })
    expect(consentRate([]).rate).toBeNull()
  })
})
