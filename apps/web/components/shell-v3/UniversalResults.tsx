'use client'

import { Clock } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { formatINR } from '@/lib/format'
import { RecentlyViewed } from '@/components/recent-v3/RecentlyViewed'
import type { SearchRow } from './useUniversalSearch'

/**
 * The result body shared by the header dropdown (desktop) and the search sheet
 * (phones): recent queries + recently viewed while the field is short, grouped
 * rows once there are results, and a "nothing found" line.
 */
export function UniversalResults({
  listId,
  q,
  rows,
  active,
  setActive,
  loading,
  hasResult,
  recent,
  onRecent,
  onPick,
}: {
  listId: string
  q: string
  rows: SearchRow[]
  active: number
  setActive: (i: number) => void
  loading: boolean
  hasResult: boolean
  recent: string[]
  onRecent: (term: string) => void
  onPick: (href: string) => void
}) {
  const t = useTranslations('search_v3')
  const term = q.trim()
  let lastGroup = ''

  return (
    <>
      {term.length < 2 && recent.length > 0 && (
        <div className="space-y-1.5">
          <p className="t-footnote px-1 font-medium text-foreground-secondary">{t('recent')}</p>
          <ul className="grouped">
            {recent.map((r) => (
              <li key={r}>
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onRecent(r)} className="grouped-row flex w-full items-center gap-3 px-4 text-left text-[15px]">
                  <Clock className="h-4 w-4 text-foreground-tertiary" aria-hidden />
                  {r}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* E2b (N8): recently viewed pages, from this device. */}
      {term.length < 2 && <RecentlyViewed limit={6} className="px-1 pt-3" />}

      {term.length < 2 && recent.length === 0 && (
        <p className="t-footnote px-1 py-2 text-foreground-secondary">{t('hint')}</p>
      )}

      {term.length >= 2 && loading && rows.length === 0 && (
        <p className="t-footnote px-1 py-4 text-center text-foreground-secondary" aria-live="polite">{t('searching')}</p>
      )}

      {term.length >= 2 && !loading && hasResult && rows.length === 0 && (
        <p className="t-subhead px-1 py-6 text-center text-foreground-secondary">{t('no_results', { q: term })}</p>
      )}

      {rows.length > 0 && (
        <ul id={listId} role="listbox" aria-label={t('title')} className="space-y-1">
          {rows.map((r, i) => {
            const header = r.group !== lastGroup ? r.group : null
            lastGroup = r.group
            return (
              <li key={`${r.group}-${r.hit.id}`} role="none">
                {header && <p className="t-footnote px-1 pb-1 pt-3 font-medium text-foreground-secondary">{t(`group_${header}`)}</p>}
                <button
                  id={`${listId}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  // mousedown, not click: the header field would blur (and close the dropdown) before a click lands.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onPick(r.hit.href)}
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
    </>
  )
}
