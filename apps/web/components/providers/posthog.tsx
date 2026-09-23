'use client'

import { useEffect, useMemo } from 'react'
import type { PostHog } from 'posthog-js'
import { ANALYTICS_CONSENT_COOKIE, ANALYTICS_CONSENT_MAX_AGE_S, currentConsentFromCookie, encodeConsentCookie, type AnalyticsConsentChoice } from '@amclub/shared'
import { ANALYTICS_CONSENT_REQUIRED } from '@/lib/public-flags'

/**
 * Deferred analytics. posthog-js is ~68 KB gzipped — a third of the JS on a
 * catalogue page — and nothing on the critical path needs it. It is loaded
 * (dynamic import → its own chunk) once the page has finished loading and the
 * main thread is idle, or immediately on the first `capture` call, whichever
 * comes first. Events captured before the SDK is up are buffered in order and
 * flushed on init, so no event is lost. Consumers use `useAnalytics()`.
 */

type Props = Record<string, unknown>

const KEY = process.env['NEXT_PUBLIC_POSTHOG_KEY']
const HOST = process.env['NEXT_PUBLIC_POSTHOG_HOST'] ?? 'https://eu.posthog.com'
const MAX_BUFFER = 50

let client: PostHog | null = null
let loading: Promise<PostHog | null> | null = null
const buffer: Array<[string, Props | undefined]> = []

/** E17 — the first-party consent cookie's raw value (null on the server or when absent). */
export function readConsentCookie(): string | null {
  if (typeof document === 'undefined') return null
  const m = document.cookie.match(new RegExp(`(?:^|; )${ANALYTICS_CONSENT_COOKIE}=([^;]*)`))
  return m ? decodeURIComponent(m[1]!) : null
}

/** E17 — while consent is required, analytics runs only after an Accept for the current notice version. */
function consented(): boolean {
  if (!ANALYTICS_CONSENT_REQUIRED) return true
  return currentConsentFromCookie(readConsentCookie()) === 'granted'
}

/** E17 — record the choice (first-party cookie) and apply it now: Accept loads analytics, Decline stops it. */
export function setAnalyticsConsent(choice: AnalyticsConsentChoice): void {
  if (typeof document === 'undefined') return
  document.cookie = `${ANALYTICS_CONSENT_COOKIE}=${encodeURIComponent(encodeConsentCookie(choice))}; Max-Age=${ANALYTICS_CONSENT_MAX_AGE_S}; Path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`
  if (choice === 'granted') void load()
  else {
    buffer.splice(0)
    client?.opt_out_capturing()
  }
}

function load(): Promise<PostHog | null> {
  if (!KEY || typeof window === 'undefined' || !consented()) return Promise.resolve(null)
  if (loading) return loading
  loading = import('posthog-js')
    .then(({ default: posthog }) => {
      posthog.init(KEY, {
        api_host: HOST,
        capture_pageview: false, // next-intl routes; tracked manually
        capture_pageleave: true,
        person_profiles: 'identified_only',
      })
      client = posthog
      // A re-accept after a Decline in this browser opts back in.
      if (ANALYTICS_CONSENT_REQUIRED && posthog.has_opted_out_capturing()) posthog.opt_in_capturing()
      for (const [event, props] of buffer.splice(0)) posthog.capture(event, props)
      return posthog
    })
    .catch(() => null)
  return loading
}

/** Fire-and-forget event capture; safe before the SDK has loaded. */
export function capture(event: string, props?: Props): void {
  if (!KEY) return
  // E17 — before an Accept nothing is captured or buffered (a Decline sends nothing at all).
  if (!consented()) return
  if (client) {
    client.capture(event, props)
    return
  }
  buffer.push([event, props])
  if (buffer.length > MAX_BUFFER) buffer.shift()
  void load()
}

/** Analytics handle with a stable identity (safe in hook dependency arrays). */
const handle = { capture }

export function useAnalytics(): { capture: (event: string, props?: Props) => void } {
  return useMemo(() => handle, [])
}

function scheduleIdle(fn: () => void) {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 4000 })
  else setTimeout(fn, 2000)
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (!KEY) return
    const start = () => scheduleIdle(() => void load())
    if (document.readyState === 'complete') start()
    else window.addEventListener('load', start, { once: true })
    return () => window.removeEventListener('load', start)
  }, [])

  return <>{children}</>
}
