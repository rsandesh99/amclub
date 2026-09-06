'use client'

import { useLocale } from 'next-intl'
import { usePathname, useRouter } from '@/i18n/navigation'
import { cn } from '@/lib/utils'
import type { AppLocale } from '@/i18n/routing'

/** Locale label shown in switchers/chips — native script, per §4.4. */
export const LOCALE_LABELS: Record<AppLocale, string> = {
  en: 'EN',
  hi: 'हिं',
  te: 'తె',
  ta: 'த',
}

const LOCALES = Object.keys(LOCALE_LABELS) as AppLocale[]

/** Locale switch that preserves the current path. Works on all public pages. */
export function LanguageSwitcher({ className }: { className?: string }) {
  const locale = useLocale()
  const pathname = usePathname()
  const router = useRouter()

  function switchTo(next: AppLocale) {
    if (next === locale) return
    router.replace(pathname, { locale: next })
  }

  return (
    <div className={cn('inline-flex items-center rounded-chip border border-border bg-surface p-0.5 text-xs', className)}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => switchTo(l)}
          aria-pressed={locale === l}
          className={cn(
            'font-system rounded-chip px-2.5 py-1 font-medium transition-colors',
            locale === l ? 'bg-primary text-white' : 'text-foreground-secondary hover:text-primary',
          )}
        >
          {LOCALE_LABELS[l]}
        </button>
      ))}
    </div>
  )
}
