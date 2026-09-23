'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, Clock, X } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import type { UniversalHit, UniversalSearchResult } from '@amclub/shared'
import { useRouter } from '@/i18n/navigation'
import { cn } from '@/lib/utils'
import { RecentlyViewed } from '@/components/recent-v3/RecentlyViewed'
import { formatINR } from '@/lib/format'
import { Sheet } from '@/components/ui-v3/Sheet'
import { useAnalytics } from '@/components/providers/posthog'

const RECENT_KEY = 'amc_usearch_recent'

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 6) : []
  } catch { return [] }
}

type Row = { group: string; hit: UniversalHit & { pricePaise?: number | null } }

/**
 * N3 — ⌘K / Ctrl+K on desktop, a full sheet on phones. One field searches
 * services, providers and categories (and, signed in, my requirements, orders
 * and invoices). Arrow keys + Enter; recent queries stay on this device.
 */
export function CommandSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useTranslations('search_v3')
  const locale = useLocale()
  const router = useRouter()
  const analytics = useAnalytics()
  const [q, setQ] = useState('')
  const [res, setRes] = useState<UniversalSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const [recent, setRecent] = useState<string[]>([])
  const seq = useRef(0)

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        onOpenChange(true)
        analytics.capture('command_search_opened', { via: 'keyboard' })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onOpenChange, analytics])

  useEffect(() => { if (open) { setRecent(readRecent()); setQ(''); setRes(null); setActive(0) } }, [open])

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setRes(null); return }
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

  const rows: Row[] = useMemo(() => {
    if (!res) return []
    const out: Row[] = []
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
    try {
      const next = [term, ...readRecent().filter((x) => x !== term)].slice(0, 6)
      localStorage.setItem(RECENT_KEY, JSON.stringify(next))
    } catch { /* recents are a convenience */ }
    onOpenChange(false)
    router.push(href as '/app')
  }, [onOpenChange, router])

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(rows.length - 1, a + 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    if (e.key === 'Enter') {
      e.preventDefault()
      const r = rows[active]
      if (r) go(r.hit.href, q.trim())
      else if (q.trim().length >= 2) go(`/services?q=${encodeURIComponent(q.trim())}`, q.trim())
    }
  }

  let lastGroup = ''
  return (
    <Sheet open={open} onClose={() => onOpenChange(false)} title={t('title')} detent="large">
      <div className="sticky top-0 z-10 -mx-5 bg-surface px-5 pb-3">
        <label className="flex h-12 items-center gap-2 rounded-input bg-sunken px-3">
          <Search className="h-5 w-5 text-foreground-secondary" strokeWidth={1.75} aria-hidden />
          <input
            data-autofocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder={t('placeholder')}
            aria-label={t('placeholder')}
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls="usearch-list"
            aria-activedescendant={rows[active] ? `usearch-${active}` : undefined}
            className="min-h-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-foreground-tertiary"
          />
          {q && (
            <button type="button" onClick={() => setQ('')} aria-label={t('clear')} className="inline-flex h-8 w-8 items-center justify-center rounded-full text-foreground-secondary">
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </label>
      </div>

      {!res && recent.length > 0 && q.trim().length < 2 && (
        <div className="space-y-1.5">
          <p className="t-footnote px-1 font-medium text-foreground-secondary">{t('recent')}</p>
          <ul className="grouped">
            {recent.map((r) => (
              <li key={r}>
                <button type="button" onClick={() => setQ(r)} className="grouped-row flex w-full items-center gap-3 px-4 text-left text-[15px]">
                  <Clock className="h-4 w-4 text-foreground-tertiary" aria-hidden />
                  {r}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* E2b (N8): recently viewed pages, from this device. */}
      {!res && q.trim().length < 2 && <RecentlyViewed limit={6} className="px-1" />}

      {q.trim().length >= 2 && !loading && res && rows.length === 0 && (
        <p className="t-subhead px-1 py-6 text-center text-foreground-secondary">{t('no_results', { q: q.trim() })}</p>
      )}

      {rows.length > 0 && (
        <ul id="usearch-list" role="listbox" aria-label={t('title')} className="space-y-1">
          {rows.map((r, i) => {
            const header = r.group !== lastGroup ? r.group : null
            lastGroup = r.group
            return (
              <li key={`${r.group}-${r.hit.id}`} role="none">
                {header && <p className="t-footnote px-1 pb-1 pt-3 font-medium text-foreground-secondary">{t(`group_${header}`)}</p>}
                <button
                  id={`usearch-${i}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(r.hit.href, q.trim())}
                  className={cn('flex w-full items-center justify-between gap-3 rounded-button px-3 py-2.5 text-left', i === active ? 'bg-primary/10' : 'hover:bg-foreground/5')}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-medium text-foreground">{r.hit.title}</span>
                    {r.hit.subtitle && <span className="t-footnote block truncate text-foreground-secondary">{r.hit.subtitle}</span>}
                  </span>
                  {typeof r.hit.pricePaise === 'number' && (
                    <span className="t-numeric-s shrink-0 text-numeric">{t('price_plus_gst', { price: formatINR(r.hit.pricePaise) })}</span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Sheet>
  )
}
