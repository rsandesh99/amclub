'use client'

import { useEffect } from 'react'
import { useAnalytics } from '@/components/providers/posthog'

/** E11 — `insights_viewed { range }` once per visit. */
export function InsightsViewed({ range }: { range: '7d' | '30d' }) {
  const analytics = useAnalytics()
  useEffect(() => {
    analytics.capture('insights_viewed', { device: 'web', range })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, [])
  return null
}
