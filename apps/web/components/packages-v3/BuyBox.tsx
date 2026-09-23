'use client'

import { useLocale, useTranslations } from 'next-intl'
import { Clock, RefreshCw, Landmark, RotateCcw } from 'lucide-react'
import { totalBucket } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { PriceBlock } from '@/components/catalog/PriceBlock'
import { SegmentedControl } from '@/components/ui-v3/SegmentedControl'
import { useAnalytics } from '@/components/providers/posthog'
import { formatINR, formatINRExact } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useTierState } from './TierContext'
import { TranslatedText } from '@/components/catalog/TranslatedText'

const buyHref = (packageId: string) => `/app/checkout/${packageId}`

/** Tier tabs (Basic / Standard / Premium). Rendered only for a tier group. */
export function TierTabs({ className }: { className?: string }) {
  const t = useTranslations('packages_v3')
  const { options, selected, select } = useTierState()
  if (options.length < 2) return null
  return (
    <SegmentedControl
      {...(className ? { className } : {})}
      ariaLabel={t('tiers_label')}
      options={options.map((o) => ({ value: o.packageId, label: t(`tier_${o.tier ?? 'basic'}`) }))}
      value={selected.packageId}
      onChange={select}
    />
  )
}

/** FR-4.4 — one line summarising the refund policy + the policy link. */
export function RefundLine({ className }: { className?: string }) {
  const t = useTranslations('packages_v3')
  const analytics = useAnalytics()
  return (
    <p className={cn('flex items-start gap-1.5 text-xs text-foreground-secondary', className)} data-testid="refund-line">
      <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        {t('refund_line')}{' '}
        <Link
          href="/refund-policy"
          className="font-medium text-primary hover:underline"
          onClick={() => analytics.capture('refund_policy_opened', { device: 'web' })}
        >
          {t('refund_policy_link')}
        </Link>
      </span>
    </p>
  )
}

/** FR-4.5 (N17) — the government-portal disclaimer, linking to the external_wait explanation. */
export function GovtLine({ className }: { className?: string }) {
  const t = useTranslations('packages_v3')
  return (
    <p className={cn('flex items-start gap-1.5 text-xs text-foreground-secondary', className)} data-testid="govt-line">
      <Landmark className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>
        {t('govt_line')}{' '}
        <Link href="/help#government-portal" className="font-medium text-primary hover:underline">
          {t('govt_link')}
        </Link>
      </span>
    </p>
  )
}

/**
 * FR-4.2 sticky buy box: tier tabs · price equation · delivery / revisions ·
 * "Choose this if…" · Buy now · the escrow note · refund line · government
 * line. Every figure is the selected option's server `display`.
 */
export function BuyBox({ buyNote }: { buyNote: string }) {
  const t = useTranslations('catalog')
  const tv = useTranslations('packages_v3')
  const analytics = useAnalytics()
  const { options, selected, mostChosen } = useTierState()
  const locale = useLocale()

  return (
    <div className="sticky top-20 rounded-card border border-border bg-surface p-5 shadow-card" data-testid="buy-box">
      {options.length > 1 && <TierTabs className="mb-4 w-full" />}
      {selected.tier && mostChosen === selected.tier && (
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-primary">{tv('most_chosen')}</p>
      )}
      <PriceBlock display={selected.display} size="detail" equation />
      <dl className="mt-4 space-y-2 border-t border-border pt-4 text-sm">
        <div className="flex items-center justify-between">
          <dt className="inline-flex items-center gap-1.5 text-foreground-secondary">
            <Clock className="h-4 w-4" /> {t('delivery_time')}
          </dt>
          <dd className="font-medium">{t('delivery_days', { days: selected.deliveryDays })}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="inline-flex items-center gap-1.5 text-foreground-secondary">
            <RefreshCw className="h-4 w-4" /> {t('revisions_label')}
          </dt>
          <dd className="font-medium">{selected.revisionCount}</dd>
        </div>
      </dl>
      {selected.idealFor && (
        <p className="mt-3 text-sm" data-testid="ideal-for">
          <span className="font-semibold">{tv('ideal_for_label')}</span>{' '}
          {selected.idealForOriginal ? <TranslatedText key={selected.packageId} text={selected.idealFor} original={selected.idealForOriginal} lang={locale} /> : selected.idealFor}
        </p>
      )}
      <Link
        href={buyHref(selected.packageId)}
        data-testid="buy-now"
        onClick={() => analytics.capture('buy_now_clicked', { device: 'web', tier: selected.tier, total_bucket: totalBucket(selected.display.totalPaise) })}
        className="mt-5 block w-full rounded-button bg-primary px-4 py-3 text-center font-semibold text-white transition-colors hover:bg-primary/90"
      >
        {t('buy_now')}
      </Link>
      <p className="mt-2 text-center text-xs text-foreground-secondary">{buyNote}</p>
      <div className="mt-3 space-y-1.5 border-t border-border pt-3">
        <RefundLine />
        {selected.govtDependent && <GovtLine />}
      </div>
    </div>
  )
}

/**
 * Below lg the buy box sits after the FAQs, so a sticky bar keeps the price
 * and Buy now in reach. A tier group shows the selected tier's total; a
 * single package keeps today's "₹X + GST" line.
 */
export function StickyBuyBar() {
  const t = useTranslations('catalog')
  const tv = useTranslations('packages_v3')
  const analytics = useAnalytics()
  const { options, selected } = useTierState()
  const tiered = options.length > 1
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface px-4 pt-3 shadow-card lg:hidden"
      style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      data-testid="sticky-buy-bar"
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-lg font-bold leading-none tabular-nums">
            {tiered
              ? tv('total_incl_gst', { total: formatINRExact(selected.display.totalPaise) })
              : t('price_plus_gst', { price: formatINR(selected.display.taxablePaise) })}
          </p>
          <p className="mt-1 truncate text-xs text-foreground-secondary">
            {tiered && selected.tier ? `${tv(`tier_${selected.tier}`)} · ` : ''}
            {t('delivery_days', { days: selected.deliveryDays })}
          </p>
        </div>
        <Link
          href={buyHref(selected.packageId)}
          onClick={() => analytics.capture('buy_now_clicked', { device: 'web', tier: selected.tier, total_bucket: totalBucket(selected.display.totalPaise), surface: 'sticky' })}
          className="shrink-0 rounded-button bg-primary px-5 py-3 text-center font-semibold text-white transition-colors hover:bg-primary/90"
        >
          {t('buy_now')}
        </Link>
      </div>
    </div>
  )
}
