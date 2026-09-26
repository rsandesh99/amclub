import { describe, expect, it } from 'vitest'
import { classifyWaKeyword, maskWaPhone, normalizeWaKeyword, waLocaleFor, waPhoneFromVendor } from '../whatsapp'
import { inQuietHours, istMinuteOfDay, quietHoursEnd } from '../notify'

describe('classifyWaKeyword (audit B4)', () => {
  it('STOP and its hi / te / ta forms opt out, tolerant of punctuation and "please"', () => {
    for (const t of ['STOP', 'stop.', ' Stop! ', 'please stop', 'stop please', 'Unsubscribe', 'बंद करो', 'ఆపండి', 'நிறுத்து']) {
      expect(classifyWaKeyword(t)?.intent, t).toBe('stop')
    }
  })
  it('"no", "cancel" and their hi / te forms are never an opt-out', () => {
    for (const t of ['no', 'No', 'cancel', 'नहीं', 'వద్దు', 'cancel my order']) {
      expect(classifyWaKeyword(t)?.intent, t).not.toBe('stop')
    }
  })
  it('greetings are never consent', () => {
    for (const t of ['hi', 'Hello!', 'ok', 'yes', 'namaste', 'नमस्ते', 'నమస్తే', 'வணக்கம்']) {
      const k = classifyWaKeyword(t)
      expect(k?.intent, t).not.toBe('start')
    }
    expect(classifyWaKeyword('hi')?.intent).toBe('greeting')
  })
  it('START opts in; HELP, MENU and ? open the menu', () => {
    expect(classifyWaKeyword('START')?.intent).toBe('start')
    expect(classifyWaKeyword('शुरू')?.intent).toBe('start')
    for (const t of ['help', 'MENU', '?', 'मदद', 'సహాయం', 'உதவி']) {
      expect(classifyWaKeyword(t)?.intent, t).toBe('help')
    }
  })
  it('language names switch the language; the word "language" asks for the list', () => {
    expect(classifyWaKeyword('Telugu')).toEqual({ intent: 'language', locale: 'te' })
    expect(classifyWaKeyword('தமிழ்')).toEqual({ intent: 'language', locale: 'ta' })
    expect(classifyWaKeyword('हिंदी')).toEqual({ intent: 'language', locale: 'hi' })
    expect(classifyWaKeyword('language')).toEqual({ intent: 'language', locale: null })
  })
  it('data requests and report', () => {
    expect(classifyWaKeyword('MY DATA')?.intent).toBe('my_data')
    expect(classifyWaKeyword('delete my data')?.intent).toBe('delete_data')
    expect(classifyWaKeyword('report')?.intent).toBe('report')
  })
  it('a sentence is not a keyword', () => {
    expect(classifyWaKeyword('please stop sending me the old invoice copy')).toBeNull()
    expect(classifyWaKeyword('when will my order stop being late')).toBeNull()
    expect(classifyWaKeyword('')).toBeNull()
    expect(classifyWaKeyword(null)).toBeNull()
  })
  it('normalizes', () => {
    expect(normalizeWaKeyword('  PLEASE   Stop!!! ')).toBe('stop')
  })
})

describe('phones and locales', () => {
  it('a business-scoped user id is never reduced to digits (audit 2.9)', () => {
    expect(waPhoneFromVendor('919876543210')).toBe('919876543210')
    expect(waPhoneFromVendor('+919876543210')).toBe('919876543210')
    expect(waPhoneFromVendor('IN.13491208655302741918')).toBeNull()
    expect(waPhoneFromVendor('')).toBeNull()
  })
  it('masks all but the last four digits', () => {
    expect(maskWaPhone('+91 98765 43210')).toBe('••••••••3210')
    expect(maskWaPhone(null)).toBeNull()
  })
  it('ta is a WhatsApp locale; anything unknown is en', () => {
    expect(waLocaleFor('ta')).toBe('ta')
    expect(waLocaleFor('kn')).toBe('en')
    expect(waLocaleFor(null)).toBe('en')
  })
})

describe('quiet hours (IST)', () => {
  const win = { start: '21:00', end: '08:00' }
  it('crosses midnight', () => {
    // 22:30 IST = 17:00 UTC
    expect(inQuietHours(new Date('2026-09-26T17:00:00Z'), win)).toBe(true)
    // 07:59 IST = 02:29 UTC
    expect(inQuietHours(new Date('2026-09-27T02:29:00Z'), win)).toBe(true)
    // 08:00 IST = 02:30 UTC
    expect(inQuietHours(new Date('2026-09-27T02:30:00Z'), win)).toBe(false)
    // 12:00 IST
    expect(inQuietHours(new Date('2026-09-27T06:30:00Z'), win)).toBe(false)
    expect(inQuietHours(new Date('2026-09-27T06:30:00Z'), null)).toBe(false)
  })
  it('the deferral ends at the window end in IST', () => {
    const at = new Date('2026-09-26T17:00:00Z') // 22:30 IST
    const end = quietHoursEnd(at, win)
    expect(end.toISOString()).toBe('2026-09-27T02:30:00.000Z') // 08:00 IST
    expect(istMinuteOfDay(end)).toBe(8 * 60)
    const noon = new Date('2026-09-27T06:30:00Z')
    expect(quietHoursEnd(noon, win)).toBe(noon)
  })
})
