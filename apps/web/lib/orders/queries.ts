import 'server-only'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from './actor'

export interface OrderDetail {
  order: Record<string, unknown>
  events: { id: string; event: string; payload: unknown; created_at: string; actor_id: string | null }[]
  viewerRole: 'msme' | 'provider'
}

/** Load an order for a viewer, verifying they're a party. Returns null if not. */
export async function getOrderDetail(userId: string, orderId: string): Promise<OrderDetail | null> {
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  const { data: order } = await admin.from('orders').select('*').eq('id', orderId).maybeSingle()
  if (!order) return null

  const isMsme = actor.msmeId && order.msme_id === actor.msmeId
  const isProvider = actor.providerId && order.provider_id === actor.providerId
  if (!isMsme && !isProvider) return null

  const { data: events } = await admin
    .from('order_events')
    .select('id, event, payload, created_at, actor_id')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true })

  return { order, events: events ?? [], viewerRole: isProvider ? 'provider' : 'msme' }
}

/** Order documents with fresh 15-min signed URLs (§9.4). */
export async function getOrderDocuments(orderId: string) {
  const admin = await createAdminClient()
  const { data: docs } = await admin
    .from('order_documents')
    .select('id, file_name, kind, file_url')
    .eq('order_id', orderId)
    .order('created_at', { ascending: true })
  return Promise.all(
    (docs ?? []).map(async (d) => {
      const { data: signed } = await admin.storage.from('order-documents').createSignedUrl(d.file_url, 15 * 60)
      return { id: d.id, file_name: d.file_name, kind: d.kind, signedUrl: signed?.signedUrl ?? null }
    }),
  )
}

/** List the viewer's orders (as buyer or provider). */
export async function listMyOrders(userId: string, as: 'msme' | 'provider') {
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  const profileId = as === 'msme' ? actor.msmeId : actor.providerId
  if (!profileId) return []
  const col = as === 'msme' ? 'msme_id' : 'provider_id'
  const { data } = await admin
    .from('orders')
    .select('id, order_number, title, status, total_paise, provider_earning_paise, created_at')
    .eq(col, profileId)
    .order('created_at', { ascending: false })
  return data ?? []
}
