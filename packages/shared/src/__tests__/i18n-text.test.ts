import { describe, expect, it } from 'vitest'
import { CATEGORY_LIST, formatCount, i18nTextSchema, numeralsTag, pickI18n, pickLocale } from '../index'

describe('E14 FR-14.2 — one four-language map, one picker', () => {
  const full = { en: 'Tax & Accounting', hi: 'कर एवं लेखा', te: 'పన్ను & అకౌంటింగ్', ta: 'வரி & கணக்கியல்' }
  it('each locale gets its own slot', () => {
    expect(pickI18n(full, 'en')).toBe(full.en)
    expect(pickI18n(full, 'hi')).toBe(full.hi)
    expect(pickI18n(full, 'te')).toBe(full.te)
    expect(pickI18n(full, 'ta')).toBe(full.ta)
  })
  it('a missing or blank te / ta slot falls back to English — never Hindi, never undefined', () => {
    const enHi = { en: 'Legal', hi: 'कानूनी सेवाएं' }
    expect(pickI18n(enHi, 'te')).toBe('Legal')
    expect(pickI18n(enHi, 'ta')).toBe('Legal')
    expect(pickI18n({ en: 'Legal', te: '  ' }, 'te')).toBe('Legal')
    expect(pickI18n(null, 'ta')).toBe('')
    expect(pickI18n(full, 'mr')).toBe(full.en)
  })
  it('pickLocale is the same picker (historical name)', () => {
    for (const l of ['en', 'hi', 'te', 'ta', 'xx']) expect(pickLocale(full, l)).toBe(pickI18n(full, l))
  })
  it('the schema requires English and accepts the other three', () => {
    expect(i18nTextSchema.safeParse(full).success).toBe(true)
    expect(i18nTextSchema.safeParse({ en: 'x' }).success).toBe(true)
    expect(i18nTextSchema.safeParse({ hi: 'x' }).success).toBe(false)
    expect(i18nTextSchema.safeParse({ en: '  ' }).success).toBe(false)
  })
  it('every category name and description ships in all four languages', () => {
    for (const c of CATEGORY_LIST) {
      for (const l of ['en', 'hi', 'te', 'ta'] as const) {
        expect(c.name_i18n[l].trim().length).toBeGreaterThan(0)
        expect(c.description_i18n[l].trim().length).toBeGreaterThan(0)
      }
    }
  })
})

describe('E14 FR-14.4 (D-PRD7) — numerals', () => {
  const LATIN = /^[0-9,.\s₹]+$/
  it('counts: Latin digits and Indian grouping in every locale', () => {
    for (const l of ['en', 'hi', 'te', 'ta']) {
      expect(formatCount(123456, l)).toBe('1,23,456')
      expect(formatCount(1234567, l)).toBe('12,34,567')
    }
  })
  it('money and dates through numeralsTag stay Latin in every locale', () => {
    for (const l of ['en', 'hi', 'te', 'ta']) {
      const money = new Intl.NumberFormat(numeralsTag(l), { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(123456)
      expect(money.replace(/[^\d,.₹]/g, '')).toBe('₹1,23,456')
      const day = new Intl.DateTimeFormat(numeralsTag(l), { day: 'numeric', year: 'numeric', timeZone: 'Asia/Kolkata' }).formatToParts(new Date('2026-09-23T06:00:00Z'))
      for (const p of day.filter((x) => x.type === 'day' || x.type === 'year')) expect(p.value).toMatch(LATIN)
    }
  })
  it('an unknown locale formats as English (India)', () => {
    expect(numeralsTag('mr')).toBe('en-IN-u-nu-latn')
    expect(numeralsTag('ta')).toBe('ta-IN-u-nu-latn')
  })
})
