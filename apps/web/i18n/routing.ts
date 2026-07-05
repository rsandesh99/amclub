import { defineRouting } from 'next-intl/routing'

export const routing = defineRouting({
  // te/ta added for the Phase 8a gateway. Their message files carry gateway
  // copy (from the design handoff, flagged for native review) and fall back
  // to English for everything else (see i18n/request.ts).
  locales: ['en', 'hi', 'te', 'ta'],
  defaultLocale: 'en',
  // All routes under /[locale]; default locale is not prefixed in the URL
  localePrefix: 'as-needed',
})

export type AppLocale = (typeof routing.locales)[number]

/** Regex fragment matching any locale URL prefix, e.g. "en|hi|te|ta". */
export const LOCALE_PREFIX_PATTERN = routing.locales.join('|')
