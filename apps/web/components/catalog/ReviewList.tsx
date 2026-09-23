import { useTranslations } from 'next-intl'
import { Stars } from '@/components/catalog/Stars'
import type { ReviewRow } from '@/lib/catalog/types'

/** Verified-purchase reviews, as rendered on the provider page and /p/[slug]/reviews. */
export function ReviewList({ reviews }: { reviews: ReviewRow[] }) {
  const t = useTranslations('catalog')
  return (
    <ul className="mt-4 space-y-4">
      {reviews.map((r) => (
        <li key={r.id} className="rounded-card border border-border bg-surface p-4">
          <div className="flex items-center justify-between">
            <Stars rating={r.rating} />
            <span className="text-xs text-foreground-secondary">{t('verified_buyer')}</span>
          </div>
          {r.body && <p className="mt-2 text-sm text-foreground">{r.body}</p>}
          {r.providerReply && (
            <div className="mt-3 rounded-button bg-muted p-3 text-sm">
              <span className="font-medium text-primary">{t('provider_reply')}: </span>
              <span className="text-foreground-secondary">{r.providerReply}</span>
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}
