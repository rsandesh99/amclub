/**
 * Lightweight i18n for the mobile app.
 * Consumes the same message shape as apps/web/messages/*.json.
 * Uses React Context + useState so locale switches re-render the tree.
 * The chosen locale persists across launches (SecureStore) — STATUS_AUDIT H2.
 */

import React, { createContext, useContext, useEffect, useState } from 'react'
import * as SecureStore from 'expo-secure-store'
import { SUPPORTED_LOCALES, type SupportedLocale } from '@amclub/shared'
import { track } from './analytics'
import en from '../messages/en.json'
import hi from '../messages/hi.json'
import te from '../messages/te.json'

// UI locale derived from the shared single source of truth (S3.4).
export type Locale = SupportedLocale

type Messages = typeof en

// te ships partial (grows as translation lands); resolution deep-falls back to
// en key-by-key so a te user never sees a raw key name (S3.4). Cast te since
// its partial JSON (plus a _comment) is not structurally the full Messages.
const MESSAGES: Record<Locale, Partial<Messages>> = { en, hi, te: te as unknown as Partial<Messages> }
const LOCALE_KEY = 'amc_locale'

/** Walk a dotted key path in a message object; undefined if any segment missing. */
function lookup(src: unknown, parts: string[]): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let value: any = src
  for (const part of parts) value = value?.[part]
  return typeof value === 'string' ? value : undefined
}

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
        if (v && (SUPPORTED_LOCALES as readonly string[]).includes(v)) setLocaleState(v as Locale)
      })
      .catch(() => {})
  }, [])

  function setLocale(next: Locale) {
    if (next !== locale) track('locale_changed', { from: locale, to: next, platform: 'android' }) // E14
    setLocaleState(next)
    SecureStore.setItemAsync(LOCALE_KEY, next).catch(() => {})
  }

  function t(key: string, params?: Record<string, string | number>): string {
    const parts = key.split('.')
    // Deep en fallback: try the active locale, then en, then the key itself —
    // so a partial locale (te) renders English for untranslated keys, never a
    // raw key name (S3.4).
    const out = lookup(MESSAGES[locale], parts) ?? lookup(MESSAGES.en, parts) ?? key
    let result = out
    if (params) for (const [k, v] of Object.entries(params)) result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    return result
  }

  return <I18nContext.Provider value={{ locale, setLocale, t }}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
