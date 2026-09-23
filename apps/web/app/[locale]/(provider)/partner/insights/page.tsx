import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { getSessionUser, getProviderProfile } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { isOnFor } from '@/lib/experiments'
import { getPartnerInsights } from '@/lib/partner-v3/insights'
import { istDay } from '@/lib/dates'
import { DataTable } from '@/components/ui-v3/DataTable'
import { InsightsViewed } from '@/components/partner-v3/InsightsViewed'

const KNOWN_DECLINE = ['price_high', 'delivery_slow', 'details_unclear', 'terms_unacceptable', 'chose_other'] as const

/**
 * E11 FR-11.5 (N29 / N22) — /partner/insights: the weekly funnel (static
 * bars), why you lost (deltas only, n ≥ 5), decline reasons (n ≥ 3) and
 * listing performance. Never another provider's name or price; never the
 * composite AMC Score. Flag `partner`.
 */
export default async function PartnerInsightsPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/insights')
  if (!isOnFor('partner', user.id)) redirect('/partner')
  const profile = await getProviderProfile(user.id)
  if (!profile) redirect('/partner/onboarding')
  const range = (await searchParams).range === '30d' ? '30d' : '7d'
  const [t, locale] = await Promise.all([getTranslations('partner_v3'), getLocale()])
  const ins = await getPartnerInsights(await createAdminClient(), profile.id, range)
  const max = Math.max(1, ...ins.weeks.map((w) => w.matched))

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-6" data-testid="partner-insights">
      <InsightsViewed range={range} />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="t-large-title">{t('insights_title')}</h1>
        <Link href={range === '30d' ? '/partner/insights' : '/partner/insights?range=30d'} className="t-footnote text-primary">{range === '30d' ? t('show_7') : t('show_30')}</Link>
      </div>

      <section className="rounded-card border border-border bg-surface p-4" aria-labelledby="weekly-h">
        <h2 id="weekly-h" className="t-headline mb-3">{t('weekly')}</h2>
        <ol className="flex items-end gap-2" data-testid="weekly-bars">
          {ins.weeks.map((w) => (
            <li key={w.week} className="flex flex-1 flex-col items-center gap-1" data-week={w.week} data-counts={`${w.views}/${w.matched}/${w.quoted}/${w.won}`}>
              <div className="flex h-24 w-full items-end gap-0.5" aria-hidden>
                <span className="flex-1 rounded-t bg-foreground/15" style={{ height: `${(w.matched / max) * 100}%` }} />
                <span className="flex-1 rounded-t bg-primary/50" style={{ height: `${(w.quoted / max) * 100}%` }} />
                <span className="flex-1 rounded-t bg-primary" style={{ height: `${(w.won / max) * 100}%` }} />
              </div>
              <span className="t-caption text-foreground-secondary">{istDay(`${w.week}T00:00:00+05:30`, locale).replace(/^\S+\s/, '')}</span>
              <span className="sr-only">{t('funnel_line', { views: w.views, matched: w.matched, quoted: w.quoted, won: w.won })}</span>
            </li>
          ))}
        </ol>
        <p className="t-caption mt-2 text-foreground-secondary">{t('legend')}</p>
      </section>

      <section className="rounded-card border border-border bg-surface p-4" aria-labelledby="lost-h" data-testid="why-lost">
        <h2 id="lost-h" className="t-headline mb-2">{t('why_lost')}</h2>
        {ins.loss.price.of === 0 ? (
          <p className="text-sm text-foreground-secondary">{t('no_losses')}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            <li data-lost-price={ins.loss.price.medianPct ?? ''}>{ins.loss.price.medianPct != null ? t('lost_price', { n: ins.loss.price.n, of: ins.loss.price.of, pct: ins.loss.price.medianPct }) : t('lost_price_count', { n: ins.loss.price.n, of: ins.loss.price.of })}</li>
            <li data-lost-delivery={ins.loss.delivery.medianDays ?? ''}>{ins.loss.delivery.medianDays != null ? t('lost_delivery', { n: ins.loss.delivery.n, of: ins.loss.delivery.of, days: ins.loss.delivery.medianDays }) : t('lost_delivery_count', { n: ins.loss.delivery.n, of: ins.loss.delivery.of })}</li>
          </ul>
        )}
        <p className="t-caption mt-2 text-foreground-secondary">{t('privacy_note')}</p>
        {ins.declineReasons.length > 0 && (
          <p className="t-footnote mt-2" data-testid="decline-reasons">{t('lost_on')} {ins.declineReasons.map((d) => `${t(`reason_${(KNOWN_DECLINE as readonly string[]).includes(d.reason) ? d.reason : 'other'}` as 'reason_other')} ${d.n}`).join(' · ')}</p>
        )}
      </section>

      <section aria-labelledby="listings-h" data-testid="listing-performance">
        <h2 id="listings-h" className="t-headline mb-2">{t('listings')}</h2>
        <DataTable
          caption={t('listings')}
          rows={ins.listings}
          rowKey={(r) => r.packageId}
          empty={<p className="px-4 py-6 text-sm text-foreground-secondary">{t('no_listings')}</p>}
          columns={[
            { key: 'title', header: t('col_listing'), render: (r) => r.title },
            { key: 'views', header: t('col_views'), align: 'right', render: (r) => <span data-views={r.views}>{r.views}</span> },
            { key: 'co', header: t('col_checkouts'), align: 'right', render: (r) => r.checkouts },
            { key: 'orders', header: t('col_orders'), align: 'right', render: (r) => r.orders },
          ]}
        />
      </section>
    </div>
  )
}
