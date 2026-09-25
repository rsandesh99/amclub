import { describe, expect, it } from 'vitest'
import {
  INDIAN_STATE_NAMES,
  INDIAN_STATES,
  PROVIDER_LANGUAGES,
  SUPPORTED_LOCALES,
  indianStateName,
  indianStateOptions,
  localeSchema,
  localizeAmountWords,
  providerLanguageSchema,
  rfqFieldLabel,
  rfqFieldPlaceholder,
  rfqOptionLabel,
} from '../index'

describe('E14 — state / UT names in four languages', () => {
  it('every state and UT has a name in en / hi / te / ta, and English matches INDIAN_STATES', () => {
    for (const s of INDIAN_STATES) {
      const names = INDIAN_STATE_NAMES[s.value]
      expect(names, s.value).toBeDefined()
      expect(names!.en).toBe(s.label)
      for (const l of ['hi', 'te', 'ta'] as const) expect(names![l]?.trim().length, `${s.value}.${l}`).toBeGreaterThan(0)
    }
    expect(Object.keys(INDIAN_STATE_NAMES).sort()).toEqual(INDIAN_STATES.map((s) => s.value).sort())
  })
  it('renders the reader’s language, English for an unknown locale, and an unknown code as-is', () => {
    expect(indianStateName('TS', 'hi')).toBe('तेलंगाना')
    expect(indianStateName('TS', 'te')).toBe('తెలంగాణ')
    expect(indianStateName('TN', 'ta')).toBe('தமிழ்நாடு')
    expect(indianStateName('TS', 'en')).toBe('Telangana')
    expect(indianStateName('TS', 'mr')).toBe('Telangana')
    expect(indianStateName('ZZ', 'hi')).toBe('ZZ')
    expect(indianStateName(null, 'hi')).toBe('')
  })
  it('options keep the code as the value, in the INDIAN_STATES order', () => {
    const opts = indianStateOptions('hi')
    expect(opts.map((o) => o.value)).toEqual(INDIAN_STATES.map((s) => s.value))
    expect(opts.find((o) => o.value === 'TS')?.label).toBe('तेलंगाना')
  })
})

describe('E14 / F12 — Tamil is a pickable language', () => {
  it('preferred language and provider languages include ta', () => {
    expect(SUPPORTED_LOCALES).toContain('ta')
    expect(PROVIDER_LANGUAGES).toContain('ta')
    expect(localeSchema.safeParse('ta').success).toBe(true)
    expect(providerLanguageSchema.safeParse('ta').success).toBe(true)
  })
})

describe('E14 — RFQ template field labels, placeholders and options', () => {
  const field = { name: 'financial_year', label_en: 'Financial Year', label_hi: 'वित्तीय वर्ष', placeholder_en: 'e.g. 2024-25' }
  it('labels: own slot when present, else English — never Hindi for te / ta', () => {
    expect(rfqFieldLabel(field, 'hi')).toBe('वित्तीय वर्ष')
    expect(rfqFieldLabel(field, 'te')).toBe('Financial Year')
    expect(rfqFieldLabel(field, 'ta')).toBe('Financial Year')
    expect(rfqFieldLabel({ ...field, label_te: 'ఆర్థిక సంవత్సరం', label_ta: 'நிதியாண்டு' }, 'te')).toBe('ఆర్థిక సంవత్సరం')
    expect(rfqFieldLabel({ ...field, label_te: 'ఆర్థిక సంవత్సరం', label_ta: 'நிதியாண்டு' }, 'ta')).toBe('நிதியாண்டு')
    expect(rfqFieldLabel({ ...field, label_te: '  ' }, 'te')).toBe('Financial Year')
    expect(rfqFieldLabel({ name: 'notes' }, 'te')).toBe('notes')
  })
  it('placeholders follow the same rule', () => {
    expect(rfqFieldPlaceholder(field, 'hi')).toBe('e.g. 2024-25')
    expect(rfqFieldPlaceholder({ ...field, placeholder_ta: 'எ.கா. 2024-25' }, 'ta')).toBe('எ.கா. 2024-25')
    expect(rfqFieldPlaceholder({}, 'te')).toBe('')
  })
  it('lakh / crore are written in the reader’s script; digits, ₹ and the rest are untouched', () => {
    const options = ['< ₹20 lakh', '₹20 lakh – ₹1 crore', '₹1–5 crore', '₹5–20 crore', '> ₹20 crore']
    expect(options.map((o) => rfqOptionLabel(o, 'hi'))).toEqual(['< ₹20 लाख', '₹20 लाख – ₹1 करोड़', '₹1–5 करोड़', '₹5–20 करोड़', '> ₹20 करोड़'])
    expect(options.map((o) => rfqOptionLabel(o, 'te'))).toEqual(['< ₹20 లక్షలు', '₹20 లక్షలు – ₹1 కోటి', '₹1–5 కోట్లు', '₹5–20 కోట్లు', '> ₹20 కోట్లు'])
    expect(options.map((o) => rfqOptionLabel(o, 'ta'))).toEqual(['< ₹20 லட்சம்', '₹20 லட்சம் – ₹1 கோடி', '₹1–5 கோடி', '₹5–20 கோடி', '> ₹20 கோடி'])
    for (const o of options) expect(rfqOptionLabel(o, 'en')).toBe(o)
    expect(localizeAmountWords('Within 1 week', 'hi')).toBe('Within 1 week')
    expect(localizeAmountWords('2.5 Lakhs', 'te')).toBe('2.5 లక్షలు')
    expect(localizeAmountWords('Blakh lakhy', 'hi')).toBe('Blakh lakhy')
  })
  it('an option label carried in the data wins for its language', () => {
    const labels = { 'Within 1 week': { hi: '1 सप्ताह में', ta: '1 வாரத்திற்குள்' } }
    expect(rfqOptionLabel('Within 1 week', 'hi', labels)).toBe('1 सप्ताह में')
    expect(rfqOptionLabel('Within 1 week', 'ta', labels)).toBe('1 வாரத்திற்குள்')
    expect(rfqOptionLabel('Within 1 week', 'te', labels)).toBe('Within 1 week')
    expect(rfqOptionLabel('Within 1 week', 'en', labels)).toBe('Within 1 week')
  })
})
