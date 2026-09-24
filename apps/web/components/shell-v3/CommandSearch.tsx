'use client'

import { useEffect } from 'react'
import { Search, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Sheet } from '@/components/ui-v3/Sheet'
import { useUniversalSearch } from './useUniversalSearch'
import { UniversalResults } from './UniversalResults'

/**
 * N3 on phones: a full sheet with one field that searches services, providers
 * and categories (and, signed in, my requirements, orders and invoices). Arrow
 * keys + Enter; recent queries stay on this device. Desktop searches inline in
 * the top bar (HeaderSearch); the shell opens this sheet only below md.
 */
export function CommandSearch({ open, onOpenChange, fullResultsPath }: { open: boolean; onOpenChange: (o: boolean) => void; fullResultsPath: string }) {
  const t = useTranslations('search_v3')
  const s = useUniversalSearch({ fullResultsPath, onNavigate: () => onOpenChange(false) })
  const { reset, refreshRecent } = s

  useEffect(() => { if (open) { refreshRecent(); reset() } }, [open, refreshRecent, reset])

  const listId = 'usearch-list'
  return (
    <Sheet open={open} onClose={() => onOpenChange(false)} title={t('title')} detent="large">
      <div className="sticky top-0 z-10 -mx-5 bg-surface px-5 pb-3">
        <label className="flex h-12 items-center gap-2 rounded-input bg-sunken px-3">
          <Search className="h-5 w-5 text-foreground-secondary" strokeWidth={1.75} aria-hidden />
          <input
            data-autofocus
            value={s.q}
            onChange={(e) => s.setQ(e.target.value)}
            onKeyDown={(e) => { s.onKey(e) }}
            placeholder={t('placeholder')}
            aria-label={t('placeholder')}
            role="combobox"
            aria-expanded={s.rows.length > 0}
            aria-controls={s.rows.length > 0 ? listId : undefined}
            aria-activedescendant={s.rows[s.active] ? `${listId}-${s.active}` : undefined}
            className="min-h-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-foreground-tertiary"
          />
          {s.q && (
            <button type="button" onClick={() => s.setQ('')} aria-label={t('clear')} className="inline-flex h-8 w-8 items-center justify-center rounded-full text-foreground-secondary">
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </label>
      </div>

      <UniversalResults
        listId={listId}
        q={s.q}
        rows={s.rows}
        active={s.active}
        setActive={s.setActive}
        loading={s.loading}
        hasResult={s.res !== null}
        recent={s.recent}
        onRecent={s.setQ}
        onPick={(href) => s.go(href, s.q.trim())}
      />
    </Sheet>
  )
}
