'use client'

import { useEffect, useRef } from 'react'
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

// E12a — the chosen add-on ids ride to checkout, which re-prices them on the server.
const buyHref = (packageId: string, addons: string[] = []) => `/app/checkout/${packageId}${addons.length ? `?addons=${addons.join(',')}` : ''}`

/**
 * E12a / ADR 019 — the add-ons the provider set ("+₹500 · 2 days faster").
 * Ticking one asks the server for the new total; nothing is added here.
 */
export function AddOnList() {
  const tv = useTranslations('packages_v3')
  const { selected, chosen, toggleAddon, quoteBusy, addonNote } = useTierState()
  // E12c — add-ons are not offered on a plan.
  const addons = selected.plan?.length ? [] : (selected.addons ?? [])
  if (addons.length === 0) return null
  return (
    <fieldset className="mt-4 border-t border-border pt-4" data-testid="addon-list">
      <legend className="mb-2 text-sm font-semibold">{tv('addons_title')}</legend>
      <ul className="space-y-2">
        {addons.map((a) => {
          const effect = [
            a.daysDelta < 0 ? tv('addon_faster', { days: -a.daysDelta }) : a.daysDelta > 0 ? tv('addon_slower', { days: a.daysDelta }) : null,
            a.extraRevisions > 0 ? tv('addon_revisions', { count: a.extraRevisions }) : null,
          ].filter(Boolean)
          return (
            <li key={a.id}>
              <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={chosen.includes(a.id)} disabled={quoteBusy} onChange={() => toggleAddon(a.id)} data-addon={a.id} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{a.label}</span>
                  {effect.length > 0 && <span className="block text-xs text-foreground-secondary">{effect.join(' · ')}</span>}
                </span>
                <span className="shrink-0 font-medium tabular-nums">{tv('addon_price', { price: formatINRExact(a.pricePaise) })}</span>
              </label>
            </li>
          )
        })}
      </ul>
      {quoteBusy && <p className="mt-2 text-xs text-foreground-secondary" role="status">{tv('addons_updating')}</p>}
      {addonNote && <p className="mt-2 text-xs text-danger" role="alert">{tv(addonNote === 'changed' ? 'addons_changed' : 'addons_failed')}</p>}
    </fieldset>
  )
}

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
 * E12c / ADR 021 — "Pay once · N milestones": each milestone becomes its own
 * order, due by its day, and is paid out only when it is done. The amounts are
 * the server's exact split (they add up to the total above).
 */
export function PlanSteps() {
  const tv = useTranslations('packages_v3')
  const analytics = useAnalytics()
  const { selected } = useTierState()
  const plan = selected.plan ?? []
  const seen = useRef<string | null>(null)
  useEffect(() => {
    if (!plan.length || seen.current === selected.packageId) return
    seen.current = selected.packageId
    analytics.capture('bundle_viewed', { device: 'web', milestones: plan.length })
  }, [plan.length, selected.packageId, analytics])
  if (plan.length === 0) return null
  return (
    <div className="mt-4 border-t border-border pt-4" data-testid="plan-steps">
      <p className="text-sm font-semibold">{tv('plan_title', { n: plan.length, days: plan[plan.length - 1]!.dueOffsetDays })}</p>
      <ol className="mt-2 space-y-1.5 text-sm">
        {plan.map((s, i) => (
          <li key={i} className="flex items-baseline justify-between gap-3">
            <span className="min-w-0"><span className="text-foreground-secondary tabular-nums">{i + 1}.</span> {s.label} <span className="text-xs text-foreground-secondary">· {tv('plan_by_day', { day: s.dueOffsetDays })}</span></span>
            <span className="shrink-0 tabular-nums">{formatINRExact(s.totalPaise)}</span>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-foreground-secondary">{tv('plan_escrow_note')}</p>
    </div>
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
  const { options, selected, mostChosen, chosen, quote, quoteBusy } = useTierState()
  const locale = useLocale()
  // With add-ons chosen every figure is the server quote; without, the option's own display.
  const display = quote?.display ?? selected.display
  const days = quote?.deliveryDays ?? selected.deliveryDays
  const revisions = quote?.revisionMax ?? selected.revisionCount

  return (
    <div className="sticky top-20 rounded-card border border-border bg-surface p-5 shadow-card" data-testid="buy-box">
      {options.length > 1 && <TierTabs className="mb-4 w-full" />}
      {selected.tier && mostChosen === selected.tier && (
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-primary">{tv('most_chosen')}</p>
      )}
      <PriceBlock display={display} size="detail" equation />
      <dl className="mt-4 space-y-2 border-t border-border pt-4 text-sm">
        <div className="flex items-center justify-between">
          <dt className="inline-flex items-center gap-1.5 text-foreground-secondary">
            <Clock className="h-4 w-4" /> {t('delivery_time')}
          </dt>
          <dd className="font-medium">{t('delivery_days', { days })}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="inline-flex items-center gap-1.5 text-foreground-secondary">
            <RefreshCw className="h-4 w-4" /> {t('revisions_label')}
          </dt>
          <dd className="font-medium">{revisions}</dd>
        </div>
      </dl>
      {selected.idealFor && (
        <p className="mt-3 text-sm" data-testid="ideal-for">
          <span className="font-semibold">{tv('ideal_for_label')}</span>{' '}
          {selected.idealForOriginal ? <TranslatedText key={selected.packageId} text={selected.idealFor} original={selected.idealForOriginal} lang={locale} /> : selected.idealFor}
        </p>
      )}
      <PlanSteps />
      <AddOnList />
      <Link
        href={buyHref(selected.packageId, quote ? chosen : [])}
        data-testid="buy-now"
        aria-disabled={quoteBusy || undefined}
        onClick={(e) => {
          if (quoteBusy) return e.preventDefault()
          analytics.capture('buy_now_clicked', { device: 'web', tier: selected.tier, total_bucket: totalBucket(display.totalPaise), ...(chosen.length ? { addons: chosen.length } : {}) })
        }}
        className={cn('mt-5 block w-full rounded-button bg-primary px-4 py-3 text-center font-semibold text-white transition-colors hover:bg-primary/90', quoteBusy && 'pointer-events-none opacity-60')}
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
  const { options, selected, chosen, quote, quoteBusy } = useTierState()
  const tiered = options.length > 1
  const display = quote?.display ?? selected.display
  const days = quote?.deliveryDays ?? selected.deliveryDays
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface px-4 pt-3 shadow-card lg:hidden"
      style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      data-testid="sticky-buy-bar"
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-lg font-bold leading-none tabular-nums">
            {tiered || quote
              ? tv('total_incl_gst', { total: formatINRExact(display.totalPaise) })
              : t('price_plus_gst', { price: formatINR(display.taxablePaise) })}
          </p>
          <p className="mt-1 truncate text-xs text-foreground-secondary">
            {tiered && selected.tier ? `${tv(`tier_${selected.tier}`)} · ` : ''}
            {t('delivery_days', { days })}
          </p>
        </div>
        <Link
          href={buyHref(selected.packageId, quote ? chosen : [])}
          aria-disabled={quoteBusy || undefined}
          onClick={(e) => {
            if (quoteBusy) return e.preventDefault()
            analytics.capture('buy_now_clicked', { device: 'web', tier: selected.tier, total_bucket: totalBucket(display.totalPaise), surface: 'sticky', ...(chosen.length ? { addons: chosen.length } : {}) })
          }}
          className={cn('shrink-0 rounded-button bg-primary px-5 py-3 text-center font-semibold text-white transition-colors hover:bg-primary/90', quoteBusy && 'pointer-events-none opacity-60')}
        >
          {t('buy_now')}
        </Link>
      </div>
    </div>
  )
}
