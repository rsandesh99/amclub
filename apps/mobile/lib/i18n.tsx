/**
 * Lightweight i18n for the mobile app.
 * Consumes the same message shape as apps/web/messages/*.json.
 * Uses React Context + useState so locale switches re-render the tree.
 * The chosen locale persists across launches (SecureStore) — STATUS_AUDIT H2.
 */

import React, { createContext, useContext, useEffect, useState } from 'react'
import * as SecureStore from 'expo-secure-store'
import en from '../messages/en.json'
import hi from '../messages/hi.json'

export type Locale = 'en' | 'hi'

type Messages = typeof en

const MESSAGES: Record<Locale, Messages> = { en, hi }
const LOCALE_KEY = 'amc_locale'

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: string, params?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en')

  useEffect(() => {
    SecureStore.getItemAsync(LOCALE_KEY)
      .then((v) => {
        if (v === 'en' || v === 'hi') setLocaleState(v)
      })
      .catch(() => {})
  }, [])

  function setLocale(next: Locale) {
    setLocaleState(next)
    SecureStore.setItemAsync(LOCALE_KEY, next).catch(() => {})
  }

  function t(key: string, params?: Record<string, string | number>): string {
    const parts = key.split('.')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let value: any = MESSAGES[locale]
    for (const part of parts) {
      value = value?.[part]
    }
    let out = typeof value === 'string' ? value : key
    if (params) for (const [k, v] of Object.entries(params)) out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    return out
  }

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
