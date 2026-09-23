import { useLocale, useTranslations } from 'next-intl'
import { formatStatPct, INDIAN_STATES } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { CompareToggle } from '@/components/compare-v3/CompareToggle'
import { ProviderCredential } from '@/components/catalog/ProviderCredential'
import { formatINR, formatResponseTime, initials, pickI18n } from '@/lib/format'
import type { CatalogResult } from '@/lib/catalog/types'
import type { CardTrust } from '@/lib/trust/card-trust'

const STATE_LABEL = new Map(INDIAN_STATES.map((s) => [s.value, s.label]))

/**
 * FR-2.4 list view — one dense row per package: logo · name + credential ·
 * rating (n) · stat · delivery · replies · price + GST (the server display).
 * Compact density; the desktop header row labels the columns.
 */
export function ResultRow({ result, trust, compare = false, sid, position }: { result: CatalogResult; trust?: CardTrust | undefined; compare?: boolean; sid?: string; position?: number }) {
  const locale = useLocale()
  const t = useTranslations('catalog')
  const reply = formatResponseTime(result.medianResponseMinutes)
  return (
    <li className="flex items-center">
      <Link
        href={`/p/${result.providerSlug}/${result.packageSlug}${sid ? `?sid=${sid}${position ? `&pos=${position}` : ''}` : ''}`}
        className="grid min-w-0 flex-1 grid-cols-[2.25rem_1fr_auto] items-center gap-x-3 gap-y-1 px-3 py-2.5 hover:bg-sunken md:grid-cols-[2.25rem_minmax(0,2.4fr)_6rem_6rem_5rem_4.5rem_8rem]"
        data-testid="result-row"
      >
        {trust && result.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- approved logos only (E3 N12)
          <img src={result.logoUrl} alt="" width={36} height={36} loading="lazy" className="h-9 w-9 rounded-full bg-muted object-cover" />
        ) : (
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">{initials(result.displayName)}</span>
        )}
        <span className="min-w-0">
          <ProviderCredential name={result.displayName} credentialKind={result.headlineCredential} verified={result.verified} />
          <span className="block truncate text-sm text-foreground-secondary">
            {pickI18n(result.titleI18n, locale)} · {result.city ?? STATE_LABEL.get(result.state) ?? result.state}
          </span>
        </span>
        <span className="text-right text-sm font-semibold tabular-nums md:order-last">{t('price_plus_gst', { price: formatINR(result.display.taxablePaise) })}</span>
        <span className="col-start-2 text-xs tabular-nums text-foreground-secondary md:col-start-auto md:text-sm">
          {result.reviewCount > 0 ? `★ ${result.avgRating.toFixed(1)} (${result.reviewCount})` : t('new')}
        </span>
        <span className="hidden text-sm tabular-nums text-foreground-secondary md:block">
          {trust?.stat ? t(trust.stat.kind === 'on_time' ? 'stat_on_time_short' : 'stat_repeat_short', { pct: formatStatPct(trust.stat.value.pct), n: trust.stat.value.n }) : '—'}
        </span>
        <span className="hidden text-sm tabular-nums text-foreground-secondary md:block">{reply ?? '—'}</span>
        <span className="hidden text-sm tabular-nums md:block">{t('delivery_days', { days: result.deliveryDays })}</span>
      </Link>
      {compare && <CompareToggle id={result.packageId} title={pickI18n(result.titleI18n, locale)} className="mr-3 shrink-0" />}
    </li>
  )
}
