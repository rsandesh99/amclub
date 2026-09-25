import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { ChevronRight } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { Stars } from '@/components/catalog/Stars'
import { ReviewList } from '@/components/catalog/ReviewList'
import { getProviderBySlug, getReviews } from '@/lib/catalog/queries'
import { isOnForEveryone } from '@/lib/experiments'
import { reviewExtras } from '@/lib/trust/reviews'
import { ReviewHistogram } from '@/components/trust/ReviewHistogram'

export const revalidate = 300

const PAGE_SIZE = 20

export async function generateMetadata({ params }: { params: Promise<{ providerSlug: string }> }): Promise<Metadata> {
  const { providerSlug } = await params
  const provider = await getProviderBySlug(providerSlug)
  if (!provider) return {}
  return {
    title: `${provider.displayName} — reviews`,
    alternates: { canonical: `/p/${providerSlug}/reviews` },
  }
}

/**
 * E0 / U11 — every published, verified-purchase review for one provider,
 * newest first, 20 per page (the provider page shows the latest 10).
 */
export default async function ProviderReviewsPage({
  params,
  searchParams,
}: {
  params: Promise<{ providerSlug: string }>
  searchParams: Promise<{ page?: string }>
}) {
  const { providerSlug } = await params
  const { page: pageParam } = await searchParams
  const provider = await getProviderBySlug(providerSlug)
  if (!provider) notFound()
  const t = await getTranslations('catalog')

  const requested = Math.max(1, Math.floor(Number(pageParam)) || 1)
  const first = await getReviews(provider.id, PAGE_SIZE, (requested - 1) * PAGE_SIZE)
  const pageCount = Math.max(1, Math.ceil(first.total / PAGE_SIZE))
  const page = Math.min(requested, pageCount)
  const { reviews, total } = page === requested ? first : await getReviews(provider.id, PAGE_SIZE, (page - 1) * PAGE_SIZE)
  // Experience v3 E3 (N13): histogram + "repeat buyer" marker.
  const extras = isOnForEveryone('trust') ? await reviewExtras(provider.id, reviews.map((r) => r.id)).catch(() => null) : null

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <nav className="mb-4 flex flex-wrap items-center gap-1 text-xs text-foreground-secondary">
        <Link href={`/p/${provider.slug}`} className="hover:text-primary">{provider.displayName}</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">{t('reviews')}</span>
      </nav>
      <h1 className="font-display text-2xl font-bold">
        {t('reviews')} <span className="text-foreground-secondary">({total})</span>
      </h1>
      <Stars rating={provider.avgRating} count={provider.reviewCount} className="mt-2" />

      {reviews.length === 0 ? (
        <p className="mt-6 text-sm text-foreground-secondary">{t('no_reviews')}</p>
      ) : (
        <>
          {extras && <div className="mt-4"><ReviewHistogram histogram={extras.histogram} total={total} /></div>}
          <ReviewList reviews={extras ? reviews.map((r) => ({ ...r, repeatBuyer: extras.repeat.has(r.id) })) : reviews} />
        </>
      )}

      {pageCount > 1 && (
        <nav aria-label={t('reviews_pagination')} className="mt-6 flex items-center justify-between text-sm">
          {page > 1 ? (
            <Link href={`/p/${provider.slug}/reviews?page=${page - 1}`} className="font-medium text-primary hover:underline">
              {t('page_prev')}
            </Link>
          ) : <span />}
          <span className="text-foreground-secondary">{t('page_of', { page, pages: pageCount })}</span>
          {page < pageCount ? (
            <Link href={`/p/${provider.slug}/reviews?page=${page + 1}`} className="font-medium text-primary hover:underline">
              {t('page_next')}
            </Link>
          ) : <span />}
        </nav>
      )}
    </div>
  )
}
