import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PackageOpen } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { listMyOrders } from '@/lib/orders/queries'
import { Badge } from '@/components/ui/badge'
import { ProcessingBanner } from '@/components/orders/ProcessingBanner'
import { formatINR } from '@/lib/format'

export default async function MsmeOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ processing?: string }>
}) {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/orders')
  const t = await getTranslations('orders')
  const orders = await listMyOrders(user.id, 'msme')
  const { processing } = await searchParams

  const tInvoices = await getTranslations('invoices')

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      {/* Post-payment handoff: the webhook creates the order, so it may not be
          in `orders` yet — the banner polls until it appears (B1). */}
      {processing === '1' && <ProcessingBanner initialCount={orders.length} />}
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-bold">{t('my_orders')}</h1>
        <Link href="/app/invoices" className="text-sm font-medium text-primary hover:underline">
          {tInvoices('view_all')}
        </Link>
      </div>
      {orders.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border bg-surface px-6 py-16 text-center">
          <PackageOpen className="h-10 w-10 text-foreground-secondary" />
          <p className="text-sm text-foreground-secondary">{t('empty')}</p>
          <Link href="/services" className="mt-2 rounded-button bg-primary px-4 py-2.5 text-sm font-semibold text-white">{t('explore')}</Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {orders.map((o) => (
            <li key={o.id}>
              <Link href={`/app/orders/${o.id}`} className="flex items-center justify-between rounded-card border border-border bg-surface p-4 shadow-card hover:border-primary/40">
                <div>
                  <p className="text-xs text-foreground-secondary">{o.order_number}</p>
                  <p className="font-medium">{o.title}</p>
                  <p className="text-sm text-foreground-secondary">{formatINR(Number(o.total_paise))}</p>
                </div>
                <Badge>{t(`status_${o.status}` as 'status_placed')}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
