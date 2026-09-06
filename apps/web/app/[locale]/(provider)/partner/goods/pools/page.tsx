import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { martPageGate } from '@/lib/mart/gate'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { getSellerCtx } from '@/lib/mart/seller'
import { listPools, listMembers, poolProgressFor } from '@/lib/mart/pools'
import { PoolCard } from '@/components/mart/PoolCard'
import { SheetCard } from '@/components/mart/primitives'

export const dynamic = 'force-dynamic'

/** Seller view: pools AMC runs on my listings, with allocations once a pool is on. */
export default async function PartnerPoolsPage() {
  martPageGate()
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/partner/goods/pools')
  const [t, admin] = await Promise.all([getTranslations('mart'), createAdminClient()])
  const seller = await getSellerCtx(admin, user.id)
  if (!seller) redirect('/partner/onboarding')
  const all = await listPools(admin, { statuses: ['open', 'closed_met', 'closed_unmet', 'ordered', 'fulfilled'], limit: 200 })
  const mine = all.filter((p) => p.seller_id === seller.id)
  const withAlloc = []
  for (const p of mine) {
    const alloc = ['closed_met', 'ordered', 'fulfilled'].includes(p.status) ? (await listMembers(admin, p.id)).filter((m) => m.payment_state === 'blocked' || m.payment_state === 'captured') : []
    withAlloc.push({ p, alloc })
  }
  return (
    <div className="mart-enter mx-auto max-w-3xl space-y-5 px-4 py-8">
      <div>
        <Link href={'/partner/goods' as '/partner'} className="text-meta text-foreground-secondary hover:underline">← {t('seller_title')}</Link>
        <h1 className="mt-1 font-display text-2xl font-bold text-emerald-ink">{t('seller_pools_title')}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('seller_pools_subtitle')}</p>
      </div>
      {withAlloc.length === 0 ? (
        <SheetCard className="jaali-ivory py-12 text-center"><p className="text-body text-emerald-ink">{t('seller_pools_empty')}</p></SheetCard>
      ) : (
        <ul className="space-y-4">
          {withAlloc.map(({ p, alloc }) => (
            <li key={p.id} className="space-y-2">
              <PoolCard pool={p} progress={poolProgressFor(p)} />
              {alloc.length > 0 && (
                <SheetCard>
                  <h2 className="text-meta font-semibold text-emerald-ink">{t('allocation_title')}</h2>
                  <ul className="mt-2 divide-y divide-brass/20 text-meta">
                    {alloc.map((m) => {
                      const d = m.delivery_snapshot as { city?: string; pickup?: boolean }
                      return (
                        <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                          <span className="text-emerald-ink">{t('allocation_row', { qty: m.qty, unit: p.unit, city: d.city ?? '' })}{d.pickup ? ` · ${t('allocation_pickup')}` : ''}</span>
                          {m.payment_state === 'captured' && m.order_id ? (
                            <Link href={`/partner/orders/${m.order_id}` as '/partner'} className="font-medium text-emerald underline underline-offset-2">{t('allocation_paid')} →</Link>
                          ) : (
                            <span className="text-foreground-secondary">{t('allocation_pending')}</span>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </SheetCard>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
