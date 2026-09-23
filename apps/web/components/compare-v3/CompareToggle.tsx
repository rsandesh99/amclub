'use client'

import { useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import { useAnalytics } from '@/components/providers/posthog'
import { cn } from '@/lib/utils'
import { COMPARE_MAX, toggleCompare, useCompare } from './store'

/** FR-2.9 — "Compare" on a card or row (up to 4). */
export function CompareToggle({ id, title, className }: { id: string; title: string; className?: string }) {
  const t = useTranslations('compare_v3')
  const analytics = useAnalytics()
  const items = useCompare()
  const on = items.some((x) => x.id === id)
  const full = !on && items.length >= COMPARE_MAX
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={full}
      title={full ? t('full', { n: COMPARE_MAX }) : undefined}
      onClick={() => {
        const n = toggleCompare({ id, title })
        if (n !== null && !on) analytics.capture('shortlist_added', { device: 'web', count: n })
      }}
      className={cn(
        'inline-flex min-h-[32px] items-center gap-1.5 rounded-chip border bg-surface px-2.5 text-xs font-medium shadow-xs disabled:opacity-40',
        on ? 'border-primary text-primary' : 'border-border text-foreground-secondary hover:text-foreground',
        className,
      )}
      data-testid="compare-toggle"
    >
      <span className={cn('flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border', on ? 'border-primary bg-primary text-white' : 'border-border')}>
        {on && <Check className="h-2.5 w-2.5" aria-hidden />}
      </span>
      {t('compare')}
    </button>
  )
}
