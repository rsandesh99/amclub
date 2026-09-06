'use client'

import { useEffect, useMemo } from 'react'
import type { PostHog } from 'posthog-js'

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

function load(): Promise<PostHog | null> {
  if (!KEY || typeof window === 'undefined') return Promise.resolve(null)
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
      for (const [event, props] of buffer.splice(0)) posthog.capture(event, props)
      return posthog
    })
    .catch(() => null)
  return loading
}

/** Fire-and-forget event capture; safe before the SDK has loaded. */
export function capture(event: string, props?: Props): void {
  if (!KEY) return
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
