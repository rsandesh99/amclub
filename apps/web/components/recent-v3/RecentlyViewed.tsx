'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { History } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { useAnalytics } from '@/components/providers/posthog'
import { pickI18n } from '@/lib/format'
import { readRecent, type RecentItem } from './store'

type ServerItem = { kind: 'provider' | 'package'; id: string; title: { en: string; hi?: string }; href: string; viewedAt: string }

/**
 * FR-2.8 — "Recently viewed": this device's list merged with the account's
 * (signed in). Shown on the buyer home, the search sheet's empty state and
 * the zero-result page. Renders nothing when there is nothing to show.
 */
export function RecentlyViewed({ limit = 8, className }: { limit?: number; className?: string }) {
  const t = useTranslations('recent_v3')
  const locale = useLocale()
  const analytics = useAnalytics()
  const [items, setItems] = useState<RecentItem[]>([])

  useEffect(() => {
    let live = true
    const local = readRecent()
    setItems(local)
    fetch('/api/v1/me/recent-views')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { items?: ServerItem[] } | null) => {
        if (!live || !j?.items) return
        const merged = new Map<string, RecentItem>()
        for (const s of j.items) merged.set(`${s.kind}:${s.id}`, { kind: s.kind, id: s.id, title: pickI18n(s.title, locale), href: s.href, at: Date.parse(s.viewedAt) })
        for (const l of local) {
          const k = `${l.kind}:${l.id}`
          const prev = merged.get(k)
          if (!prev || l.at > prev.at) merged.set(k, l)
        }
        setItems([...merged.values()].sort((a, b) => b.at - a.at))
      })
      .catch(() => {})
    return () => { live = false }
  }, [locale])

  if (items.length === 0) return null
  return (
    <section className={className} aria-labelledby="recently-viewed" data-testid="recently-viewed">
      <h2 id="recently-viewed" className="t-headline mb-2 inline-flex items-center gap-2">
        <History className="h-4 w-4" aria-hidden /> {t('title')}
      </h2>
      <ul className="flex flex-wrap gap-2">
        {items.slice(0, limit).map((it) => (
          <li key={`${it.kind}:${it.id}`}>
            <Link
              href={it.href as '/services'}
              onClick={() => analytics.capture('recent_view_opened', { device: 'web', kind: it.kind })}
              className="inline-flex max-w-[16rem] items-center rounded-chip border border-border bg-surface px-3 py-1.5 text-sm hover:border-primary/40"
            >
              <span className="truncate">{it.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
