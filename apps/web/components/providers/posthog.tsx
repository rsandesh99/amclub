'use client'

import posthog from 'posthog-js'
import { PostHogProvider as PHProvider } from 'posthog-js/react'
import { useEffect } from 'react'

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const key = process.env['NEXT_PUBLIC_POSTHOG_KEY']
    const host = process.env['NEXT_PUBLIC_POSTHOG_HOST'] ?? 'https://eu.posthog.com'

    if (!key) return // Skip in development if key not set

    posthog.init(key, {
      api_host: host,
      capture_pageview: false, // We use next-intl routes; track manually
      capture_pageleave: true,
      person_profiles: 'identified_only',
    })
  }, [])

  return <PHProvider client={posthog}>{children}</PHProvider>
}
