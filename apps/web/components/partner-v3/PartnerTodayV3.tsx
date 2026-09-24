import { getLocale, getTranslations } from 'next-intl/server'
import { isOnFor } from '@/lib/experiments'
import { MART_ENABLED } from '@/lib/flags'
import { WhyAmclub } from '@/components/usp/WhyAmclub'
import { HOME_ACTION_MAX, type FunnelRange } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import { getMyActions } from '@/lib/me/actions'
import { getPayoutsPanel, getProviderFunnel } from '@/lib/partner-v3'
import { formatINR } from '@/lib/format'
import { istDay } from '@/lib/dates'
import { ActionList } from '@/components/ui-v3/ActionList'
import { GroupedSection, GroupedRow } from '@/components/ui-v3/GroupedList'
import { PartnerHomeViewed } from './PartnerHomeViewed'

const KNOWN_DECLINE = ['price_high', 'delivery_slow', 'details_unclear', 'terms_unacceptable', 'chose_other'] as const
const KNOWN_HOLD = ['approval_gate', 'dispute_open', 'provider_suspended', 'bank_unverified'] as const

/**
 * PRD Experience v3 E11 FR-11.1 — "Today", the provider home (flag
 * `partner`): what needs my action (N2 provider kinds, one tap each), my
 * funnel for the last 7 / 30 days (views → matched → quoted → won, decline
 * reasons only with n ≥ 3), payouts (scheduled / on hold / paid 30 days,
 * read from the ledger) and the next-available date (display only).
 */
export async function PartnerTodayV3({ userId, providerId, range, banners }: { userId: string; providerId: string; range: FunnelRange; banners: React.ReactNode }) {
  const [t, locale] = await Promise.all([getTranslations('partner_v3'), getLocale()])
  const admin = await createAdminClient()
  const [actions, funnel, payouts, { data: prof }] = await Promise.all([
    getMyActions(userId),
    getProviderFunnel(admin, providerId, range),
    getPayoutsPanel(admin, providerId),
    admin.from('provider_profiles').select('next_available_on').eq('id', providerId).maybeSingle(),
  ])
  const items = actions.provider?.items ?? []
  const nextAvailable = (prof?.next_available_on as string | null) ?? null

  // E18 (flag `guide`): "Why AMClub" as a right rail, opening on the providers tab.
  const guide = isOnFor('guide', userId)
  return (
    <div className={guide ? 'mx-auto max-w-6xl px-4 py-6 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-8' : 'mx-auto max-w-3xl px-4 py-6'}>
    <div className="min-w-0 space-y-6" data-testid="partner-today">
      <PartnerHomeViewed actions={items.length} />
      {banners}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="t-large-title">{t('today')}</h1>
        <Link href="/partner/profile" className="t-footnote text-foreground-secondary" data-testid="next-available">
          {nextAvailable ? t('next_available', { date: istDay(`${nextAvailable}T00:00:00+05:30`, locale) }) : t('next_available_unset')} · <span className="text-primary">{t('edit')}</span>
        </Link>
      </div>

      <div data-testid="partner-actions" data-count={items.length}>
        {items.length > 0 ? (
          <ActionList items={items} max={HOME_ACTION_MAX} seeAllHref="/partner/actions" trackEvent="partner_action_clicked" />
        ) : (
          <p className="rounded-card border border-dashed border-border px-4 py-6 text-center text-sm text-foreground-secondary">{t('nothing_due')}</p>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-card border border-border bg-surface p-4 shadow-xs" data-testid="partner-funnel" aria-labelledby="funnel-h">
          <div className="mb-2 flex items-center justify-between">
            <h2 id="funnel-h" className="t-footnote font-medium text-foreground-secondary">{range === '30d' ? t('last_30') : t('last_7')}</h2>
            <Link href={range === '30d' ? '/partner' : '/partner?range=30d'} className="t-footnote text-primary">{range === '30d' ? t('show_7') : t('show_30')}</Link>
          </div>
          <p className="text-sm tabular-nums" data-funnel={`${funnel.views}/${funnel.matched}/${funnel.quoted}/${funnel.won}`}>
            {t('funnel_line', { views: funnel.views, matched: funnel.matched, quoted: funnel.quoted, won: funnel.won })}
          </p>
          {(funnel.quoteRate !== null || funnel.winRate !== null) && (
            <p className="t-footnote mt-1 text-foreground-secondary">{t('funnel_rates', { quote: funnel.quoteRate ?? 0, win: funnel.winRate ?? 0 })}</p>
          )}
          {funnel.declineReasons.length > 0 && (
            <p className="t-footnote mt-1 text-foreground-secondary">{t('lost_on')} {funnel.declineReasons.map((d) => `${t(`reason_${(KNOWN_DECLINE as readonly string[]).includes(d.reason) ? d.reason : 'other'}` as 'reason_other')} ${d.n}`).join(' · ')}</p>
          )}
          <Link href="/partner/insights" className="t-footnote mt-2 inline-block font-medium text-primary">{t('insights')}</Link>
        </section>

        <div data-testid="partner-payouts">
          <GroupedSection header={t('payouts')} action={<Link href="/partner/earnings" className="t-footnote font-medium text-primary">{t('earnings')}</Link>}>
            <GroupedRow title={t('scheduled')} subtitle={payouts.scheduled.next ? istDay(`${payouts.scheduled.next}T00:00:00+05:30`, locale) : undefined} value={formatINR(payouts.scheduled.paise)} />
            <GroupedRow title={t('on_hold')} subtitle={payouts.held.reasons.length ? payouts.held.reasons.map((r) => t(`hold_${(KNOWN_HOLD as readonly string[]).includes(r) ? r : 'other'}` as 'hold_other')).join(' · ') : undefined} value={formatINR(payouts.held.paise)} tone={payouts.held.n > 0 ? 'critical' : 'default'} />
            <GroupedRow title={t('paid_30')} value={formatINR(payouts.paid30.paise)} />
          </GroupedSection>
        </div>
      </div>
    </div>
    {guide && (
      <aside className="mt-8 lg:sticky lg:top-20 lg:mt-0" aria-label={t('why_label')} data-testid="partner-rail">
        <WhyAmclub surface="home" martEnabled={MART_ENABLED} defaultTab="providers" />
      </aside>
    )}
    </div>
  )
}
