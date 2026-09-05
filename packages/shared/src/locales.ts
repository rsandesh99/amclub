/**
 * S3 — locale/language single sources of truth. Two DELIBERATELY SEPARATE
 * lists (founder decision): UI locale is app infrastructure; spoken languages
 * are product data (what a provider can converse in with buyers). They may
 * diverge — spoken may gain languages the UI never ships (e.g. a provider who
 * speaks Kannada while the app has no kn locale), so never derive one from the
 * other.
 */

/** Locales the UI ships (routing, messages, preferred_locale, CMS banner).
 *  te is a first-class locale with en fallback for untranslated keys.
 *  ta remains a gateway-only PARTIAL locale (not first-class) — intentionally
 *  NOT here; it gets its own phase when a Tamil cluster is on the roadmap. */
export const SUPPORTED_LOCALES = ['en', 'hi', 'te'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

/** Languages a provider can declare speaking with buyers. Product data, widened
 *  to te for the Telugu-speaking launch cluster. May diverge from
 *  SUPPORTED_LOCALES over time. */
export const PROVIDER_LANGUAGES = ['en', 'hi', 'te'] as const
export type ProviderLanguage = (typeof PROVIDER_LANGUAGES)[number]

/**
 * Resolve a DB i18n map ({ en, hi, te? } — te optional, added incrementally)
 * for the active UI locale, with en fallback. Used wherever a locale (now
 * possibly 'te') indexes an object that may only carry en/hi (category
 * name_i18n, notification title_i18n, …), so widening SUPPORTED_LOCALES can
 * never produce an out-of-range index or a raw undefined.
 */
export function pickLocale(
  map: { en: string; hi?: string; te?: string } | null | undefined,
  locale: string,
): string {
  if (!map) return ''
  if (locale === 'te') return map.te ?? map.en
  if (locale === 'hi') return map.hi ?? map.en
  return map.en
}
