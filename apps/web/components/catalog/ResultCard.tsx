import { useLocale, useTranslations } from 'next-intl'
import { Clock, MapPin, RefreshCw } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { pickI18n, formatResponseTime, initials } from '@/lib/format'
import { INDIAN_STATES } from '@/lib/constants/india'
import { PriceBlock } from './PriceBlock'
import { Stars } from './Stars'
import { ProviderCredential } from './ProviderCredential'
import type { CatalogResult } from '@/lib/catalog/types'

const STATE_LABEL = new Map(INDIAN_STATES.map((s) => [s.value, s.label]))

/**
 * The workhorse listing card (§4.3): provider identity + trust tick + rating,
 * package title, the canonical PriceBlock, and delivery/state/response chips.
 * One result = one package shown with its provider's trust signals.
 */
export function ResultCard({ result }: { result: CatalogResult }) {
  const locale = useLocale()
  const t = useTranslations('catalog')
  const title = pickI18n(result.titleI18n, locale)
  const responseTime = formatResponseTime(result.medianResponseMinutes)
  const stateLabel = STATE_LABEL.get(result.state) ?? result.state

  return (
    <Link
      href={`/p/${result.providerSlug}/${result.packageSlug}`}
      className="group flex flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card transition-colors hover:border-primary/40"
    >
      {/* Provider row — credential-first (§4.3): credential leads, rating secondary */}
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
          {initials(result.displayName)}
        </div>
        <div className="min-w-0 flex-1">
          <ProviderCredential
            name={result.displayName}
            credentialKind={result.headlineCredential}
            verified={result.verified}
          />
          <Stars rating={result.avgRating} count={result.reviewCount} className="mt-1" />
        </div>
        {result.topRated && (
          <span className="shrink-0 rounded-chip bg-accent/15 px-2 py-0.5 text-xs font-semibold text-accent-foreground">
            {t('top_rated')}
          </span>
        )}
      </div>

      {/* Package title */}
      <h3 className="line-clamp-2 text-md font-medium leading-snug text-foreground group-hover:text-primary">
        {title}
      </h3>

      {/* Chips */}
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-foreground-secondary">
        <span className="inline-flex items-center gap-1 rounded-chip bg-muted px-2 py-0.5">
          <Clock className="h-3 w-3" /> {t('delivery_days', { days: result.deliveryDays })}
        </span>
        <span className="inline-flex items-center gap-1 rounded-chip bg-muted px-2 py-0.5">
          <RefreshCw className="h-3 w-3" /> {t('revisions', { count: result.revisionCount })}
        </span>
        <span className="inline-flex items-center gap-1 rounded-chip bg-muted px-2 py-0.5">
          <MapPin className="h-3 w-3" /> {stateLabel}
        </span>
        {responseTime && (
          <span className="text-foreground-secondary">{t('responds_in', { time: responseTime })}</span>
        )}
      </div>

      {/* Price */}
      <div className="mt-auto border-t border-border pt-3">
        <PriceBlock
          pricePaise={result.pricePaise}
          discountBps={result.discountBps}
          memberExtraDiscountBps={result.memberExtraDiscountBps}
        />
      </div>
    </Link>
  )
}
