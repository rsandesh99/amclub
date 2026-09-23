import { useLocale, useTranslations } from 'next-intl'
import { BadgeCheck, ShieldCheck } from 'lucide-react'
import { formatStatPct } from '@amclub/shared'
import type { ProviderDetail } from '@/lib/catalog/types'
import type { ProviderTrust } from '@/lib/trust/provider-trust'
import { formatResponseTime, initials, pickI18n } from '@/lib/format'
import { StatTile } from '@/components/ui-v3/StatTile'
import { TrustPanel } from './TrustPanel'

const KNOWN_LANGS = new Set(['en', 'hi', 'te', 'ta', 'mr', 'kn', 'ml', 'gu', 'bn', 'ur', 'pa', 'or'])

const MONTH_YEAR = (iso: string, locale: string) =>
  new Intl.DateTimeFormat(`${['hi', 'te', 'ta'].includes(locale) ? locale : 'en'}-IN-u-nu-latn`, { timeZone: 'Asia/Kolkata', month: 'short', year: 'numeric' }).format(new Date(iso))

/**
 * E3 profile header (FR-3.2 / FR-3.5): identity row, four stat tiles (each
 * with its sample; on-time only when D1 is on and above its gate), the trust
 * panel and anchor section tabs. Ten decision facts above the fold (§3.3 B).
 */
export function ProviderHeaderV3({
  provider,
  trust,
  stateLabel,
  headlineCredential,
  actions,
  save,
}: {
  provider: ProviderDetail
  trust: ProviderTrust
  stateLabel: string
  headlineCredential: string | null
  actions: React.ReactNode
  save: React.ReactNode
}) {
  const t = useTranslations('trust')
  const tc = useTranslations('catalog')
  const locale = useLocale()
  const response = formatResponseTime(provider.medianResponseMinutes)
  const onTime = trust.stats?.onTime ?? null
  return (
    <section className="space-y-4">
      <div className="flex items-start gap-4">
        {trust.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- approved logo only (N12)
          <img src={trust.logoUrl} alt="" width={64} height={64} className="h-16 w-16 shrink-0 rounded-card bg-muted object-cover shadow-xs" />
        ) : (
          <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-card bg-primary-soft text-xl font-bold text-primary">{initials(provider.displayName)}</div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h1 className="t-title-1 truncate text-foreground">{provider.displayName}</h1>
            {provider.badges.length > 0 && <BadgeCheck className="h-5 w-5 shrink-0 text-verified" aria-label={tc('verified')} />}
          </div>
          {headlineCredential && (
            <p className="t-subhead mt-0.5 inline-flex items-center gap-1 text-foreground-secondary">
              <ShieldCheck className="h-4 w-4 text-verified" aria-hidden /> {tc(`badge_${headlineCredential}` as 'badge_gstin')}
            </p>
          )}
          <p className="t-subhead mt-0.5 text-foreground-secondary">
            {[provider.city, stateLabel].filter(Boolean).join(', ')}
            {trust.since ? ` · ${t('since', { date: MONTH_YEAR(trust.since, locale) })}` : ''}
            {trust.yearsExperience ? ` · ${t('years_practice', { band: trust.yearsExperience })}` : ''}
          </p>
          {provider.languages.length > 0 && (
            <p className="t-footnote mt-0.5 text-foreground-tertiary">{provider.languages.map((l) => (KNOWN_LANGS.has(l) ? t(`lang_${l}` as 'lang_en') : l.toUpperCase())).join(' · ')}</p>
          )}
        </div>
        <div className="shrink-0">{save}</div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile
          value={provider.reviewCount > 0 ? `${provider.avgRating.toFixed(1)} ★` : '—'}
          label={t('tile_reviews', { n: provider.reviewCount })}
          srLabel={t('tile_reviews_sr', { rating: provider.avgRating.toFixed(1), n: provider.reviewCount })}
        />
        {onTime ? (
          <StatTile value={`${formatStatPct(onTime.pct)} %`} label={t('tile_on_time')} note={t('tile_sample', { n: onTime.n })} srLabel={t('tile_on_time_sr', { pct: formatStatPct(onTime.pct), n: onTime.n })} />
        ) : (
          <StatTile value={trust.stats?.repeatBuyers ? `${formatStatPct(trust.stats.repeatBuyers.pct)} %` : '—'} label={t('tile_repeat')} note={trust.stats?.repeatBuyers ? t('tile_sample', { n: trust.stats.repeatBuyers.n }) : undefined} />
        )}
        <StatTile value={response ? `~${response}` : '—'} label={t('tile_replies')} />
        <StatTile value={provider.completedOrders} label={t('tile_orders')} />
      </div>

      <div id="credentials" className="scroll-mt-24"><TrustPanel trust={trust} /></div>

      {actions}

      <nav aria-label={t('sections')} className="hairline-b -mx-4 flex gap-1 overflow-x-auto px-4">
        {(['packages', 'about', 'reviews', 'credentials'] as const).map((s) => (
          <a key={s} href={`#${s}`} className="t-callout whitespace-nowrap px-3 py-2.5 text-foreground-secondary hover:text-foreground">
            {t(`tab_${s}`)}
          </a>
        ))}
      </nav>
      {provider.categories.length > 0 && (
        <p className="t-footnote text-foreground-secondary">{provider.categories.map((c) => pickI18n(c.nameI18n, locale)).join(' · ')}</p>
      )}
    </section>
  )
}
