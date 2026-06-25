/**
 * Lightweight i18n for the mobile app.
 * Consumes the same message shape as apps/web/messages/*.json.
 * Uses React Context + useState so locale switches re-render the tree.
 */

import React, { createContext, useContext, useState } from 'react'
import en from '../messages/en.json'
import hi from '../messages/hi.json'

export type Locale = 'en' | 'hi'

type Messages = typeof en

const MESSAGES: Record<Locale, Messages> = { en, hi }

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: string) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>('en')

  function t(key: string): string {
    const parts = key.split('.')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let value: any = MESSAGES[locale]
    for (const part of parts) {
      value = value?.[part]
    }
    return typeof value === 'string' ? value : key
  }

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
