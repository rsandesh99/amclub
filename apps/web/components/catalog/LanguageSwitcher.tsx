'use client'

import { ChevronDown, Languages } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { usePathname, useRouter } from '@/i18n/navigation'
import { cn } from '@/lib/utils'
import { useAnalytics } from '@/components/providers/posthog'
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
  const analytics = useAnalytics()

  function switchTo(next: AppLocale) {
    if (next === locale) return
    analytics.capture('locale_changed', { from: locale, to: next, device: 'web' }) // E14
    router.replace(pathname, { locale: next })
  }

  return (
    <label
      className={cn(
        'relative inline-flex h-11 items-center whitespace-nowrap rounded-button border border-border bg-surface text-sm text-foreground hover:border-primary/40 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20',
        className,
      )}
    >
      <Languages className="pointer-events-none absolute left-2.5 hidden h-4 w-4 text-primary sm:block" aria-hidden />
      <span className="sr-only">{t('switch')}</span>
      {/* Visible at every width (the current language's own name), a 44 px
          target, and still the native picker for keyboard / screen readers.
          The globe icon joins from sm up, where the header has room. */}
      <select
        value={locale}
        onChange={(e) => switchTo(e.target.value as AppLocale)}
        aria-label={t('switch')}
        lang={locale}
        className="font-system h-full min-h-0 cursor-pointer appearance-none rounded-button bg-transparent py-0 pl-2.5 pr-7 font-semibold text-foreground focus:outline-none sm:pl-8"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l} className="bg-surface text-foreground">
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 h-4 w-4 text-foreground-secondary" aria-hidden />
    </label>
  )
}
