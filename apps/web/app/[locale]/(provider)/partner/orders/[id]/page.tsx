import { redirect, notFound } from 'next/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { getOrderDetail, getOrderDocuments } from '@/lib/orders/queries'
import { OrderWorkspace } from '@/components/orders/OrderWorkspace'

export default async function PartnerOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getSessionUser()
  if (!user) redirect(`/login?next=/partner/orders/${id}`)

  const detail = await getOrderDetail(user.id, id)
  if (!detail) notFound()
  const documents = await getOrderDocuments(id)

  return (
    <div className="min-h-screen bg-background">
      <OrderWorkspace order={detail.order} events={detail.events} viewerRole={detail.viewerRole} documents={documents} />
    </div>
  )
}
