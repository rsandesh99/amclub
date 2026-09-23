'use client'

import { useTranslations } from 'next-intl'
import { X, ChevronRight } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { clearCompare, useCompare } from './store'

/** FR-2.9 — docks at the bottom once something is shortlisted. */
export function CompareTray() {
  const t = useTranslations('compare_v3')
  const items = useCompare()
  if (items.length === 0) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex justify-center px-4 lg:bottom-6" data-testid="compare-tray">
      <div className="material pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-card border border-border px-4 py-3 shadow-card">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{t('tray', { n: items.length })}</span>
        <button type="button" aria-label={t('clear')} className="flex h-9 w-9 items-center justify-center rounded-full hover:bg-sunken" onClick={clearCompare}>
          <X className="h-4 w-4" aria-hidden />
        </button>
        <Link
          href={`/compare?items=${items.map((x) => x.id).join(',')}` as '/compare'}
          className="inline-flex min-h-[40px] items-center gap-1 rounded-button bg-primary px-4 text-sm font-semibold text-white hover:bg-primary/90"
        >
          {t('view')} <ChevronRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </div>
  )
}
