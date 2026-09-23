import { redirect, notFound } from 'next/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { getOrderDetail, getOrderDocuments } from '@/lib/orders/queries'
import { OrderWorkspace } from '@/components/orders/OrderWorkspace'
import { createAdminClient } from '@/lib/supabase/server'
import { getGoodsOrderExtras } from '@/lib/mart/order-extras'

export default async function PartnerOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getSessionUser()
  if (!user) redirect(`/login?next=/partner/orders/${id}`)

  const detail = await getOrderDetail(user.id, id)
  if (!detail) notFound()
  // Documents (signed URLs) and, for goods orders only, the Mart extras load
  // in parallel with each other — services orders never touch the Mart path.
  const [documents, goods] = await Promise.all([
    getOrderDocuments(id),
    detail.order['kind'] === 'goods' ? getGoodsOrderExtras(await createAdminClient(), detail.order) : Promise.resolve(undefined),
  ])

  return (
    <div className="min-h-screen bg-background">
      <OrderWorkspace order={detail.order} events={detail.events} viewerRole={detail.viewerRole} documents={documents} goods={goods} extras={detail.extras} />
    </div>
  )
}
