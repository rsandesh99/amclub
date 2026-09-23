'use client'

import { useEffect } from 'react'
import { useAnalytics } from '@/components/providers/posthog'

/** E11 — `gem_checklist_viewed` once per visit. */
export function GemChecklistViewed() {
  const analytics = useAnalytics()
  useEffect(() => {
    analytics.capture('gem_checklist_viewed', { device: 'web' })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, [])
  return null
}
