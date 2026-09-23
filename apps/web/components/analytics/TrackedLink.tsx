'use client'

import type { ComponentProps } from 'react'
import { Link } from '@/i18n/navigation'
import { useAnalytics } from '@/components/providers/posthog'

/**
 * A locale-aware Link that fires one analytics event on click, so server
 * components can instrument a CTA without becoming client components.
 */
export function TrackedLink({
  event,
  eventProps,
  onClick,
  ...props
}: ComponentProps<typeof Link> & { event: string; eventProps?: Record<string, unknown> }) {
  const analytics = useAnalytics()
  return (
    <Link
      {...props}
      onClick={(e) => {
        analytics.capture(event, { device: 'web', ...eventProps })
        onClick?.(e)
      }}
    />
  )
}
