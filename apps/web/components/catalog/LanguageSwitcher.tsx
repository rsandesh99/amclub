'use client'

import { Languages } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { usePathname, useRouter } from '@/i18n/navigation'
import { cn } from '@/lib/utils'
import type { AppLocale } from '@/i18n/routing'

/**
 * Language names in their own script (endonyms). Deliberately NOT routed
 * through next-intl: a Telugu speaker on an English page must be able to
 * find "తెలుగు" — the name of a language is the one string that must not
 * change with the current locale.
 */
export const LOCALE_LABELS: Record<AppLocale, string> = {
  en: 'English',
  hi: 'हिंदी',
  te: 'తెలుగు',
  ta: 'தமிழ்',
}

const LOCALES = Object.keys(LOCALE_LABELS) as AppLocale[]

/**
 * Header language control: one clearly labelled dropdown (globe icon + the
 * current language's own name) instead of a row of script abbreviations.
 * A native <select> — keyboard and screen-reader complete, no JS menu, and the
 * device's own fonts draw the scripts (no web-font download for the labels).
 * Switching preserves the current path.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const t = useTranslations('locale')
  const locale = useLocale() as AppLocale
  const pathname = usePathname()
  const router = useRouter()

  function switchTo(next: AppLocale) {
    if (next === locale) return
    router.replace(pathname, { locale: next })
  }

  return (
    <label
      className={cn(
        'relative inline-flex h-10 items-center gap-1 whitespace-nowrap rounded-button border border-border bg-surface px-2 text-sm text-foreground hover:border-primary/40 sm:gap-1.5 sm:pl-2.5 sm:pr-1',
        className,
      )}
    >
      <Languages className="h-4 w-4 shrink-0 text-primary" aria-hidden />
      <span className="sr-only">{t('switch')}</span>
      <select
        value={locale}
        onChange={(e) => switchTo(e.target.value as AppLocale)}
        aria-label={t('switch')}
        // Phones: icon-only (the label is transparent, the native picker still
        // opens with full names). Tablet and up: the language's own name.
        className="font-system w-6 cursor-pointer appearance-none bg-transparent py-1 font-semibold text-transparent focus:outline-none sm:w-auto sm:appearance-auto sm:pr-1 sm:text-foreground"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l} className="bg-surface text-foreground">
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
    </label>
  )
}
