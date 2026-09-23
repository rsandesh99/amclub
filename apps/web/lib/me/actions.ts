import 'server-only'
import { nextAction, sortActionItems, type ActionItem, type MeActions, type OrderStatus } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { listMatchedRfqsForProvider } from '@/lib/rfq/queries'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

// Orders still moving (nextAction returns null for every other status).
const LIVE: OrderStatus[] = ['placed', 'accepted', 'requirements_submitted', 'in_progress', 'delivered', 'revision_requested', 'completed', 'disputed']
const ITEM_CAP = 10

async function orderItems(admin: Admin, userId: string, col: 'msme_id' | 'provider_id', partyId: string, role: 'buyer' | 'provider'): Promise<ActionItem[]> {
  // Services orders only (goods follow the Mart action set). No staged column is named here.
  const { data: orders } = await admin
    .from('orders')
    .select('id, title, status, kind, created_at, due_at, auto_accept_at, external_wait_since')
    .eq(col, partyId)
    .in('status', LIVE)
    .order('created_at', { ascending: false })
    .limit(100)
  const rows = (orders ?? []).filter((o) => o.kind !== 'goods')
  const disputed = rows.filter((o) => o.status === 'disputed').map((o) => o.id as string)
  const filed = new Set<string>()
  if (disputed.length) {
    const { data: st } = await admin.from('dispute_statements').select('order_id').in('order_id', disputed).eq('author_user_id', userId).is('deleted_at', null)
    for (const s of st ?? []) filed.add(s.order_id as string)
  }
  const base = role === 'buyer' ? '/app/orders' : '/partner/orders'
  const items: ActionItem[] = []
  for (const o of rows) {
    const a = nextAction(o.status as OrderStatus, role, {
      createdAt: o.created_at as string,
      dueAt: (o.due_at as string | null) ?? null,
      autoAcceptAt: (o.auto_accept_at as string | null) ?? null,
      externalWaitSince: (o.external_wait_since as string | null) ?? null,
      ownStatementSubmitted: filed.has(o.id as string),
    })
    if (!a || a.actor !== 'self') continue
    items.push({ kind: 'order_action', objectId: o.id as string, title: (o.title as string) ?? '', action: a.action, count: null, dueAt: a.dueAt, href: `${base}/${o.id}` })
  }
  return items
}

/**
 * N2 — everything waiting on this user, per role. Party-scoped: every read is
 * keyed to the caller's own profile ids (resolveActor), so the service-role
 * client never returns another user's rows.
 */
export async function getMyActions(userId: string): Promise<MeActions> {
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)

  let buyer: MeActions['buyer'] = null
  if (actor.msmeId) {
    const [orders, { data: rfqs }] = await Promise.all([
      orderItems(admin, userId, 'msme_id', actor.msmeId, 'buyer'),
      admin.from('rfqs').select('id, title, status, quote_count, expires_at').eq('msme_id', actor.msmeId).in('status', ['open', 'quoted']).is('deleted_at', null),
    ])
    const live = rfqs ?? []
    const quotes: ActionItem[] = live
      .filter((r) => Number(r.quote_count) > 0)
      .map((r) => ({ kind: 'quotes_waiting', objectId: r.id as string, title: (r.title as string) ?? '', action: null, count: Number(r.quote_count), dueAt: (r.expires_at as string | null) ?? null, href: `/app/rfq/${r.id}` }))
    const questions: ActionItem[] = []
    if (live.length) {
      const { data: open } = await admin.from('rfq_clarifications').select('rfq_id').in('rfq_id', live.map((r) => r.id as string)).is('answered_at', null).is('deleted_at', null)
      const byRfq = new Map<string, number>()
      for (const c of open ?? []) byRfq.set(c.rfq_id as string, (byRfq.get(c.rfq_id as string) ?? 0) + 1)
      for (const r of live) {
        const n = byRfq.get(r.id as string)
        if (n) questions.push({ kind: 'clarification_question', objectId: r.id as string, title: (r.title as string) ?? '', action: null, count: n, dueAt: null, href: `/app/rfq/${r.id}#questions` })
      }
    }
    buyer = {
      counts: { requirements: quotes.length + questions.length, orders: orders.length },
      items: sortActionItems([...orders, ...quotes, ...questions]).slice(0, ITEM_CAP),
    }
  }

  let provider: MeActions['provider'] = null
  if (actor.providerId) {
    const [orders, matched] = await Promise.all([
      orderItems(admin, userId, 'provider_id', actor.providerId, 'provider'),
      listMatchedRfqsForProvider(userId),
    ])
    const fresh: ActionItem[] = matched
      .filter((m) => m.outcome === 'open' && !m.viewed)
      .map((m) => ({ kind: 'rfq_new', objectId: m.rfqId, title: m.title ?? '', action: null, count: null, dueAt: m.expiresAt ?? null, href: `/partner/rfqs/${m.rfqId}` }))
    provider = {
      counts: { rfqs: fresh.length, orders: orders.length },
      items: sortActionItems([...orders, ...fresh]).slice(0, ITEM_CAP),
    }
  }

  return { buyer, provider }
}
