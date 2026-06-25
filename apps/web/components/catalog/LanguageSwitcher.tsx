'use client'

import { useLocale } from 'next-intl'
import { usePathname, useRouter } from '@/i18n/navigation'
import { cn } from '@/lib/utils'

/** EN/HI switch that preserves the current path. Works on all public pages. */
export function LanguageSwitcher({ className }: { className?: string }) {
  const locale = useLocale()
  const pathname = usePathname()
  const router = useRouter()

  function switchTo(next: 'en' | 'hi') {
    if (next === locale) return
    router.replace(pathname, { locale: next })
  }

  return (
    <div className={cn('inline-flex items-center rounded-chip border border-gray-200 bg-surface p-0.5 text-xs', className)}>
      {(['en', 'hi'] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => switchTo(l)}
          aria-pressed={locale === l}
          className={cn(
            'rounded-chip px-2.5 py-1 font-medium transition-colors',
            locale === l ? 'bg-primary text-white' : 'text-foreground-secondary hover:text-primary',
          )}
        >
          {l === 'en' ? 'EN' : 'हिं'}
        </button>
      ))}
    </div>
  )
}
