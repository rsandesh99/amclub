'use client'

import { useLocale } from 'next-intl'
import { cn } from '@/lib/utils'
import { LOCALE_LABELS } from '@/components/catalog/LanguageSwitcher'
import type { AppLocale } from '@/i18n/routing'

const LOCALES = Object.keys(LOCALE_LABELS) as AppLocale[]

/**
 * Gateway locale chips — dark variant sits on the green stage, light variant
 * in the reveal-screen headers. Selection triggers a real next-intl locale
 * navigation (wired in Gateway.tsx, which stashes the wizard position first).
 */
export function LanguageChips({
  variant,
  onSelect,
  className,
}: {
  variant: 'dark' | 'light'
  onSelect: (locale: AppLocale) => void
  className?: string
}) {
  const locale = useLocale()

  return (
    <div className={cn('flex gap-1.5', className)} aria-label="Language">
      {LOCALES.map((l) => {
        const active = l === locale
        return (
          <button
            key={l}
            type="button"
            onClick={() => onSelect(l)}
            aria-pressed={active}
            lang={l}
            className={cn(
              'font-system min-h-9 cursor-pointer whitespace-nowrap rounded-chip border px-3 py-1 text-[13px] font-semibold transition-colors duration-150',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
              variant === 'dark'
                ? active
                  ? 'border-white/95 bg-white/95 text-[#1B4D3E] focus-visible:ring-white focus-visible:ring-offset-transparent'
                  : 'border-white/[0.22] bg-white/[0.08] text-white/75 hover:bg-white/[0.16] focus-visible:ring-white focus-visible:ring-offset-transparent'
                : active
                  ? 'border-primary bg-primary text-white focus-visible:ring-primary focus-visible:ring-offset-background'
                  : 'border-border bg-surface text-foreground-secondary hover:text-primary focus-visible:ring-primary focus-visible:ring-offset-background',
            )}
          >
            {LOCALE_LABELS[l]}
          </button>
        )
      })}
    </div>
  )
}
