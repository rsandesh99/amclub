import 'server-only'
import { compareQuotes, isQuoteExpiringSoon, nextAction, QUOTE_STATUS, quoteValidityEndsAt, sortActionItems, type ActionItem, type CompareQuoteInput, type MeActions, type OrderStatus } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { listMatchedRfqsForProvider } from '@/lib/rfq/queries'
import { todayIST } from '@/lib/agent/quote-extract'
import { isOnFor } from '@/lib/experiments'
import { isGoodsRow, QUOTE_GOODS_COLS, RFQ_GOODS_LIST_COLS } from '@/lib/mart/staged-columns'
import { AGENT_ENABLED } from '@/lib/flags'
import { isMunshiEnabledFor } from '@/lib/agent/munshi'

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

type LiveRfq = { id: string; title: string | null; kind?: string | null }
type QuoteRow = {
  id: string
  rfq_id: string
  price_paise: number
  delivery_days: number | null
  gst_included: boolean | null
  transport_included: boolean | null
  valid_until: string | null
  advance_percent: number | null
  unit_price_paise?: number | null
  qty?: number | null
  gst_rate_bps?: number | null
  provider: { display_name: string | null } | { display_name: string | null }[] | null
}

/**
 * E9 FR-9.1 — per open RFQ, the lowest normalised all-in total of its
 * submitted quotes (`compareQuotes`, the compare screen's own rule), and one
 * `quote_expiring` row per submitted quote whose validity ends within 48 h.
 * Keyed to the buyer's own RFQ ids; staged goods columns ride the fragments.
 */
async function buyerQuoteFacts(admin: Admin, live: LiveRfq[]): Promise<{ fromPaise: Map<string, number>; expiring: ActionItem[] }> {
  const fromPaise = new Map<string, number>()
  const expiring: ActionItem[] = []
  if (live.length === 0) return { fromPaise, expiring }
  const { data } = await admin
    .from('quotes')
    .select('id, rfq_id, price_paise, delivery_days, gst_included, transport_included, valid_until, advance_percent' + QUOTE_GOODS_COLS + ', provider:provider_profiles(display_name)')
    .in('rfq_id', live.map((r) => r.id))
    .eq('status', QUOTE_STATUS.submitted)
  const rows = (data ?? []) as unknown as QuoteRow[]
  const today = todayIST()
  const now = new Date()
  for (const r of live) {
    const mine = rows.filter((q) => q.rfq_id === r.id)
    if (mine.length === 0) continue
    const goods = isGoodsRow(r)
    const inputs: CompareQuoteInput[] = mine.map((q) => ({
      id: q.id,
      kind: goods ? 'goods' : 'service',
      pricePaise: Number(q.price_paise),
      deliveryDays: q.delivery_days,
      gstIncluded: q.gst_included,
      transportIncluded: q.transport_included,
      validUntil: q.valid_until,
      advancePercent: q.advance_percent,
      goods: goods && q.unit_price_paise != null ? { unitPricePaise: Number(q.unit_price_paise), qty: Number(q.qty), gstRateBps: Number(q.gst_rate_bps) } : null,
    }))
    const totals = compareQuotes(inputs, { today }).map((c) => c.normalizedTotalPaise)
    fromPaise.set(r.id, Math.min(...totals))
    for (const q of mine) {
      if (!isQuoteExpiringSoon(q.valid_until, now)) continue
      const p = Array.isArray(q.provider) ? q.provider[0] : q.provider
      expiring.push({ kind: 'quote_expiring', objectId: q.id, title: r.title ?? '', action: null, count: null, dueAt: quoteValidityEndsAt(q.valid_until), href: `/app/rfq/${r.id}`, providerName: p?.display_name ?? '' })
    }
  }
  return { fromPaise, expiring }
}

/**
 * E11 FR-11.1 — provider rows beyond orders and new RFQs: a buyer's message on
 * one of my quotes whose thread's latest word is the buyer's, and Munshi
 * drafts waiting for my tap (only while Munshi is on for me). Keyed to my own
 * provider id; titles are the RFQ titles I can already see.
 */
async function providerExtraItems(admin: Admin, userId: string, providerId: string): Promise<ActionItem[]> {
  const out: ActionItem[] = []
  const { data: convs } = await admin
    .from('conversations')
    .select('id, context_id')
    .eq('provider_id', providerId)
    .eq('context_type', 'quote')
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(30)
  if (convs?.length) {
    const { data: msgs } = await admin.from('messages').select('conversation_id, sender_id, created_at').in('conversation_id', convs.map((c) => c.id as string)).order('created_at', { ascending: false }).limit(300)
    const latest = new Map<string, { sender: string; at: string }>()
    for (const m of msgs ?? []) if (!latest.has(m.conversation_id as string)) latest.set(m.conversation_id as string, { sender: m.sender_id as string, at: m.created_at as string })
    const waiting = convs.filter((c) => { const l = latest.get(c.id as string); return !!l && l.sender !== userId })
    if (waiting.length) {
      const { data: qs } = await admin.from('quotes').select('id, rfq_id, rfq:rfqs(title)').in('id', waiting.map((c) => c.context_id as string))
      const byQuote = new Map((qs ?? []).map((q) => [q.id as string, q as unknown as { rfq_id: string; rfq: { title: string | null } | { title: string | null }[] | null }]))
      for (const c of waiting) {
        const q = byQuote.get(c.context_id as string)
        if (!q) continue
        const rfq = Array.isArray(q.rfq) ? q.rfq[0] : q.rfq
        out.push({ kind: 'buyer_message', objectId: c.id as string, title: rfq?.title ?? '', action: null, count: null, dueAt: null, href: `/partner/rfqs/${q.rfq_id}` })
      }
    }
  }
  if (AGENT_ENABLED && (await isMunshiEnabledFor(admin, userId).catch(() => false))) {
    const { data: drafts } = await admin.from('munshi_drafts').select('id, rfq_id, rfq:rfqs(title)').eq('provider_id', providerId).eq('status', 'proposed').order('created_at', { ascending: false }).limit(10)
    for (const d of (drafts ?? []) as unknown as { id: string; rfq_id: string | null; rfq: { title: string | null } | { title: string | null }[] | null }[]) {
      const rfq = Array.isArray(d.rfq) ? d.rfq[0] : d.rfq
      out.push({ kind: 'munshi_draft', objectId: d.id, title: rfq?.title ?? '', action: null, count: null, dueAt: null, href: '/partner/munshi' })
    }
  }
  return out
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
      admin.from('rfqs').select('id, title, status, quote_count, expires_at' + RFQ_GOODS_LIST_COLS).eq('msme_id', actor.msmeId).in('status', ['open', 'quoted']).is('deleted_at', null),
    ])
    const live = (rfqs ?? []) as unknown as { id: string; title: string | null; quote_count: number | null; expires_at: string | null; kind?: string | null }[]
    // E9 (flag `home`): the lowest all-in total per RFQ and the quotes about to lapse.
    const quoteFacts = isOnFor('home', userId) ? await buyerQuoteFacts(admin, live) : null
    const quotes: ActionItem[] = live
      .filter((r) => Number(r.quote_count) > 0)
      .map((r) => ({
        kind: 'quotes_waiting' as const,
        objectId: r.id,
        title: r.title ?? '',
        action: null,
        count: Number(r.quote_count),
        dueAt: r.expires_at ?? null,
        href: `/app/rfq/${r.id}`,
        ...(quoteFacts ? { fromPaise: quoteFacts.fromPaise.get(r.id) ?? null } : {}),
      }))
    const questions: ActionItem[] = []
    if (live.length) {
      const { data: open } = await admin.from('rfq_clarifications').select('rfq_id').in('rfq_id', live.map((r) => r.id as string)).is('answered_at', null).is('deleted_at', null)
      const byRfq = new Map<string, number>()
      for (const c of open ?? []) byRfq.set(c.rfq_id as string, (byRfq.get(c.rfq_id as string) ?? 0) + 1)
      for (const r of live) {
        const n = byRfq.get(r.id)
        if (n) questions.push({ kind: 'clarification_question', objectId: r.id, title: r.title ?? '', action: null, count: n, dueAt: null, href: `/app/rfq/${r.id}#questions` })
      }
    }
    const expiring = quoteFacts?.expiring ?? []
    buyer = {
      counts: { requirements: quotes.length + questions.length + expiring.length, orders: orders.length },
      items: sortActionItems<ActionItem>([...orders, ...quotes, ...expiring, ...questions]).slice(0, ITEM_CAP),
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
    // E11 (FR-11.1, flag `partner`): buyer messages waiting on a reply, and Munshi drafts ready (dark, S2.2).
    const extra = isOnFor('partner', userId) ? await providerExtraItems(admin, userId, actor.providerId) : []
    provider = {
      counts: { rfqs: fresh.length + extra.filter((i) => i.kind === 'buyer_message').length, orders: orders.length },
      items: sortActionItems<ActionItem>([...orders, ...fresh, ...extra]).slice(0, ITEM_CAP),
    }
  }

  return { buyer, provider }
}
