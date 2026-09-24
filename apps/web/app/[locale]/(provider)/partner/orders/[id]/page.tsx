import { redirect, notFound } from 'next/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { getOrderDetail, getOrderDocuments } from '@/lib/orders/queries'
import { OrderWorkspace } from '@/components/orders/OrderWorkspace'
import { createAdminClient } from '@/lib/supabase/server'
import { getGoodsOrderExtras } from '@/lib/mart/order-extras'
import { ORDER_LICENCE_RECORDABLE_STATUSES } from '@amclub/shared'
import { getOrderLicenceFacts, isObligationsOn } from '@/lib/licences'
import { RecordFactsForm } from '@/components/licences-v3/LicenceForm'
import { isOnFor } from '@/lib/experiments'
import { isOrderMessagingOn, unreadOrderMessages } from '@/lib/orders/messages'

export default async function PartnerOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const user = await getSessionUser()
  if (!user) redirect(`/login?next=/partner/orders/${id}`)

  const detail = await getOrderDetail(user.id, id)
  if (!detail) notFound()
  // Documents (signed URLs) and, for goods orders only, the Mart extras load
  // in parallel with each other — services orders never touch the Mart path.
  const [documents, goods] = await Promise.all([
    getOrderDocuments(id),
    detail.order['kind'] === 'goods' ? getGoodsOrderExtras(await createAdminClient(), detail.order, detail.viewerRole) : Promise.resolve(undefined),
  ])

  // E9b (FR-9.5, dark): the provider records the certificate a registration order produced.
  const canRecord = detail.viewerRole === 'provider' && detail.order['kind'] !== 'goods' && (ORDER_LICENCE_RECORDABLE_STATUSES as readonly string[]).includes(String(detail.order['status'])) && (await isObligationsOn())
  const facts = canRecord ? await getOrderLicenceFacts(user.id, id) : null

  // E8 (flag `orders`) and E8b order messaging (+ order_messaging_enabled); services orders only.
  const v3 = isOnFor('orders', user.id)
  const msgAdmin = v3 && detail.order['kind'] !== 'goods' ? await createAdminClient() : null
  const messaging = msgAdmin && (await isOrderMessagingOn(msgAdmin, user.id)) ? { on: true, unread: await unreadOrderMessages(msgAdmin, id, user.id) } : { on: false, unread: 0 }

  return (
    <div className="min-h-screen bg-background">
      {canRecord && facts !== 'forbidden' && (
        <div className="mx-auto max-w-5xl px-4 pt-4">
          <RecordFactsForm orderId={id} initial={facts ? { licenceType: facts.licenceType, number: facts.number, issuedOn: facts.issuedOn, expiresOn: facts.expiresOn, authority: facts.authority } : null} />
        </div>
      )}
      <OrderWorkspace order={detail.order} events={detail.events} viewerRole={detail.viewerRole} documents={documents} goods={goods} extras={detail.extras} v3={v3} initialTab={sp['tab']} messaging={messaging} />
    </div>
  )
}
