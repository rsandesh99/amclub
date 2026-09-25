import { getLocale, getTranslations } from 'next-intl/server'
import { CATEGORY_LIST, inboxQueryToString, INDIAN_STATES, type InboxQuery } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { formatINR } from '@/lib/format'
import { istDay, istDeadline } from '@/lib/dates'
import { listProviderInboxV3, type InboxRowV3 } from '@/lib/partner-v3'
import { DataTable } from '@/components/ui-v3/DataTable'
import { InboxFiltersV3 } from './InboxFiltersV3'

const TABS = ['open', 'quoted', 'closed'] as const

/**
 * E11 FR-11.2 (N28) — inbox v2: tabs with (filtered) counts, filters / sort /
 * search from the URL, a Compact table on desktop and cards on phones with
 * the same facts. "Buyer verified ✓" is a boolean (D2, dark).
 */
export async function InboxV3({ userId, query }: { userId: string; query: InboxQuery }) {
  const [t, tRfq, locale] = await Promise.all([getTranslations('partner_v3'), getTranslations('rfq'), getLocale()])
  const inbox = await listProviderInboxV3(userId, query)
  const filtered = !!(query.q || query.category || query.state || query.budget || query.closing || query.verified || query.files)
  const total = inbox.counts.open + inbox.counts.quoted + inbox.counts.closed
  const pickName = (m: { en: string; hi?: string }) => (locale === 'hi' && m.hi ? m.hi : m.en)
  const catName = (slug: string | null) => (slug ? pickName(CATEGORY_LIST.find((c) => c.slug === slug)?.name_i18n ?? { en: slug }) : '—')
  const budget = (r: InboxRowV3) => (r.budgetMinPaise == null && r.budgetMaxPaise == null ? '—' : `${r.budgetMinPaise != null ? formatINR(r.budgetMinPaise) : ''}–${r.budgetMaxPaise != null ? formatINR(r.budgetMaxPaise) : ''}`)
  const closes = (r: InboxRowV3) => (Date.parse(r.expiresAt) > Date.now() ? istDeadline(r.expiresAt, locale) : '—')
  const href = (r: InboxRowV3) => `/partner/rfqs/${r.rfqId}`
  const tabHref = (tab: (typeof TABS)[number]) => { const qs = inboxQueryToString({ ...query, tab, page: 1 }); return (qs ? `/partner/rfqs?${qs}` : '/partner/rfqs') as '/partner/rfqs' }
  const pageHref = (page: number) => { const qs = inboxQueryToString({ ...query, page }); return (qs ? `/partner/rfqs?${qs}` : '/partner/rfqs') as '/partner/rfqs' }

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-6" data-testid="inbox-v3" data-count={inbox.items.length}>
      <h1 className="t-large-title">{tRfq('inbox_title')}</h1>
      <nav aria-label={tRfq('inbox_tabs_label')} className="flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((k) => (
          <Link key={k} href={tabHref(k)} aria-current={k === query.tab ? 'page' : undefined} className={`-mb-px inline-flex min-h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium ${k === query.tab ? 'border-primary text-primary' : 'border-transparent text-foreground-secondary hover:text-foreground'}`}>
            {tRfq(`inbox_tab_${k}`)} <span className="rounded-chip bg-muted px-1.5 text-[11px] tabular-nums" data-tab-count={k}>{inbox.counts[k]}</span>
          </Link>
        ))}
      </nav>
      <InboxFiltersV3
        query={query}
        badgeOn={inbox.badgeOn}
        categories={CATEGORY_LIST.map((c) => ({ value: c.slug, label: pickName(c.name_i18n) }))}
        states={INDIAN_STATES.map((s) => ({ value: s.value, label: s.label }))}
      />
      {inbox.items.length === 0 ? (
        // QA F19 — "match these filters" only when a filter is set; otherwise say why the inbox is empty.
        <div className="rounded-card border border-dashed border-border px-4 py-10 text-center text-sm text-foreground-secondary" data-testid="inbox-empty">
          {filtered ? (
            <p>{t('inbox_empty')}</p>
          ) : total === 0 ? (
            <>
              <p className="font-medium text-foreground">{tRfq('no_matched_title')}</p>
              <p className="mt-1">{tRfq('no_matched_body')}</p>
            </>
          ) : (
            <p>{tRfq(`inbox_empty_${query.tab}`)}</p>
          )}
        </div>
      ) : (
        <>
          <div className="hidden md:block" data-density="compact">
            <DataTable<InboxRowV3>
              caption={tRfq('inbox_title')}
              rows={inbox.items}
              rowKey={(r) => r.rfqId}
              columns={[
                { key: 'title', header: t('col_requirement'), render: (r) => <Link href={href(r)} className="font-medium hover:text-primary" data-rfq={r.rfqId}>{r.title}</Link> },
                { key: 'cat', header: t('col_category_state'), render: (r) => `${catName(r.categorySlug)} · ${r.buyerState ?? '—'}` },
                { key: 'budget', header: t('col_budget'), align: 'right', render: budget },
                { key: 'needed', header: t('col_needed_by'), render: (r) => (r.neededBy ? istDay(`${r.neededBy}T00:00:00+05:30`, locale) : '—') },
                { key: 'quotes', header: t('col_quotes'), align: 'right', render: (r) => `${r.quoteCount} / ${r.maxQuotes}` },
                { key: 'closes', header: t('col_closes'), render: closes },
                { key: 'verified', header: <span aria-label={t('f_verified')}>✓</span>, render: (r) => (r.buyerVerified ? <span className="text-success" data-verified="1" aria-label={t('f_verified')}>✓</span> : null) },
              ]}
            />
          </div>
          <ul className="space-y-2 md:hidden">
            {inbox.items.map((r) => (
              <li key={r.rfqId}>
                <Link href={href(r)} className="block rounded-card border border-border bg-surface p-3 shadow-xs">
                  <p className="font-medium">{r.title}{r.buyerVerified ? <span className="ml-2 text-success" aria-label={t('f_verified')}>✓</span> : null}</p>
                  <p className="t-footnote text-foreground-secondary">{catName(r.categorySlug)} · {r.buyerState ?? '—'} · {budget(r)}</p>
                  <p className="t-footnote text-foreground-secondary">{tRfq('quotes_n', { n: r.quoteCount, max: r.maxQuotes })} · {closes(r)}</p>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
      {inbox.pageCount > 1 && (
        <nav aria-label={tRfq('inbox_pagination_label')} className="flex items-center justify-between text-sm">
          {inbox.page > 1 ? <Link href={pageHref(inbox.page - 1)} className="font-medium text-primary">{tRfq('inbox_prev')}</Link> : <span />}
          <span className="text-foreground-secondary">{tRfq('inbox_page', { page: inbox.page, pages: inbox.pageCount })}</span>
          {inbox.page < inbox.pageCount ? <Link href={pageHref(inbox.page + 1)} className="font-medium text-primary">{tRfq('inbox_next')}</Link> : <span />}
        </nav>
      )}
    </div>
  )
}
