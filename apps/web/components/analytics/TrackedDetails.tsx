'use client'

import type { ReactNode } from 'react'
import { useAnalytics } from '@/components/providers/posthog'

/** A native <details> that fires one event the first time it opens. */
export function TrackedDetails({ event, eventProps, summary, children, className, summaryClassName }: { event: string; eventProps?: Record<string, unknown>; summary: ReactNode; children: ReactNode; className?: string; summaryClassName?: string }) {
  const analytics = useAnalytics()
  return (
    <details
      className={className}
      onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) analytics.capture(event, { device: 'web', ...eventProps }) }}
    >
      <summary className={summaryClassName}>{summary}</summary>
      {children}
    </details>
  )
}
