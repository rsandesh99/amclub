import { defineRouting } from 'next-intl/routing'

export const routing = defineRouting({
  locales: ['en', 'hi'],
  defaultLocale: 'en',
  // All routes under /[locale]; default locale is not prefixed in the URL
  localePrefix: 'as-needed',
})

export type AppLocale = (typeof routing.locales)[number]
