'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { MapPin } from 'lucide-react'
import { useRouter } from '@/i18n/navigation'
import { INDIAN_STATES } from '@/lib/constants/india'
import { cn } from '@/lib/utils'

const COOKIE = 'amc_jurisdiction'

function readInitial(): string {
  if (typeof document === 'undefined') return ''
  // The active ?state= filter wins; otherwise the persisted jurisdiction cookie.
  const param = new URLSearchParams(window.location.search).get('state')
  if (param) return param
  const m = document.cookie.match(/(?:^|; )amc_jurisdiction=([^;]*)/)
  return m?.[1] ? decodeURIComponent(m[1]) : ''
}

/**
 * First-class jurisdiction/state selector (§4.3 — compliance is local, so this
 * is header-level, not a buried filter). Persists per user via cookie and seeds
 * the `state` search filter. Kept client-only so the shells stay static.
 */
export function JurisdictionSelector({ className }: { className?: string }) {
  const t = useTranslations('catalog')
  const router = useRouter()
  const [state, setState] = useState('')

  useEffect(() => {
    setState(readInitial())
  }, [])

  function choose(next: string) {
    setState(next)
    // Persist for a year so the next visit remembers the jurisdiction.
    document.cookie = `${COOKIE}=${encodeURIComponent(next)}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
    router.push(next ? `/services?state=${next}` : '/services')
  }

  return (
    <label
      className={cn(
        'relative inline-flex items-center gap-1 rounded-chip border border-border bg-surface pl-2 pr-1 text-xs text-foreground-secondary',
        className,
      )}
    >
      <MapPin className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
      <span className="sr-only">{t('filter_state')}</span>
      <select
        value={state}
        onChange={(e) => choose(e.target.value)}
        aria-label={t('filter_state')}
        className="max-w-[7.5rem] cursor-pointer truncate bg-transparent py-1.5 pr-4 font-medium text-foreground focus:outline-none"
      >
        <option value="">{t('all_states')}</option>
        {INDIAN_STATES.map((s) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </select>
    </label>
  )
}
