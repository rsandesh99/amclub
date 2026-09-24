import { describe, expect, it } from 'vitest'
import { safeNext, withNext } from '../safe-next'

describe('safeNext', () => {
  it('keeps internal paths, including a query', () => {
    expect(safeNext('/app/checkout/abc')).toBe('/app/checkout/abc')
    expect(safeNext('%2Fapp%2Fcheckout%2Fabc%3Ftier%3Dstandard')).toBe('/app/checkout/abc?tier=standard')
  })
  it('refuses external, protocol-relative and auth targets', () => {
    for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', '/login', '/signup?complete=1', '/partner/signup', '', null, undefined, '%E0%A4%A']) {
      expect(safeNext(bad)).toBeNull()
    }
  })
  it('refuses control characters and backslashes that a URL parser would drop or turn into "//" (audit M6)', () => {
    for (const bad of ['/%09/evil.example/x', '/%0a/evil.example', '/%0D/evil.example', '/\t/evil.example', '/%5C/evil.example', '/app\\..\\x', '/%00/app', '/%7F']) {
      expect(safeNext(bad)).toBeNull()
    }
  })
  it('still keeps ordinary paths with spaces-free queries and fragments', () => {
    expect(safeNext('/app/rfq/new?entry=why#top')).toBe('/app/rfq/new?entry=why#top')
    expect(safeNext('  /app  ')).toBe('/app')
  })
})

describe('withNext (E0 / U1 — the new buyer keeps their checkout)', () => {
  it('appends a sanitized next to the buyer wizard', () => {
    expect(withNext('/signup?complete=1', '/app/checkout/pkg-1')).toBe('/signup?complete=1&next=%2Fapp%2Fcheckout%2Fpkg-1')
  })
  it('appends to a path without a query', () => {
    expect(withNext('/partner/onboarding', '/partner/rfqs')).toBe('/partner/onboarding?next=%2Fpartner%2Frfqs')
  })
  it('leaves the path alone for a missing or unsafe next', () => {
    expect(withNext('/signup?complete=1', null)).toBe('/signup?complete=1')
    expect(withNext('/signup?complete=1', 'https://evil.com')).toBe('/signup?complete=1')
  })
  it('never nests a wizard into itself', () => {
    expect(withNext('/partner/onboarding', '/partner/onboarding')).toBe('/partner/onboarding')
    expect(withNext('/partner/onboarding', '/partner/onboarding?next=%2Fpartner%2Frfqs')).toBe('/partner/onboarding?next=/partner/rfqs')
  })
})
