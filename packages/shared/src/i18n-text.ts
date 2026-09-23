import { z } from 'zod'

/**
 * E14 FR-14.2 — database text in four languages. Every stored i18n map
 * (package titles, category names, notification copy, …) is `{ en, hi?, te?, ta? }`:
 * `en` is required, the others are filled as they are translated. ONE schema,
 * ONE picker — web and mobile both call `pickI18n`, so a te / ta reader never
 * gets `undefined` or a Hindi fallback: a missing slot is English.
 */
export const I18N_TEXT_LOCALES = ['en', 'hi', 'te', 'ta'] as const
export type I18nTextLocale = (typeof I18N_TEXT_LOCALES)[number]

export const i18nTextSchema = z.object({
  en: z.string().trim().min(1),
  hi: z.string().trim().optional(),
  te: z.string().trim().optional(),
  ta: z.string().trim().optional(),
})
export type I18nText = z.infer<typeof i18nTextSchema>

/** The reader's own slot when it holds text, else English (never Hindi for te / ta). */
export function pickI18n(map: { en: string; hi?: string | null | undefined; te?: string | null | undefined; ta?: string | null | undefined } | null | undefined, locale: string): string {
  if (!map) return ''
  if (locale === 'hi' || locale === 'te' || locale === 'ta') {
    const own = map[locale]
    if (typeof own === 'string' && own.trim()) return own
  }
  return map.en
}

/**
 * FR-14.4 (D-PRD7) — numerals. Money, dates and counts use Latin digits in
 * every locale (GST invoices, bank documents and the Razorpay screens all do)
 * with Indian grouping (₹1,23,456). Words stay in the locale's script. Every
 * Intl formatter takes its locale tag from here.
 */
export function numeralsTag(locale: string): string {
  const base = (I18N_TEXT_LOCALES as readonly string[]).includes(locale) ? locale : 'en'
  return `${base}-IN-u-nu-latn`
}

/** A count with Indian grouping and Latin digits, e.g. 123456 → "1,23,456" in every locale. */
export function formatCount(n: number, locale: string): string {
  return new Intl.NumberFormat(numeralsTag(locale), { maximumFractionDigits: 0 }).format(n)
}
