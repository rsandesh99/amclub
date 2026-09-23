import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Inbox } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { getSessionUser, getProviderProfile } from '@/lib/auth/session'
import { listProviderRfqInbox, PROVIDER_INBOX_TABS, type ProviderInboxTab, type ProviderRfqItem } from '@/lib/rfq/queries'
import { Badge } from '@/components/ui/badge'

function parseTab(v: string | undefined): ProviderInboxTab {
  return (PROVIDER_INBOX_TABS as readonly string[]).includes(v ?? '') ? (v as ProviderInboxTab) : 'open'
}

function hrefFor(tab: ProviderInboxTab, page: number): string {
  return page > 1 ? `/partner/rfqs?tab=${tab}&page=${page}` : `/partner/rfqs?tab=${tab}`
}

const TAB_LABEL = { open: 'inbox_tab_open', quoted: 'inbox_tab_quoted', closed: 'inbox_tab_closed' } as const
const TAB_EMPTY = { open: 'inbox_empty_open', quoted: 'inbox_empty_quoted', closed: 'inbox_empty_closed' } as const

/**
 * Provider RFQ inbox: every matched request, split Open · Quoted · Closed by the
 * derived per-provider outcome (`?tab=` keeps the choice in the URL, `?page=`
 * pages 20 at a time). Closed keeps the history — won (with the order), not
 * selected, declined, withdrawn, expired — so alerts about them land here.
 */
export default async function PartnerRfqsPage({ searchParams }: { searchParams: Promise<{ tab?: string; page?: string }> }) {
  const sp = await searchParams
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/rfqs')
  const profile = await getProviderProfile(user.id)
  if (!profile) redirect('/partner/onboarding')
  const t = await getTranslations('rfq')
  const tab = parseTab(sp.tab)
  const inbox = await listProviderRfqInbox(user.id, { tab, page: Number(sp.page ?? '1') })
  const total = inbox.counts.open + inbox.counts.quoted + inbox.counts.closed

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="font-display text-2xl font-bold">{t('inbox_title')}</h1>
      <p className="mt-1 text-sm text-foreground-secondary">{t('inbox_subtitle')}</p>

      <nav aria-label={t('inbox_tabs_label')} className="mt-5 flex gap-1 overflow-x-auto border-b border-border">
        {PROVIDER_INBOX_TABS.map((k) => {
          const current = k === tab
          return (
            <Link
              key={k}
              href={hrefFor(k, 1)}
              aria-current={current ? 'page' : undefined}
              className={`-mb-px inline-flex min-h-10 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium ${current ? 'border-primary text-primary' : 'border-transparent text-foreground-secondary hover:text-foreground'}`}
            >
              {t(TAB_LABEL[k])}
              <span className="rounded-chip bg-muted px-1.5 text-[11px] tabular-nums">{inbox.counts[k]}</span>
            </Link>
          )
        })}
      </nav>

      {inbox.items.length === 0 ? (
        <div className="mt-6 flex flex-col items-center gap-3 rounded-card border border-dashed border-border bg-surface px-6 py-16 text-center">
          <Inbox className="h-10 w-10 text-foreground-secondary" />
          {total === 0 ? (
            <>
              <p className="text-sm font-medium">{t('no_matched_title')}</p>
              <p className="text-sm text-foreground-secondary">{t('no_matched_body')}</p>
            </>
          ) : (
            <p className="text-sm text-foreground-secondary">{t(TAB_EMPTY[tab])}</p>
          )}
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {inbox.items.map((r) => (
            <li key={r.rfqId}>
              <Link href={`/partner/rfqs/${r.rfqId}`} className="flex items-center justify-between gap-3 rounded-card border border-border bg-surface p-4 shadow-card hover:border-primary/40">
                <div className="min-w-0">
                  <p className="truncate font-medium">{r.title}</p>
                  <p className="text-xs text-foreground-secondary">{t('quotes_n', { n: r.quoteCount, max: r.maxQuotes })}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {r.kind === 'goods' && <Badge variant="default">{t('goods_badge')}</Badge>}
                  {/* S1.3 — my unanswered question on this RFQ (the "new answers" badge is a FOLLOWUP). */}
                  {r.hasUnansweredMine && r.outcome !== 'won' && <Badge variant="warning">{t('clarify_mine_open_chip')}</Badge>}
                  <OutcomeBadge item={r} t={t} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {inbox.pageCount > 1 && (
        <nav aria-label={t('inbox_pagination_label')} className="mt-6 flex items-center justify-between text-sm">
          {inbox.page > 1 ? (
            <Link href={hrefFor(tab, inbox.page - 1)} className="inline-flex min-h-10 items-center font-medium text-primary underline underline-offset-2">{t('inbox_prev')}</Link>
          ) : <span />}
          <span className="text-foreground-secondary">{t('inbox_page', { page: inbox.page, pages: inbox.pageCount })}</span>
          {inbox.page < inbox.pageCount ? (
            <Link href={hrefFor(tab, inbox.page + 1)} className="inline-flex min-h-10 items-center font-medium text-primary underline underline-offset-2">{t('inbox_next')}</Link>
          ) : <span />}
        </nav>
      )}
    </div>
  )
}

function OutcomeBadge({ item, t }: { item: ProviderRfqItem; t: Awaited<ReturnType<typeof getTranslations<'rfq'>>> }) {
  switch (item.outcome) {
    case 'open': return !item.viewed ? <Badge variant="info">{t('new_label')}</Badge> : null
    case 'quoted': return <Badge variant="success">{t('quoted_badge')}</Badge>
    case 'won': return <Badge variant="success">{t('outcome_won')}</Badge>
    case 'lost': return <Badge variant="outline">{t('outcome_lost')}</Badge>
    case 'declined': return <Badge variant="default">{t('declined_badge')}</Badge>
    case 'withdrawn': return <Badge variant="outline">{t('outcome_withdrawn')}</Badge>
    case 'expired': return <Badge variant="outline">{t('outcome_expired')}</Badge>
    case 'closed': return <Badge variant="outline">{t('outcome_closed')}</Badge>
  }
}
