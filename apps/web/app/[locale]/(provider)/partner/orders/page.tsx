import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PackageOpen } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { listMyOrders } from '@/lib/orders/queries'
import { Badge } from '@/components/ui/badge'
import { formatINR } from '@/lib/format'

export default async function PartnerOrdersPage() {
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/orders')
  const t = await getTranslations('orders')
  const orders = await listMyOrders(user.id, 'provider')

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-6 font-display text-2xl font-bold">{t('orders')}</h1>
      {orders.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-gray-300 bg-surface px-6 py-16 text-center">
          <PackageOpen className="h-10 w-10 text-foreground-secondary" />
          <p className="text-sm text-foreground-secondary">{t('provider_empty')}</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {orders.map((o) => (
            <li key={o.id}>
              <Link href={`/partner/orders/${o.id}`} className="flex items-center justify-between rounded-card border border-gray-200 bg-surface p-4 shadow-card hover:border-primary/40">
                <div>
                  <p className="text-xs text-foreground-secondary">{o.order_number}</p>
                  <p className="font-medium">{o.title}</p>
                  <p className="text-sm text-foreground-secondary">{t('you_earn')}: {formatINR(Number(o.provider_earning_paise))}</p>
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
