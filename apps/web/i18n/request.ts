import { getRequestConfig } from 'next-intl/server'
import { routing } from './routing'

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale

  if (!locale || !(routing.locales as readonly string[]).includes(locale)) {
    locale = routing.defaultLocale
  }

  // Import JSON directly; TypeScript infers the right type for next-intl
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const messages = (await import(`../messages/${locale}.json`)).default

  return { locale, messages }
})
