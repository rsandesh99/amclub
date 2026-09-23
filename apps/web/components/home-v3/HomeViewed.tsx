'use client'

import { useEffect } from 'react'
import { useAnalytics } from '@/components/providers/posthog'

/** E9 — `home_viewed` once per visit, with the number of "Needs your action" rows. */
export function HomeViewed({ actions }: { actions: number }) {
  const analytics = useAnalytics()
  useEffect(() => {
    analytics.capture('home_viewed', { device: 'web', actions })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, [])
  return null
}
