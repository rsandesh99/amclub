import { getTranslations } from 'next-intl/server'
import { SearchX, FileText } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { searchPackages } from '@/lib/catalog/queries'
import type { SearchFilters } from '@/lib/catalog/types'
import { ResultCard } from './ResultCard'

const PAGE_SIZE = 24

/**
 * Server-rendered results grid with empty-state (RFQ-rescue funnel) and
 * crawlable Prev/Next pagination. Used by /services and /services/[category].
 */
export async function CatalogResults({
  filters,
  basePath,
  searchParams,
  stateLabel,
}: {
  filters: SearchFilters
  basePath: string
  searchParams: Record<string, string | undefined>
  stateLabel?: string
}) {
  const t = await getTranslations('catalog')
  const offset = filters.offset ?? 0
  const { results, total } = await searchPackages({ ...filters, limit: PAGE_SIZE })

  if (results.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border bg-surface px-6 py-16 text-center shadow-resting">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-foreground-secondary">
          <SearchX className="h-7 w-7" />
        </div>
        <h3 className="text-md font-semibold">
          {stateLabel ? t('empty_in_state', { state: stateLabel }) : t('empty_no_results')}
        </h3>
        <p className="max-w-sm text-sm text-foreground-secondary">{t('empty_relax_hint')}</p>
        <Link
          href="/signup"
          className="mt-2 inline-flex items-center gap-2 rounded-button bg-primary px-5 py-2.5 text-sm font-semibold text-white shadow-xs transition hover:bg-primary/90 hover:shadow-hover active:shadow-pressed motion-safe:active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <FileText className="h-4 w-4" /> {t('empty_post_rfq')}
        </Link>
      </div>
    )
  }

  const buildUrl = (newOffset: number) => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(searchParams)) {
      if (v && k !== 'offset') params.set(k, v)
    }
    if (newOffset > 0) params.set('offset', String(newOffset))
    const qs = params.toString()
    return qs ? `${basePath}?${qs}` : basePath
  }

  const hasPrev = offset > 0
  const hasNext = offset + results.length < total

  return (
    <div className="space-y-6">
      <p className="text-sm text-foreground-secondary">{t('results_count', { count: total })}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {results.map((r) => (
          <ResultCard key={r.packageId} result={r} />
        ))}
      </div>

      {(hasPrev || hasNext) && (
        <div className="flex items-center justify-between pt-2">
          {hasPrev ? (
            <Link
              href={buildUrl(Math.max(0, offset - PAGE_SIZE))}
              className="inline-flex items-center rounded-button border border-border bg-surface px-4 py-2 text-sm font-medium shadow-xs transition hover:border-primary/40 hover:shadow-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              ← {t('prev')}
            </Link>
          ) : (
            <span />
          )}
          {hasNext && (
            <Link
              href={buildUrl(offset + PAGE_SIZE)}
              className="inline-flex items-center rounded-button border border-border bg-surface px-4 py-2 text-sm font-medium shadow-xs transition hover:border-primary/40 hover:shadow-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {t('next')} →
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
