'use client'

import { useTranslations } from 'next-intl'
import { LanguageChips } from './LanguageChips'
import type { AppLocale } from '@/i18n/routing'

/**
 * Sticky translucent header for the reveal screens (results / partner apply):
 * wordmark, optional context label, "Start over", light locale chips.
 */
export function RevealHeader({
  label,
  onStartOver,
  onSelectLocale,
}: {
  label?: string
  onStartOver: () => void
  onSelectLocale: (locale: AppLocale) => void
}) {
  const t = useTranslations('gateway')

  return (
    <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-border bg-[rgba(250,250,247,0.92)] px-4 py-2.5 backdrop-blur-md sm:px-10 sm:py-3">
      <div className="flex items-baseline gap-2">
        <span className="font-display text-xl font-extrabold tracking-[-0.01em] text-primary">
          AMClub
        </span>
        {label && (
          <span className="text-[13px] font-semibold text-foreground-secondary">{label}</span>
        )}
      </div>
      <div className="flex items-center gap-3.5">
        <button
          type="button"
          onClick={onStartOver}
          className="min-h-9 cursor-pointer border-none bg-transparent p-0 font-sans text-[13px] font-semibold text-foreground-secondary underline underline-offset-[3px] transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {t('start_over')}
        </button>
        <LanguageChips variant="light" onSelect={onSelectLocale} />
      </div>
    </header>
  )
}
