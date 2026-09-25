import { getLocale, getTranslations } from 'next-intl/server'
import { FileText } from 'lucide-react'
import { indianStateName } from '@amclub/shared'
import { TrackedLink } from '@/components/analytics/TrackedLink'

/**
 * FR-2.7 (N7) — weak or zero results never dead-end: an inline card to get
 * quotes instead, prefilled through the requirement form (N20: ?q=&category=).
 */
export async function WeakResultsCard({ query, category, state, zero }: { query?: string | undefined; category?: string | undefined; state?: string | undefined; zero: boolean }) {
  const t = await getTranslations('filters_v3')
  const stateName = state ? indianStateName(state, await getLocale()) : undefined
  const qs = new URLSearchParams()
  if (query) qs.set('q', query)
  if (category) qs.set('category', category)
  const href = `/app/rfq/new${qs.toString() ? `?${qs.toString()}` : ''}`
  return (
    <div className="flex flex-col gap-3 rounded-card border border-primary/30 bg-primary/5 p-5 sm:flex-row sm:items-center sm:justify-between" data-testid="weak-results">
      <div>
        <p className="font-semibold">
          {query ? t('weak_title', { q: query, state: stateName ?? 'none' }) : t('weak_title_noq', { state: stateName ?? 'none' })}
        </p>
        <p className="mt-1 text-sm text-foreground-secondary">{zero ? t('weak_body_zero') : t('weak_body')}</p>
      </div>
      <TrackedLink
        href={href as '/app/rfq/new'}
        event="search_to_requirement_clicked"
        eventProps={{ zero }}
        className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-button bg-primary px-5 text-sm font-semibold text-white hover:bg-primary/90"
      >
        <FileText className="h-4 w-4" aria-hidden /> {t('weak_cta')}
      </TrackedLink>
    </div>
  )
}
