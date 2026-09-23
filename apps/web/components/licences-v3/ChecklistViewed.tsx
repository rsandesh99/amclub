'use client'

import { useEffect } from 'react'
import { useAnalytics } from '@/components/providers/posthog'

/** E9b — `obligation_checklist_viewed { rules }` once per visit. */
export function ChecklistViewed({ rules }: { rules: number }) {
  const analytics = useAnalytics()
  useEffect(() => {
    analytics.capture('obligation_checklist_viewed', { device: 'web', rules })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, [])
  return null
}
