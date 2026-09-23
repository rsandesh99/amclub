'use client'

import { useEffect } from 'react'
import { useAnalytics } from '@/components/providers/posthog'

export function CompareOpened({ n }: { n: number }) {
  const analytics = useAnalytics()
  useEffect(() => {
    analytics.capture('compare_opened', { device: 'web', n })
  }, [analytics, n])
  return null
}
