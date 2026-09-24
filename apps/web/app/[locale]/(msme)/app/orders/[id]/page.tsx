import { redirect, notFound } from 'next/navigation'
import { getSessionUser } from '@/lib/auth/session'
import { getOrderDetail, getOrderDocuments } from '@/lib/orders/queries'
import { OrderWorkspace } from '@/components/orders/OrderWorkspace'
import { createAdminClient } from '@/lib/supabase/server'
import { getGoodsOrderExtras } from '@/lib/mart/order-extras'
import { ORDER_REPEATABLE_STATUSES } from '@amclub/shared'
import { isOnFor } from '@/lib/experiments'
import { isOrderMessagingOn, unreadOrderMessages } from '@/lib/orders/messages'
import { getBuyAgainForOrder } from '@/lib/home/buy-again'
import { BuyAgainLink } from '@/components/home-v3/BuyAgainShelf'
import { getOrderLicenceFacts, isObligationsOn } from '@/lib/licences'
import { AddFromOrderButton } from '@/components/licences-v3/LicenceForm'
import { getTranslations } from 'next-intl/server'

export default async function MsmeOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams])
  const user = await getSessionUser()
  if (!user) redirect(`/login?next=/app/orders/${id}`)

  const detail = await getOrderDetail(user.id, id)
  if (!detail) notFound()
  // E9 FR-9.3 (flag `home`): a finished services order offers Buy again / Repeat requirement / Find similar.
  const finished = detail.viewerRole === 'msme' && detail.order['kind'] !== 'goods' && (ORDER_REPEATABLE_STATUSES as readonly string[]).includes(String(detail.order['status']))
  const repeatable = finished && isOnFor('home', user.id)
  // Documents (signed URLs) and, for goods orders only, the Mart extras load
  // in parallel with each other — services orders never touch the Mart path.
  // E9b (FR-9.5, dark): the certificate the provider recorded on this order, to add to "My licences".
  const licenceFacts = finished && (await isObligationsOn()) ? await getOrderLicenceFacts(user.id, id) : null
  const tLic = licenceFacts && licenceFacts !== 'forbidden' ? await getTranslations('licences_v3') : null
  const [documents, goods, again] = await Promise.all([
    getOrderDocuments(id),
    detail.order['kind'] === 'goods' ? getGoodsOrderExtras(await createAdminClient(), detail.order, detail.viewerRole) : Promise.resolve(undefined),
    repeatable ? getBuyAgainForOrder(user.id, id) : Promise.resolve(null),
  ])

  // E8 (flag `orders`) and E8b order messaging (+ order_messaging_enabled); services orders only.
  const v3 = isOnFor('orders', user.id)
  const msgAdmin = v3 && detail.order['kind'] !== 'goods' ? await createAdminClient() : null
  const messaging = msgAdmin && (await isOrderMessagingOn(msgAdmin, user.id)) ? { on: true, unread: await unreadOrderMessages(msgAdmin, id, user.id) } : { on: false, unread: 0 }

  return (
    <div className="min-h-screen bg-background">
      {again?.ok && (
        <div className="mx-auto max-w-5xl px-4 pt-4">
          <BuyAgainLink value={again.value} />
        </div>
      )}
      {tLic && licenceFacts && licenceFacts !== 'forbidden' && (
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 pt-3" data-testid="order-licence-facts">
          <span className="text-sm">{tLic(`type_${licenceFacts.licenceType}`)} · <span className="tabular-nums">{licenceFacts.number}</span></span>
          {licenceFacts.added ? <span className="t-footnote font-medium text-success">{tLic('added')}</span> : <AddFromOrderButton orderId={id} />}
        </div>
      )}
      <OrderWorkspace order={detail.order} events={detail.events} viewerRole={detail.viewerRole} documents={documents} goods={goods} firstView={sp['first'] === '1'} extras={detail.extras} v3={v3} initialTab={sp['tab']} messaging={messaging} />
    </div>
  )
}
