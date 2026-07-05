import { getRequestConfig } from 'next-intl/server'
import type { AbstractIntlMessages } from 'next-intl'
import { routing } from './routing'

type Messages = AbstractIntlMessages

/** Overlay `patch` onto `base`, recursing into plain objects — so a partially
 *  translated locale (te/ta carry gateway copy only for now) falls back to
 *  English key-by-key instead of throwing MISSING_MESSAGE. */
function deepMerge(base: Messages, patch: Messages): Messages {
  const out: Messages = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const prev = out[key]
    if (
      typeof value === 'object' &&
      typeof prev === 'object' &&
      !Array.isArray(value) &&
      !Array.isArray(prev)
    ) {
      out[key] = deepMerge(prev, value)
    } else {
      out[key] = value
    }
  }
  return out
}

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale

  if (!locale || !(routing.locales as readonly string[]).includes(locale)) {
    locale = routing.defaultLocale
  }

  // Import JSON directly; TypeScript infers the right type for next-intl
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const messages = (await import(`../messages/${locale}.json`)).default as Messages

  if (locale === routing.defaultLocale) {
    return { locale, messages }
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const fallback = (await import(`../messages/en.json`)).default as Messages
  return { locale, messages: deepMerge(fallback, messages) }
})
