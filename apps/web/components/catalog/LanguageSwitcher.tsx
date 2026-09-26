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
    // Audit §5 item 10 — a signed-in person's choice goes to the account too, so
    // email, SMS and WhatsApp follow it. The root layout's pre-paint script marks
    // <html data-auth> when a session cookie exists; a stale mark only earns a 401.
    let persisted = false
    try { persisted = document.documentElement.hasAttribute('data-auth') } catch { /* no DOM */ }
    if (persisted) {
      void fetch('/api/v1/profile/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferredLocale: next }),
        keepalive: true,
      }).catch(() => undefined)
    }
    analytics.capture('locale_changed', { from: locale, to: next, device: 'web', persisted }) // E14
    router.replace(pathname, { locale: next })
  }

  return (
    <label
      className={cn(
        // min-w-0: in a crowded phone header the select clips its label rather than push the row off-screen.
        'relative inline-flex h-11 min-w-0 items-center whitespace-nowrap rounded-button border border-border bg-surface text-sm text-foreground hover:border-primary/40 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20',
        className,
      )}
    >
      <Languages className="pointer-events-none absolute left-2.5 hidden h-4 w-4 text-primary sm:block" aria-hidden />
      <span className="sr-only">{t('switch')}</span>
      {/* Visible at every width (the current language's own name), a 44 px
          target, and still the native picker for keyboard / screen readers.
          The globe icon joins from sm up, where the header has room; phones
          get tighter padding and a smaller chevron. */}
      <select
        value={locale}
        onChange={(e) => switchTo(e.target.value as AppLocale)}
        aria-label={t('switch')}
        lang={locale}
        className="font-system h-full min-h-0 min-w-0 cursor-pointer appearance-none rounded-button bg-transparent py-0 pl-2 pr-5 font-semibold text-foreground focus:outline-none sm:pl-8 sm:pr-7"
      >
        {LOCALES.map((l) => (
          <option key={l} value={l} lang={l} className="bg-surface text-foreground">
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 h-3.5 w-3.5 text-foreground-secondary sm:right-2 sm:h-4 sm:w-4" aria-hidden />
    </label>
  )
}
