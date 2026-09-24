'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale } from 'next-intl'
import type { UniversalHit, UniversalSearchResult } from '@amclub/shared'
import { useRouter } from '@/i18n/navigation'
import { useAnalytics } from '@/components/providers/posthog'

const RECENT_KEY = 'amc_usearch_recent'

export function readRecentSearches(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 6) : []
  } catch { return [] }
}

export type SearchRow = { group: string; hit: UniversalHit & { pricePaise?: number | null } }

/**
 * N3 — one search for the header field (desktop, inline) and the phone sheet:
 * debounced `/search/universal`, grouped rows (my orders / requirements /
 * invoices first, then services, providers, categories), arrow keys + Enter,
 * and recent queries kept on this device. Enter with nothing selected opens the
 * full results page for the term.
 */
export function useUniversalSearch({ fullResultsPath, onNavigate }: { fullResultsPath: string; onNavigate?: () => void }) {
  const locale = useLocale()
  const router = useRouter()
  const analytics = useAnalytics()
  const [q, setQ] = useState('')
  const [res, setRes] = useState<UniversalSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const [recent, setRecent] = useState<string[]>([])
  const seq = useRef(0)

  const refreshRecent = useCallback(() => setRecent(readRecentSearches()), [])

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { seq.current++; setRes(null); setLoading(false); return }
    const id = ++seq.current
    setLoading(true)
    const tm = setTimeout(() => {
      fetch(`/api/v1/search/universal?q=${encodeURIComponent(term)}&locale=${locale}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d: UniversalSearchResult | null) => {
          if (id !== seq.current) return
          setRes(d)
          setActive(0)
          if (d) analytics.capture('universal_search_performed', { len: term.length, results: d.services.length + d.providers.length + d.categories.length + (d.mine ? d.mine.orders.length + d.mine.requirements.length + d.mine.invoices.length : 0) })
        })
        .catch(() => {})
        .finally(() => { if (id === seq.current) setLoading(false) })
    }, 200)
    return () => clearTimeout(tm)
  }, [q, locale, analytics])

  const rows: SearchRow[] = useMemo(() => {
    if (!res) return []
    const out: SearchRow[] = []
    const push = (group: string, hits: (UniversalHit & { pricePaise?: number | null })[]) => { for (const hit of hits) out.push({ group, hit }) }
    if (res.mine) {
      push('mine_orders', res.mine.orders)
      push('mine_requirements', res.mine.requirements)
      push('mine_invoices', res.mine.invoices)
    }
    push('services', res.services)
    push('providers', res.providers)
    push('categories', res.categories)
    return out
  }, [res])

  const go = useCallback((href: string, term: string) => {
    if (term) {
      try {
        const next = [term, ...readRecentSearches().filter((x) => x !== term)].slice(0, 6)
        localStorage.setItem(RECENT_KEY, JSON.stringify(next))
      } catch { /* recents are a convenience */ }
    }
    onNavigate?.()
    router.push(href as '/app')
  }, [onNavigate, router])

  /** Enter: the highlighted row, else the full results page for the term. */
  const submit = useCallback(() => {
    const term = q.trim()
    const r = rows[active]
    if (r) go(r.hit.href, term)
    else if (term.length >= 2) go(`${fullResultsPath}?query=${encodeURIComponent(term)}`, term)
  }, [q, rows, active, go, fullResultsPath])

  /** Arrow keys move the highlight; Enter submits. Returns true when the key was handled. */
  const onKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(rows.length - 1, a + 1)); return true }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); return true }
    if (e.key === 'Enter') { e.preventDefault(); submit(); return true }
    return false
  }, [rows.length, submit])

  const reset = useCallback(() => { setQ(''); setRes(null); setActive(0) }, [])

  return { q, setQ, res, rows, loading, active, setActive, recent, refreshRecent, go, submit, onKey, reset }
}
