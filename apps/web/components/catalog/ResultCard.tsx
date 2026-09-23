import { useLocale, useTranslations } from 'next-intl'
import { Clock, MapPin, RefreshCw } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { pickI18n, formatResponseTime, initials } from '@/lib/format'
import { INDIAN_STATES } from '@/lib/constants/india'
import { PriceBlock } from './PriceBlock'
import { Stars } from './Stars'
import { ProviderCredential } from './ProviderCredential'
import type { CatalogResult } from '@/lib/catalog/types'
import type { CardTrust } from '@/lib/trust/card-trust'
import { formatStatPct } from '@amclub/shared'

const STATE_LABEL = new Map(INDIAN_STATES.map((s) => [s.value, s.label]))

/**
 * The workhorse listing card (§4.3): provider identity + trust tick + rating,
 * package title, the canonical PriceBlock, and delivery/state/response chips.
 * One result = one package shown with its provider's trust signals.
 */
export function ResultCard({ result, trust }: { result: CatalogResult; trust?: CardTrust | undefined }) {
  const locale = useLocale()
  const t = useTranslations('catalog')
  const title = pickI18n(result.titleI18n, locale)
  const responseTime = formatResponseTime(result.medianResponseMinutes)
  const stateLabel = STATE_LABEL.get(result.state) ?? result.state

  return (
    <Link
      href={`/p/${result.providerSlug}/${result.packageSlug}`}
      className="card-interactive group flex h-full flex-col gap-3 p-4"
    >
      {/* Provider row — credential-first (§4.3): credential leads, rating secondary */}
      <div className="flex items-center gap-3">
        {trust && result.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- approved logos only (E3 N12); small, lazy
          <img src={result.logoUrl} alt="" width={36} height={36} loading="lazy" className="h-9 w-9 shrink-0 rounded-full bg-muted object-cover" />
        ) : (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
            {initials(result.displayName)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <ProviderCredential
            name={result.displayName}
            credentialKind={result.headlineCredential}
            verified={result.verified}
          />
          <div className="mt-1 flex flex-wrap items-center gap-x-2">
            <Stars rating={result.avgRating} count={result.reviewCount} />
            {/* E3 FR-3.1 — ONE measured stat with its sample (gated by D1). */}
            {trust?.stat && (
              <span className="text-xs font-medium tabular-nums text-foreground-secondary">
                {t(trust.stat.kind === 'on_time' ? 'stat_on_time_short' : 'stat_repeat_short', { pct: formatStatPct(trust.stat.value.pct), n: trust.stat.value.n })}
              </span>
            )}
          </div>
        </div>
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
        {trust?.activeThisWeek && (
          <span className="inline-flex items-center gap-1 text-success">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-success" /> {t('active_this_week')}
          </span>
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
