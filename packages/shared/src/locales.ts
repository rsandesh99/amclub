import { pickI18n } from './i18n-text'

/**
 * S3 — locale/language single sources of truth. Two DELIBERATELY SEPARATE
 * lists (founder decision): UI locale is app infrastructure; spoken languages
 * are product data (what a provider can converse in with buyers). They may
 * diverge — spoken may gain languages the UI never ships (e.g. a provider who
 * speaks Kannada while the app has no kn locale), so never derive one from the
 * other.
 */

/** Locales the UI ships (routing, messages, preferred_locale, CMS banner).
 *  te and ta are shipped locales with en fallback for untranslated keys: E14
 *  (Experience v3 G6) made the web buying path four-language, so a buyer can
 *  pick Tamil as their preferred language. The mobile app still offers en / hi
 *  / te in its own toggle and renders ta as English (apps/mobile/lib/i18n.tsx). */
export const SUPPORTED_LOCALES = ['en', 'hi', 'te', 'ta'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

/** Languages a provider can declare speaking with buyers. Product data, widened
 *  to te for the Telugu-speaking launch cluster and to ta with E14 (buyers can
 *  already ask for a Tamil speaker, `RFQ_MUST_HAVE_LANGUAGES`). May diverge from
 *  SUPPORTED_LOCALES over time. */
export const PROVIDER_LANGUAGES = ['en', 'hi', 'te', 'ta'] as const
export type ProviderLanguage = (typeof PROVIDER_LANGUAGES)[number]

/**
 * Resolve a DB i18n map ({ en, hi?, te?, ta? }) for the active UI locale, with
 * en fallback. Kept as the historical name; it IS `pickI18n` (E14 FR-14.2), so
 * widening the locales can never produce an out-of-range index or a raw
 * undefined.
 */
export function pickLocale(
  map: { en: string; hi?: string; te?: string; ta?: string } | null | undefined,
  locale: string,
): string {
  return pickI18n(map, locale)
}
