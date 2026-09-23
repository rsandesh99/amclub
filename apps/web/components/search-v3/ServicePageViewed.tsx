'use client'

import { useEffect } from 'react'
import { useAnalytics } from '@/components/providers/posthog'

export function ServicePageViewed({ service }: { service: string }) {
  const analytics = useAnalytics()
  useEffect(() => {
    analytics.capture('service_page_viewed', { device: 'web', service })
  }, [analytics, service])
  return null
}
