'use client'

import { useEffect } from 'react'
import { useAnalytics } from '@/components/providers/posthog'

/** One `search_performed` per distinct search (and `search_zero_results` when empty). */
export function SearchTracker({ signature, qLen, filters, sort, results, view }: { signature: string; qLen: number; filters: string[]; sort: string; results: number; view: string }) {
  const analytics = useAnalytics()
  useEffect(() => {
    analytics.capture('search_performed', { device: 'web', q_len: qLen, filters, sort, results, view })
    if (results === 0) analytics.capture('search_zero_results', { device: 'web', q_len: qLen, filters })
    // Once per distinct search (the signature is the canonical query string).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])
  return null
}
