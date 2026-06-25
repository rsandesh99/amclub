import { useTranslations } from 'next-intl'
import { BadgeCheck, MapPin } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { initials } from '@/lib/format'
import { INDIAN_STATES } from '@/lib/constants/india'
import { Stars } from './Stars'
import type { ProviderDetail } from '@/lib/catalog/types'

const STATE_LABEL = new Map(INDIAN_STATES.map((s) => [s.value, s.label]))

/** Compact provider card for the landing "top-rated" strip. Links to /p/[slug]. */
export function ProviderMiniCard({ provider }: { provider: ProviderDetail }) {
  const t = useTranslations('catalog')
  const verified = provider.badges.length > 0
  const stateLabel = STATE_LABEL.get(provider.state) ?? provider.state

  return (
    <Link
      href={`/p/${provider.slug}`}
      className="flex w-60 shrink-0 flex-col gap-3 rounded-card border border-gray-200 bg-surface p-4 shadow-card transition-colors hover:border-primary/40"
    >
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary">
          {initials(provider.displayName)}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <span className="truncate text-sm font-semibold">{provider.displayName}</span>
            {verified && <BadgeCheck className="h-4 w-4 shrink-0 text-trust" />}
          </div>
          <Stars rating={provider.avgRating} count={provider.reviewCount} className="mt-0.5" />
        </div>
      </div>
      <div className="flex items-center justify-between text-xs text-foreground-secondary">
        <span className="inline-flex items-center gap-1">
          <MapPin className="h-3 w-3" /> {stateLabel}
        </span>
        <span>{t('orders_done', { count: provider.completedOrders })}</span>
      </div>
    </Link>
  )
}
