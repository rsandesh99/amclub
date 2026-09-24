import 'server-only'
import { orderThreadState, redactContactInfo, type OrderMessageInput, type OrderMessageView, type OrderThreadState } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { getAgentSetting } from '@/lib/agent/settings'
import { isOnFor } from '@/lib/experiments'
import { createNotification } from '@/lib/notifications/create'
import { resolveActor } from './actor'
import { notifyText, sameText } from '@/lib/i18n/notify'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/** A counterparty is told once per burst: no second notice while an unread one for this order is this fresh. */
const NOTIFY_QUIET_MINUTES = 15

/**
 * PRD Experience v3 E8b FR-8.4 (N24) — order threads. The whole surface is
 * on only with the `orders` experience for the user AND
 * agent_settings.order_messaging_enabled; otherwise every route 404s.
 */
export async function isOrderMessagingOn(admin: Admin, userId: string): Promise<boolean> {
  if (!isOnFor('orders', userId)) return false
  return (await getAgentSetting(admin, 'order_messaging_enabled').catch(() => false)) === true
}

export interface OrderThread {
  orderId: string
  orderNumber: string
  title: string
  msmeId: string
  providerId: string
  role: 'buyer' | 'provider'
  counterpartyUserId: string | null
  state: OrderThreadState
}

/** The order + the caller's side of it, or null when the caller is not a party (the route answers 404). */
export async function loadOrderThread(admin: Admin, orderId: string, userId: string): Promise<OrderThread | null> {
  const { data: o } = await admin
    .from('orders')
    .select('id, order_number, title, status, kind, completed_at, updated_at, msme_id, provider_id, msme:msme_profiles!inner(user_id), provider:provider_profiles!inner(user_id)')
    .eq('id', orderId)
    .maybeSingle()
  if (!o || o.kind === 'goods') return null
  const actor = await resolveActor(admin, userId)
  const isBuyer = !!actor.msmeId && actor.msmeId === o.msme_id
  const isProvider = !!actor.providerId && actor.providerId === o.provider_id
  if (!isBuyer && !isProvider) return null
  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v)
  const buyerUser = one(o.msme as { user_id: string } | { user_id: string }[] | null)?.user_id ?? null
  const providerUser = one(o.provider as { user_id: string } | { user_id: string }[] | null)?.user_id ?? null
  return {
    orderId: o.id as string,
    orderNumber: String(o.order_number ?? ''),
    title: String(o.title ?? ''),
    msmeId: o.msme_id as string,
    providerId: o.provider_id as string,
    role: isBuyer ? 'buyer' : 'provider',
    counterpartyUserId: isBuyer ? providerUser : buyerUser,
    state: orderThreadState({ status: String(o.status), completedAt: (o.completed_at as string | null) ?? null, updatedAt: (o.updated_at as string | null) ?? null }),
  }
}

async function conversationId(admin: Admin, orderId: string): Promise<string | null> {
  const { data } = await admin.from('conversations').select('id').eq('context_type', 'order').eq('context_id', orderId).maybeSingle()
  return (data?.id as string | undefined) ?? null
}

export async function listOrderMessages(admin: Admin, thread: OrderThread, userId: string): Promise<{ messages: OrderMessageView[]; unread: number }> {
  const cid = await conversationId(admin, thread.orderId)
  if (!cid) return { messages: [], unread: 0 }
  const { data } = await admin.from('messages').select('id, sender_id, body, redacted, attachments, read_at, created_at').eq('conversation_id', cid).order('created_at', { ascending: true }).limit(500)
  const rows = data ?? []
  const docIds = [...new Set(rows.flatMap((m) => (Array.isArray(m.attachments) ? (m.attachments as { document_id?: string }[]).map((a) => a.document_id).filter((x): x is string => !!x) : [])))]
  const { data: docs } = docIds.length
    ? await admin.from('order_documents').select('id, file_name').eq('order_id', thread.orderId).in('id', docIds)
    : { data: [] as { id: string; file_name: string }[] }
  const docName = new Map((docs ?? []).map((d) => [d.id as string, d.file_name as string]))
  const messages = rows.map((m) => ({
    id: m.id as string,
    mine: m.sender_id === userId,
    body: m.body as string,
    redacted: m.redacted === true,
    createdAt: m.created_at as string,
    readAt: (m.read_at as string | null) ?? null,
    documents: (Array.isArray(m.attachments) ? (m.attachments as { document_id?: string }[]) : [])
      .map((a) => a.document_id)
      .filter((id): id is string => !!id && docName.has(id))
      .map((id) => ({ id, fileName: docName.get(id)! })),
  }))
  return { messages, unread: messages.filter((m) => !m.mine && !m.readAt).length }
}

/** Unread count for the Messages tab badge (0 when there is no thread). */
export async function unreadOrderMessages(admin: Admin, orderId: string, userId: string): Promise<number> {
  const cid = await conversationId(admin, orderId)
  if (!cid) return 0
  const { count } = await admin.from('messages').select('id', { count: 'exact', head: true }).eq('conversation_id', cid).neq('sender_id', userId).is('read_at', null)
  return count ?? 0
}

export type SendResult = { ok: true; message: OrderMessageView } | { ok: false; code: 'thread_read_only' | 'document_not_on_order' | 'failed' }

/**
 * The ONE writer: mask phone / email (redactContactInfo, as quote threads),
 * attach only documents of THIS order, insert with the service role, tell
 * the other party — the notification carries the order number and title,
 * never the message text (in-app and WhatsApp alike).
 */
export async function sendOrderMessage(admin: Admin, thread: OrderThread, userId: string, input: OrderMessageInput): Promise<SendResult> {
  if (thread.state !== 'open') return { ok: false, code: 'thread_read_only' }
  const docIds = [...new Set(input.documentIds ?? [])]
  let docs: { id: string; file_name: string }[] = []
  if (docIds.length) {
    const { data } = await admin.from('order_documents').select('id, file_name').eq('order_id', thread.orderId).in('id', docIds)
    docs = (data ?? []) as { id: string; file_name: string }[]
    if (docs.length !== docIds.length) return { ok: false, code: 'document_not_on_order' }
  }
  const { text, redacted } = redactContactInfo(input.body)

  const { data: convo, error: convoErr } = await admin
    .from('conversations')
    .upsert({ context_type: 'order', context_id: thread.orderId, msme_id: thread.msmeId, provider_id: thread.providerId }, { onConflict: 'context_type,context_id', ignoreDuplicates: false })
    .select('id')
    .single()
  if (convoErr || !convo) {
    console.error('[order message convo]', convoErr?.message)
    return { ok: false, code: 'failed' }
  }
  const { data: m, error } = await admin
    .from('messages')
    .insert({ conversation_id: convo.id, sender_id: userId, body: text, redacted, attachments: docs.map((d) => ({ document_id: d.id })) })
    .select('id, created_at')
    .single()
  if (error || !m) {
    console.error('[order message insert]', error?.message)
    return { ok: false, code: 'failed' }
  }

  if (thread.counterpartyUserId) {
    const link = thread.role === 'buyer' ? `/partner/orders/${thread.orderId}?tab=messages` : `/app/orders/${thread.orderId}?tab=messages`
    const since = new Date(Date.now() - NOTIFY_QUIET_MINUTES * 60_000).toISOString()
    const { data: recent } = await admin.from('notifications').select('id').eq('user_id', thread.counterpartyUserId).eq('kind', 'order_message').eq('link', link).is('read_at', null).gte('created_at', since).limit(1)
    if (!recent?.length) {
      await createNotification(admin, {
        userId: thread.counterpartyUserId,
        kind: 'order_message',
        // Never the message text: the order number (the WhatsApp template's only parameter) and the order title in-app.
        titleI18n: notifyText('order_message.title', { ref: thread.orderNumber }),
        bodyI18n: sameText(thread.title),
        link,
        channels: ['whatsapp'],
      })
    }
  }
  return { ok: true, message: { id: m.id as string, mine: true, body: text, redacted, createdAt: m.created_at as string, readAt: null, documents: docs.map((d) => ({ id: d.id, fileName: d.file_name })) } }
}

/** Mark the other party's messages read (the reader's own are never "unread"). */
export async function markOrderMessagesRead(admin: Admin, orderId: string, userId: string): Promise<number> {
  const cid = await conversationId(admin, orderId)
  if (!cid) return 0
  const { data } = await admin.from('messages').update({ read_at: new Date().toISOString() }).eq('conversation_id', cid).neq('sender_id', userId).is('read_at', null).select('id')
  return (data ?? []).length
}
