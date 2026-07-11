'use client'

import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { LanguageChips } from './LanguageChips'
import { PublicHeaderAccount } from '@/components/catalog/PublicHeaderAccount'
import type { AppLocale } from '@/i18n/routing'

/**
 * Sticky translucent header for the reveal screens (results / partner apply).
 * These are the terminal destinations of the gateway island, so they carry the
 * real shell affordances the animation scenes intentionally omit: a home-linked
 * wordmark, the sign-in / sign-up (or account menu when logged in) entry reused
 * from the public header, plus "Start over" and light locale chips. Wraps on
 * narrow screens so nothing overflows.
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
    <header className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-[rgba(250,250,247,0.92)] px-4 py-2.5 backdrop-blur-md sm:px-10 sm:py-3">
      <div className="flex items-baseline gap-2">
        <Link
          href="/"
          className="rounded-[4px] font-display text-xl font-extrabold tracking-[-0.01em] text-primary transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
        >
          AMClub
        </Link>
        {label && (
          <span className="text-[13px] font-semibold text-foreground-secondary">{label}</span>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-x-3.5 gap-y-2">
        <button
          type="button"
          onClick={onStartOver}
          className="min-h-9 cursor-pointer border-none bg-transparent p-0 font-sans text-[13px] font-semibold text-foreground-secondary underline underline-offset-[3px] transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {t('start_over')}
        </button>
        <LanguageChips variant="light" onSelect={onSelectLocale} />
        <PublicHeaderAccount />
      </div>
    </header>
  )
}
