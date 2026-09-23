'use client'

import { useSearchParams } from 'next/navigation'
import { parseSearchV2, searchV2ToEntries, searchV2ToQueryString, withSearchV2, type SearchV2 } from '@amclub/shared'
import { usePathname, useRouter } from '@/i18n/navigation'
import { useAnalytics } from '@/components/providers/posthog'

/**
 * Experience v3 E2 — the URL is the search state (FR-2.1: every filter is
 * shareable). Reads it with the shared codec, writes one key at a time; a
 * filter change returns to page 1.
 */
export function useSearchNav() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const analytics = useAnalytics()
  const current = parseSearchV2(Object.fromEntries(params.entries()))

  const go = (next: SearchV2) => {
    const qs = searchV2ToQueryString(next)
    router.push((qs ? `${pathname}?${qs}` : pathname) as '/services', { scroll: false })
  }
  /** Set (or clear with null) one key from its URL string form. */
  const setRaw = (key: keyof SearchV2, value: string | null) => {
    const entries = Object.fromEntries(searchV2ToEntries(current)) as Record<string, string | undefined>
    if (value === null) delete entries[key]
    else entries[key] = value
    const parsed = parseSearchV2(entries)
    const next = key === 'page' || key === 'more' || key === 'view' ? parsed : withSearchV2(parsed, 'page', undefined)
    if (key !== 'page' && key !== 'more' && key !== 'view' && key !== 'sort') analytics.capture('search_filter_changed', { device: 'web', filter: key, value })
    go(next)
  }
  const clearFilters = () => {
    const keep: SearchV2 = {}
    if (current.query) keep.query = current.query
    if (current.category) keep.category = current.category
    if (current.sort) keep.sort = current.sort
    if (current.view) keep.view = current.view
    analytics.capture('search_filter_changed', { device: 'web', filter: 'all', value: null })
    go(keep)
  }
  return { current, setRaw, clearFilters }
}
