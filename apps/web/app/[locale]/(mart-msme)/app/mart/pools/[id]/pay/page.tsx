import { redirect, notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { martPageGate } from '@/lib/mart/gate'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { getPool } from '@/lib/mart/pools'
import { PoolPayClient } from './PoolPayClient'

export const dynamic = 'force-dynamic'

/** Pay-on-close: the member's goods order at the pool price. */
export default async function PoolPayPage({ params }: { params: Promise<{ id: string }> }) {
  martPageGate()
  const { id } = await params
  const user = await getSessionUser()
  if (!user) redirect(`/login?next=/app/mart/pools/${id}/pay`)
  const [t, pool] = await Promise.all([getTranslations('mart'), getPool(await createAdminClient(), id)])
  if (!pool || pool.status === 'draft') notFound()
  return (
    <div className="mart-enter mx-auto max-w-2xl px-4 py-8">
      <h1 className="font-display text-2xl font-bold text-emerald-ink">{t('pool_pay_title')}</h1>
      <p className="mt-1 text-body text-foreground-secondary">{t('pool_pay_sub')}</p>
      <div className="mt-5">
        <PoolPayClient poolId={pool.id} title={pool.title} unit={pool.unit} />
      </div>
    </div>
  )
}
