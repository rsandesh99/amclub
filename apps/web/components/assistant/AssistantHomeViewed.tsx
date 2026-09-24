'use client'

import { useEffect } from 'react'
import { useAnalytics } from '@/components/providers/posthog'

/** assistant_home_viewed, once per visit (Appendix A). */
export function AssistantHomeViewed({ persona, on }: { persona: 'buyer' | 'provider'; on: number }) {
  const analytics = useAnalytics()
  useEffect(() => { analytics.capture('assistant_home_viewed', { persona, capabilities_on: on }) }, [analytics, persona, on])
  return null
}
