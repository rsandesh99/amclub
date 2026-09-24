import { getTranslations } from 'next-intl/server'
import { ORDER_DONE_STATUSES, ORDER_IN_FLIGHT_STATUSES, RFQ_LIVE_STATUSES, type OrderStatus, type RfqStatus } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { formatINR } from '@/lib/format'

/**
 * E18 — the buyer's numbers at a glance (home rail, flag `guide`): live
 * requirements and the quotes on them, orders in flight and the money held for
 * them (released only when the buyer accepts the work), and orders completed.
 * Every figure is summed here on the server from rows the home already reads.
 */
export async function HomeSnapshot({
  orders,
  rfqs,
}: {
  orders: { status: string; total_paise: number | string | null }[]
  rfqs: { status: string; quoteCount: number }[]
}) {
  const t = await getTranslations('home_snapshot')
  const live = rfqs.filter((r) => RFQ_LIVE_STATUSES.includes(r.status as RfqStatus))
  const quotes = live.reduce((n, r) => n + (r.quoteCount ?? 0), 0)
  const inFlight = orders.filter((o) => ORDER_IN_FLIGHT_STATUSES.includes(o.status as OrderStatus))
  const heldPaise = inFlight.reduce((n, o) => n + Number(o.total_paise ?? 0), 0)
  const done = orders.filter((o) => ORDER_DONE_STATUSES.includes(o.status as OrderStatus)).length

  const tiles = [
    { key: 'requirements', href: '/app/rfq', value: String(live.length), sub: t('requirements_sub', { quotes }) },
    { key: 'in_progress', href: '/app/orders', value: String(inFlight.length), sub: t('in_progress_sub') },
    { key: 'held', href: '/app/orders', value: formatINR(heldPaise), sub: t('held_sub') },
    { key: 'completed', href: '/app/orders', value: String(done), sub: t('completed_sub') },
  ] as const

  return (
    <section aria-labelledby="home-snapshot" className="rounded-card border border-border bg-surface p-4 shadow-card" data-testid="home-snapshot">
      <h2 id="home-snapshot" className="t-headline text-foreground">{t('title')}</h2>
      <ul className="mt-3 grid grid-cols-2 gap-2">
        {tiles.map((tile) => (
          <li key={tile.key}>
            <Link href={tile.href} className="block h-full rounded-button bg-foreground/[0.03] p-3 hover:bg-primary/5" data-testid={`snapshot-${tile.key}`} data-value={tile.value}>
              <span className="t-footnote block text-foreground-secondary">{t(`${tile.key}_label`)}</span>
              <span className="t-title-3 mt-0.5 block text-numeric text-foreground">{tile.value}</span>
              <span className="t-caption block text-foreground-secondary">{tile.sub}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
