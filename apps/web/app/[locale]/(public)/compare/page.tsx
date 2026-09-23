import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'
import { formatStatPct, gstPercent } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { isOnForEveryone } from '@/lib/experiments'
import { formatINR, formatINRExact, pickI18n } from '@/lib/format'
import { getCompareColumns, parseCompareItems, type CompareColumn } from '@/lib/catalog/compare'
import { CompareOpened } from '@/components/compare-v3/CompareOpened'
import { EmptyState } from '@/components/ui-v3/Feedback'

export const metadata: Metadata = { robots: { index: false, follow: false } }

/**
 * Experience v3 E2 FR-2.9 (N34) — shortlist compare, pre-RFQ only (no quotes,
 * no chat). Rows grouped Price · Time · Trust · Terms · Actions; every column
 * has the same rows.
 */
export default async function ComparePage({ searchParams }: { searchParams: Promise<{ items?: string }> }) {
  // Read the request first so the page is always rendered per request.
  const sp = await searchParams
  if (!isOnForEveryone('search')) notFound()
  const t = await getTranslations('compare_v3')
  const tc = await getTranslations('catalog')
  const tp = await getTranslations('packages_v3')
  const locale = await getLocale()
  const cols = await getCompareColumns(parseCompareItems(sp.items), { withTrust: isOnForEveryone('trust') })

  if (cols.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <EmptyState title={t('empty_title')} body={t('empty_body')} action={<Link href="/services" className="font-semibold text-primary">{t('browse')}</Link>} />
      </div>
    )
  }

  const verified = (c: CompareColumn) =>
    c.trust && c.trust.verification.length > 0 ? c.trust.verification.map((v) => tc(`badge_${v.kind}` as 'badge_gstin')).join(' · ') : '—'
  const onTime = (c: CompareColumn) => (c.trust?.stats?.onTime ? tc('stat_on_time_short', { pct: formatStatPct(c.trust.stats.onTime.pct), n: c.trust.stats.onTime.n }) : '—')
  const groups: { title: string; rows: { label: string; cell: (c: CompareColumn) => React.ReactNode }[] }[] = [
    {
      title: t('group_price'),
      rows: [
        { label: t('row_price'), cell: (c) => <span className="font-semibold tabular-nums">{tc('price_plus_gst', { price: formatINR(c.display.taxablePaise) })}</span> },
        { label: t('row_total'), cell: (c) => <span className="tabular-nums">{tc('price_equation', { price: formatINRExact(c.display.taxablePaise), pct: gstPercent(c.display.gstBps), total: formatINRExact(c.display.totalPaise) })}</span> },
        { label: t('row_tier'), cell: (c) => (c.tier ? tp(`tier_${c.tier}`) : '—') },
      ],
    },
    { title: t('group_time'), rows: [{ label: t('row_delivery'), cell: (c) => tc('delivery_days', { days: c.deliveryDays }) }] },
    {
      title: t('group_trust'),
      rows: [
        { label: t('row_verification'), cell: verified },
        { label: t('row_on_time'), cell: onTime },
        { label: t('row_rating'), cell: (c) => (c.reviewCount > 0 ? `★ ${c.avgRating.toFixed(1)} (${c.reviewCount})` : tc('new')) },
        { label: t('row_orders'), cell: (c) => c.completedOrders },
      ],
    },
    {
      title: t('group_terms'),
      rows: [
        { label: t('row_revisions'), cell: (c) => c.revisionCount },
        { label: t('row_refund'), cell: () => tp('refund_line') },
      ],
    },
  ]

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8">
      <CompareOpened n={cols.length} />
      <h1 className="t-title-1">{t('title')}</h1>
      <p className="mt-1 text-sm text-foreground-secondary">{t('subtitle')}</p>
      <div className="-mx-4 mt-6 overflow-x-auto px-4">
        <table className="w-full min-w-[40rem] border-separate border-spacing-0 text-sm" data-testid="compare-table">
          <thead>
            <tr>
              <th scope="col" className="sticky left-0 z-10 w-40 bg-background" />
              {cols.map((c) => (
                <th key={c.packageId} scope="col" className="min-w-[11rem] border-b border-separator px-3 pb-3 text-left align-bottom font-normal">
                  <Link href={`/p/${c.providerSlug}/${c.packageSlug}`} className="block font-semibold text-foreground hover:text-primary">{pickI18n(c.titleI18n, locale)}</Link>
                  <Link href={`/p/${c.providerSlug}`} className="text-foreground-secondary hover:text-primary">{c.providerName}</Link>
                </th>
              ))}
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.title}>
              <tr>
                <th colSpan={cols.length + 1} scope="colgroup" className="sticky left-0 bg-background px-0 pb-1 pt-5 text-left text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{g.title}</th>
              </tr>
              {g.rows.map((r) => (
                <tr key={r.label} data-row={r.label}>
                  <th scope="row" className="sticky left-0 z-10 border-b border-separator bg-background py-2.5 pr-3 text-left font-normal text-foreground-secondary">{r.label}</th>
                  {cols.map((c) => (
                    <td key={c.packageId} className="border-b border-separator px-3 py-2.5 align-top">{r.cell(c)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
          <tbody>
            <tr>
              <th scope="row" className="sticky left-0 z-10 bg-background pt-4 text-left text-xs font-semibold uppercase tracking-wide text-foreground-secondary">{t('group_actions')}</th>
              {cols.map((c) => (
                <td key={c.packageId} className="px-3 pt-4 align-top">
                  <div className="flex flex-col gap-2">
                    <Link href={`/app/checkout/${c.packageId}`} className="rounded-button bg-primary px-3 py-2 text-center text-sm font-semibold text-white hover:bg-primary/90">{tc('buy_now')}</Link>
                    <Link href={`/p/${c.providerSlug}/${c.packageSlug}`} className="rounded-button border border-border px-3 py-2 text-center text-sm font-medium">{t('view')}</Link>
                    <Link href={`/app/rfq/new?category=${c.categorySlug}` as '/app/rfq/new'} className="text-center text-sm font-medium text-primary hover:underline">{t('post_requirement')}</Link>
                  </div>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
