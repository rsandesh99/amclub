import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { poolDisciplineFactor } from '@amclub/shared'
import { Link } from '@/i18n/navigation'
import { martPageGate } from '@/lib/mart/gate'
import { getSessionUser } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/server'
import { getPool, poolProgressFor, poolMemberAmounts, buyerDiscipline } from '@/lib/mart/pools'
import { formatINR } from '@/lib/format'
import { PoolCard } from '@/components/mart/PoolCard'
import { istDateTime } from '@/components/mart/PoolProgress'
import { SheetCard } from '@/components/mart/primitives'

export const dynamic = 'force-dynamic'

/** My group buys — every commitment with its state and the next action. */
export default async function MyPoolsPage() {
  martPageGate()
  const user = await getSessionUser()
  if (!user) redirect('/login?next=/app/mart/pools')
  const [t, admin] = await Promise.all([getTranslations('mart'), createAdminClient()])
  const { data: msme } = await admin.from('msme_profiles').select('id').eq('user_id', user.id).maybeSingle()
  const { data: rows } = msme
    ? await admin.from('pool_members').select('*').eq('msme_id', msme.id).order('committed_at', { ascending: false }).limit(100)
    : { data: [] }
  const items = []
  for (const m of rows ?? []) {
    const pool = await getPool(admin, m.pool_id)
    if (pool) items.push({ m, pool })
  }
  const disc = msme ? await buyerDiscipline(admin, msme.id) : null
  const factor = disc ? poolDisciplineFactor(disc) : null

  return (
    <div className="mart-enter mx-auto max-w-3xl space-y-5 px-4 py-8">
      <div>
        <h1 className="font-display text-2xl font-bold text-emerald-ink">{t('my_pools_title')}</h1>
        {disc && factor && factor.sample > 0 && <p className="mt-1 text-meta text-foreground-secondary">{t('pool_discipline', { honoured: disc.honoured, due: disc.due })}</p>}
      </div>
      {items.length === 0 ? (
        <SheetCard className="jaali-ivory py-12 text-center">
          <p className="text-body text-emerald-ink">{t('my_pools_empty')}</p>
          <Link href={'/mart/pools' as '/services'} className="mt-4 inline-flex min-h-11 items-center rounded-button bg-emerald px-4 text-meta font-semibold text-ivory">{t('my_pools_browse')}</Link>
        </SheetCard>
      ) : (
        <ul className="space-y-4">
          {items.map(({ m, pool }) => (
            <li key={m.id} className="space-y-2">
              <PoolCard pool={pool} progress={poolProgressFor(pool)} />
              <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-meta">
                <span className="text-emerald-ink">{t('pool_joined', { qty: m.qty, unit: pool.unit })}</span>
                {pool.status === 'closed_met' && m.payment_state === 'blocked' && (
                  <Link href={`/app/mart/pools/${pool.id}/pay` as '/app'} className="inline-flex min-h-11 items-center rounded-button bg-gold-metal px-4 font-semibold text-emerald-ink">
                    {/* Audit L4 — the amount charged (GST included), from the server's one rule. */}
                    {t('pool_pay_now', { amount: formatINR(poolMemberAmounts(pool, m.qty)?.totalPaise ?? 0) })}{m.pay_by ? ` · ${t('pool_pay_by', { date: istDateTime(m.pay_by) })}` : ''}
                  </Link>
                )}
                {m.payment_state === 'captured' && m.order_id && <Link href={`/app/orders/${m.order_id}` as '/app'} className="font-medium text-emerald underline underline-offset-2">{t('pool_paid')}</Link>}
                {m.payment_state === 'failed' && <span className="text-stamp">{t('pool_lapsed')}</span>}
                {m.payment_state === 'released' && <span className="text-foreground-secondary">{t('pool_released')}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
