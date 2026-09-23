'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { SEARCH_FEEDBACK_REASONS } from '@amclub/shared'
import { useAnalytics } from '@/components/providers/posthog'
import { cn } from '@/lib/utils'

/** FR-2.6 (N6) — "Did you find what you need?" after the first results page. */
export function SearchFeedback({ query, filters, resultIds }: { query: string | null; filters: Record<string, string>; resultIds: string[] }) {
  const t = useTranslations('filters_v3')
  const analytics = useAnalytics()
  const [state, setState] = useState<'ask' | 'reason' | 'done'>('ask')

  const send = (helpful: boolean, reason: (typeof SEARCH_FEEDBACK_REASONS)[number] | null) => {
    analytics.capture('search_feedback_given', { device: 'web', helpful, reason })
    void fetch('/api/v1/search/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, filters, resultIds: resultIds.slice(0, 24), helpful, reason, surface: 'web' }),
    }).catch(() => {})
  }

  if (state === 'done') return <p className="py-3 text-center text-sm text-foreground-secondary" role="status">{t('fb_thanks')}</p>
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 border-t border-separator py-4 text-sm" data-testid="search-feedback">
      {state === 'ask' ? (
        <>
          <span className="text-foreground-secondary">{t('fb_question')}</span>
          <button type="button" className="min-h-[36px] rounded-chip border border-border px-4 hover:border-primary/40" onClick={() => { send(true, null); setState('done') }}>{t('fb_yes')}</button>
          <button type="button" className="min-h-[36px] rounded-chip border border-border px-4 hover:border-primary/40" onClick={() => setState('reason')}>{t('fb_no')}</button>
        </>
      ) : (
        <>
          <span className="w-full text-center text-foreground-secondary sm:w-auto">{t('fb_reason_prompt')}</span>
          {SEARCH_FEEDBACK_REASONS.map((r) => (
            <button key={r} type="button" className={cn('min-h-[36px] rounded-chip border border-border px-3 hover:border-primary/40')} onClick={() => { send(false, r); setState('done') }}>
              {t(`fb_reason_${r}`)}
            </button>
          ))}
          <button type="button" className="min-h-[36px] px-3 text-foreground-secondary underline" onClick={() => { send(false, null); setState('done') }}>{t('fb_skip')}</button>
        </>
      )}
    </div>
  )
}
