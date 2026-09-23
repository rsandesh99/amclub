import { redirect, notFound } from 'next/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { getOrderDetail, getOrderDocuments } from '@/lib/orders/queries'
import { OrderWorkspace } from '@/components/orders/OrderWorkspace'
import { createAdminClient } from '@/lib/supabase/server'
import { getGoodsOrderExtras } from '@/lib/mart/order-extras'
import { ORDER_REPEATABLE_STATUSES } from '@amclub/shared'
import { isOnFor } from '@/lib/experiments'
import { getBuyAgainForOrder } from '@/lib/home/buy-again'
import { BuyAgainLink } from '@/components/home-v3/BuyAgainShelf'

export default async function MsmeOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const user = await getSessionUser()
  if (!user) redirect(`/login?next=/app/orders/${id}`)

  const detail = await getOrderDetail(user.id, id)
  if (!detail) notFound()
  // E9 FR-9.3 (flag `home`): a finished services order offers Buy again / Repeat requirement / Find similar.
  const repeatable = detail.viewerRole === 'msme' && detail.order['kind'] !== 'goods' && (ORDER_REPEATABLE_STATUSES as readonly string[]).includes(String(detail.order['status'])) && isOnFor('home', user.id)
  // Documents (signed URLs) and, for goods orders only, the Mart extras load
  // in parallel with each other — services orders never touch the Mart path.
  const [documents, goods, again] = await Promise.all([
    getOrderDocuments(id),
    detail.order['kind'] === 'goods' ? getGoodsOrderExtras(await createAdminClient(), detail.order) : Promise.resolve(undefined),
    repeatable ? getBuyAgainForOrder(user.id, id) : Promise.resolve(null),
  ])

  return (
    <div className="min-h-screen bg-background">
      {again?.ok && (
        <div className="mx-auto max-w-5xl px-4 pt-4">
          <BuyAgainLink value={again.value} />
        </div>
      )}
      <OrderWorkspace order={detail.order} events={detail.events} viewerRole={detail.viewerRole} documents={documents} goods={goods} firstView={sp['first'] === '1'} extras={detail.extras} />
    </div>
  )
}
