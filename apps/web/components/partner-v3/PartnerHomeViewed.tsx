'use client'

import { useEffect } from 'react'
import { useAnalytics } from '@/components/providers/posthog'

/** E11 — `partner_home_viewed { actions }` once per visit. */
export function PartnerHomeViewed({ actions }: { actions: number }) {
  const analytics = useAnalytics()
  useEffect(() => {
    analytics.capture('partner_home_viewed', { device: 'web', actions })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, [])
  return null
}
