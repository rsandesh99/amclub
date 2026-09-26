import { describe, expect, it } from 'vitest'
import {
  COMPANY_LINE, GRIEVANCE_OFFICER, formatWhatsAppNumber, isOfficialLink, normalizeWhatsAppNumber, officialWhatsApp, waMeHref,
} from '../official-channels'

describe('normalizeWhatsAppNumber', () => {
  it('reads the formats people and env files use', () => {
    for (const raw of ['+91 83411 15455', '918341115455', '+91-83411-15455', '(+91) 83411 15455', '8341115455', '08341115455', '00918341115455']) {
      expect(normalizeWhatsAppNumber(raw), raw).toBe('918341115455')
    }
  })
  it('keeps a non-Indian E.164 number as it is', () => {
    expect(normalizeWhatsAppNumber('+1 415 555 0100')).toBe('14155550100')
  })
  it('refuses what is not a number', () => {
    for (const raw of [null, undefined, '', '   ', 'abc', '+91 83411 1545x', '12345', '0000000000', '+0123456789']) {
      expect(normalizeWhatsAppNumber(raw), String(raw)).toBeNull()
    }
  })
})

describe('formatWhatsAppNumber', () => {
  it('groups an Indian mobile as +91 XXXXX XXXXX', () => {
    expect(formatWhatsAppNumber('918341115455')).toBe('+91 83411 15455')
    expect(formatWhatsAppNumber('9876543210')).toBe('+91 98765 43210')
  })
  it('prefixes other numbers with +, and returns empty for junk', () => {
    expect(formatWhatsAppNumber('14155550100')).toBe('+14155550100')
    expect(formatWhatsAppNumber('nope')).toBe('')
  })
})

describe('officialWhatsApp (one number everywhere)', () => {
  it('uses the configured business number when it is set', () => {
    const o = officialWhatsApp('+91 90000 12345')
    expect(o).toEqual({ digits: '919000012345', e164: '+919000012345', display: '+91 90000 12345', displayName: 'AMClub', source: 'env' })
  })
  it('falls back to the company line only while the env is unset or unusable', () => {
    for (const env of [undefined, null, '', 'not-a-number']) {
      const o = officialWhatsApp(env)
      expect(o.source, String(env)).toBe('company_line')
      expect(o.e164).toBe(COMPANY_LINE.e164)
      expect(o.display).toBe(COMPANY_LINE.display)
    }
  })
  it('the grievance officer phone is the company line', () => {
    expect(GRIEVANCE_OFFICER.phoneE164).toBe(COMPANY_LINE.e164)
  })
})

describe('waMeHref', () => {
  it('builds a wa.me link with the digits and encoded text', () => {
    expect(waMeHref('+91 83411 15455')).toBe('https://wa.me/918341115455')
    expect(waMeHref('918341115455', 'Hello, order #12 & more')).toBe('https://wa.me/918341115455?text=Hello%2C%20order%20%2312%20%26%20more')
  })
})

describe('isOfficialLink (the safety page rule)', () => {
  it('accepts https links on amclub.in and its subdomains', () => {
    for (const u of ['https://amclub.in', 'https://amclub.in/', 'https://amclub.in/app/orders/1?x=1', 'https://www.amclub.in/help', 'HTTPS://AMCLUB.IN/pay', 'https://amclub.in:443/x', 'https://amclub.in#top']) {
      expect(isOfficialLink(u), u).toBe(true)
    }
  })
  it('refuses look-alikes, other schemes and credentials tricks', () => {
    for (const u of [
      'http://amclub.in', 'https://amclub.in.evil.com', 'https://evil-amclub.in', 'https://amclubin.com', 'https://amclub.co',
      'https://amclub.in@evil.com', 'https://user@amclub.in', 'https://evil.com/amclub.in', 'https://evil.com?amclub.in', 'javascript:alert(1)',
      'amclub.in', '', null, undefined, 'https://amclub.in\\@evil.com',
    ]) {
      expect(isOfficialLink(u), String(u)).toBe(false)
    }
  })
})
