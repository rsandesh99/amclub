import 'server-only'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'

const BUCKET = 'invoices'

export interface BuyerInvoice {
  id: string
  number: string
  orderId: string
  orderNumber: string
  orderTitle: string
  totalPaise: number
  createdAt: string
  downloadUrl: string | null
}

/**
 * Buyer-facing invoice list: only `buyer_invoice` kind for orders the user owns
 * as the buyer. Commission invoices are platform↔provider and never exposed
 * here. Each PDF gets a fresh 15-min signed URL.
 */
export async function listMyInvoices(userId: string): Promise<BuyerInvoice[]> {
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.msmeId) return []

  // Orders owned by this buyer.
  const { data: orders } = await admin
    .from('orders')
    .select('id, order_number, title, total_paise')
    .eq('msme_id', actor.msmeId)
  if (!orders || orders.length === 0) return []

  const orderById = new Map(orders.map((o) => [o.id, o]))
  const orderIds = orders.map((o) => o.id)

  const { data: invoices } = await admin
    .from('invoices')
    .select('id, number, order_id, pdf_url, created_at')
    .eq('kind', 'buyer_invoice')
    .in('order_id', orderIds)
    .order('created_at', { ascending: false })

  return Promise.all(
    (invoices ?? []).map(async (inv) => {
      const order = orderById.get(inv.order_id)
      let downloadUrl: string | null = null
      if (inv.pdf_url) {
        const { data: signed } = await admin.storage.from(BUCKET).createSignedUrl(inv.pdf_url, 15 * 60)
        downloadUrl = signed?.signedUrl ?? null
      }
      return {
        id: inv.id,
        number: inv.number,
        orderId: inv.order_id,
        orderNumber: order?.order_number ?? '',
        orderTitle: order?.title ?? '',
        totalPaise: Number(order?.total_paise ?? 0),
        createdAt: inv.created_at,
        downloadUrl,
      }
    }),
  )
}
