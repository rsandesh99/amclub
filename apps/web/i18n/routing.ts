import { defineRouting } from 'next-intl/routing'

export const routing = defineRouting({
  // te/ta added for the Phase 8a gateway. Their message files carry gateway
  // copy (from the design handoff, flagged for native review) and fall back
  // to English for everything else (see i18n/request.ts).
  locales: ['en', 'hi', 'te', 'ta'],
  defaultLocale: 'en',
  // All routes under /[locale]; default locale is not prefixed in the URL
  localePrefix: 'as-needed',
  // next-intl 4 made NEXT_LOCALE a session cookie. With 'as-needed' prefixes
  // an unprefixed link (/services) goes to the remembered language only while
  // that cookie lives, so a person who picked हिंदी would get English again
  // after closing the browser. One year, as in next-intl 3. (v4 also writes
  // the cookie only when the locale differs from the Accept-Language match or
  // from an existing cookie; it never changes which locale a request gets.)
  localeCookie: { maxAge: 60 * 60 * 24 * 365 },
})

export type AppLocale = (typeof routing.locales)[number]

/** Regex fragment matching any locale URL prefix, e.g. "en|hi|te|ta". */
export const LOCALE_PREFIX_PATTERN = routing.locales.join('|')
