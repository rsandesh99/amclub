'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { FileText, Package, UserRound } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { useAnalytics } from '@/components/providers/posthog'
import { useRecentItems } from '@/components/recent-v3/useRecentItems'
import { RFQ_DRAFT_KEY } from '@/components/rfq/draft-key'

type Card = { key: string; kind: 'draft' | 'package' | 'provider'; title: string; href: string }

/**
 * E9 FR-9.2 (N8) — "Pick up where you left off": the requirement draft on
 * this device, then the last 3 recently viewed packages or providers. A
 * horizontal shelf of compact cards; hidden when empty (no illustration).
 */
export function PickUpShelf() {
  const t = useTranslations('home_v3')
  const analytics = useAnalytics()
  const recent = useRecentItems()
  const [draft, setDraft] = useState<Card | null>(null)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(RFQ_DRAFT_KEY)
      const d = raw ? (JSON.parse(raw) as { title?: unknown; categorySlug?: unknown }) : null
      const title = typeof d?.title === 'string' ? d.title.trim() : ''
      if (title || (typeof d?.categorySlug === 'string' && d.categorySlug)) setDraft({ key: 'draft', kind: 'draft', title: title || t('draft_untitled'), href: '/app/rfq/new' })
    } catch {
      /* private mode / bad JSON: no draft card */
    }
  }, [t])

  const cards: Card[] = [...(draft ? [draft] : []), ...recent.slice(0, 3).map((r) => ({ key: `${r.kind}:${r.id}`, kind: r.kind, title: r.title, href: r.href }))]
  if (cards.length === 0) return null
  const Icon = { draft: FileText, package: Package, provider: UserRound }
  return (
    <section aria-labelledby="home-pickup" data-testid="home-pickup">
      <h2 id="home-pickup" className="t-footnote mb-1.5 px-4 font-medium text-foreground-secondary">{t('pickup_heading')}</h2>
      <ul className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1">
        {cards.map((c) => {
          const I = Icon[c.kind]
          return (
            <li key={c.key} className="w-40 shrink-0 snap-start">
              <Link
                href={c.href as '/app'}
                onClick={() => analytics.capture('home_pickup_clicked', { device: 'web', kind: c.kind })}
                className="flex h-full flex-col gap-1.5 rounded-card border border-border bg-surface p-3 shadow-card transition-colors hover:border-primary/40"
              >
                <span className="t-caption inline-flex items-center gap-1 text-foreground-secondary">
                  <I className="h-3.5 w-3.5" aria-hidden /> {t(`pickup_${c.kind}`)}
                </span>
                <span className="line-clamp-2 text-sm font-medium">{c.title}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
