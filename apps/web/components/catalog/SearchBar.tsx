'use client'

import { useState } from 'react'
import { Search } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { cn } from '@/lib/utils'

/** Hero/header search. Submits to /services?query=… (the all-listings page). */
export function SearchBar({
  size = 'md',
  className,
  defaultValue = '',
  action = '/services',
}: {
  size?: 'md' | 'lg'
  className?: string
  defaultValue?: string
  /** Destination path for the search submit (e.g. /services or /app/search). */
  action?: string
}) {
  const t = useTranslations('catalog')
  const router = useRouter()
  const [value, setValue] = useState(defaultValue)

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const q = value.trim()
    router.push(q ? `${action}?query=${encodeURIComponent(q)}` : action)
  }

  return (
    <form
      onSubmit={onSubmit}
      className={cn(
        'flex w-full items-center gap-2 rounded-card border border-border bg-surface shadow-resting transition-shadow',
        'focus-within:border-primary/50 focus-within:shadow-hover focus-within:ring-2 focus-within:ring-primary/20',
        size === 'lg' ? 'p-2' : 'p-1.5',
        className,
      )}
      role="search"
    >
      <Search className={cn('ml-2 shrink-0 text-foreground-secondary', size === 'lg' ? 'h-5 w-5' : 'h-4 w-4')} />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t('search_placeholder')}
        aria-label={t('search_placeholder')}
        className={cn(
          'min-w-0 flex-1 bg-transparent outline-none placeholder:text-foreground-secondary',
          size === 'lg' ? 'text-md' : 'text-sm',
        )}
      />
      <button
        type="submit"
        className={cn(
          'shrink-0 rounded-button bg-primary font-semibold text-white shadow-xs transition',
          'hover:bg-primary/90 hover:shadow-hover active:bg-primary active:shadow-pressed motion-safe:active:scale-[0.98]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
          size === 'lg' ? 'px-5 py-2.5 text-md' : 'px-4 py-2 text-sm',
        )}
      >
        {t('search_btn')}
      </button>
    </form>
  )
}
