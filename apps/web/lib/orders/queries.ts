import 'server-only'
import { createAdminClient } from '@/lib/supabase/server'
import { disputeWindowEndsAt, PAYOUT_STATUS, type OrderPayoutFacts, type PayoutStatus } from '@amclub/shared'
import { getAgentSetting } from '@/lib/agent/settings'
import { resolveActor } from './actor'

const PAYOUT_HELD = PAYOUT_STATUS.held

/** One requirement field from the package's frozen `scope_snapshot.requirementsTemplate`. */
export interface RequirementTemplateField {
  name: string
  labelEn: string | null
  labelHi: string | null
  required: boolean
}

/** The buyer's submitted requirements (the `requirements_data` order_event), shown to BOTH parties. */
export interface SubmittedRequirements {
  submittedAt: string
  fields: { name: string; labelEn: string | null; labelHi: string | null; value: string }[]
}

/** Server-derived facts the services workspace renders. Money is server paise only. */
export interface ServicesOrderExtras {
  requirementsTemplate: RequirementTemplateField[]
  requirements: SubmittedRequirements | null
  /** The buyer's note on the latest revision request (payload.revisionNote). */
  lastRevisionNote: string | null
  /** The refunds row for this order's payment, if any (buyer-visible). */
  refund: { amountPaise: number; status: string; createdAt: string } | null
  /** ADR-014 (H2) — a completed order's last moment to report a problem (ISO); null otherwise. */
  disputeWindowEndsAt: string | null
  /** E8 FR-8.5 (N37) — the order's payout, for the PROVIDER's money line only (null for the buyer or before one exists). */
  payout: OrderPayoutFacts | null
}

/** ADR-014 (H2) — the post-completion dispute deadline for a services order, or null. */
export async function orderDisputeWindowEndsAt(admin: Awaited<ReturnType<typeof createAdminClient>>, order: { status?: unknown; kind?: unknown; completed_at?: unknown }): Promise<string | null> {
  if (order.status !== 'completed' || order.kind === 'goods') return null
  const windowDays = Number(await getAgentSetting(admin, 'dispute_window_days'))
  return disputeWindowEndsAt(typeof order.completed_at === 'string' ? order.completed_at : null, windowDays)
}

export interface OrderEventView {
  id: string
  event: string
  created_at: string
  actor_id: string | null
}

export interface OrderDetail {
  order: Record<string, unknown>
  /** Payloads are NOT sent to the client (they carry payout amounts and
   *  internal reasons); the few that matter are projected into `extras`. */
  events: OrderEventView[]
  viewerRole: 'msme' | 'provider'
  extras: ServicesOrderExtras
}

const MAX_REQUIREMENT_CHARS = 4000

function asText(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_REQUIREMENT_CHARS) : null
}

/** Parse the frozen template defensively (quote-sourced / older snapshots have none). */
function readTemplate(scopeSnapshot: unknown): RequirementTemplateField[] {
  const tpl = (scopeSnapshot as { requirementsTemplate?: { fields?: unknown } } | null)?.requirementsTemplate
  const fields: unknown[] = Array.isArray(tpl?.fields) ? tpl.fields : []
  return fields.flatMap((f) => {
    const r = f as { name?: unknown; label_en?: unknown; label_hi?: unknown; required?: unknown } | null
    if (!r || typeof r.name !== 'string' || !r.name) return []
    return [{ name: r.name, labelEn: asText(r.label_en), labelHi: asText(r.label_hi), required: r.required !== false }]
  })
}

/** Only string values survive; labels come from the frozen template, never the payload. */
function readRequirements(
  ev: { payload: unknown; created_at: string } | undefined,
  template: RequirementTemplateField[],
): SubmittedRequirements | null {
  if (!ev || !ev.payload || typeof ev.payload !== 'object' || Array.isArray(ev.payload)) return null
  const byName = new Map(template.map((f) => [f.name, f]))
  const fields = Object.entries(ev.payload as Record<string, unknown>).flatMap(([name, raw]) => {
    const value = asText(raw)
    if (!value) return []
    const tf = byName.get(name)
    return [{ name, labelEn: tf?.labelEn ?? null, labelHi: tf?.labelHi ?? null, value }]
  })
  return fields.length > 0 ? { submittedAt: ev.created_at, fields } : null
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

  const [{ data: events }, { data: payment }, disputeEndsAt, { data: payoutRow }] = await Promise.all([
    admin
      .from('order_events')
      .select('id, event, payload, created_at, actor_id')
      .eq('order_id', orderId)
      .order('created_at', { ascending: true }),
    admin.from('payments').select('id').eq('order_id', orderId).maybeSingle(),
    orderDisputeWindowEndsAt(admin, order),
    isProvider
      ? admin.from('payouts').select('status, scheduled_for, paid_at').eq('order_id', orderId).order('created_at', { ascending: false }).limit(1).maybeSingle()
      : Promise.resolve({ data: null }),
  ])
  const { data: refund } = payment
    ? await admin.from('refunds').select('amount_paise, status, created_at').eq('payment_id', payment.id).maybeSingle()
    : { data: null }

  const all = events ?? []
  const latest = (name: string) => [...all].reverse().find((e) => e.event === name)
  const template = readTemplate(order.scope_snapshot)
  const revisionEv = latest('request_revision')
  const heldReasons = (latest('payout_held')?.payload as { reasons?: unknown } | null)?.reasons
  const payout: OrderPayoutFacts | null = payoutRow
    ? {
        status: payoutRow.status as PayoutStatus,
        scheduledFor: (payoutRow.scheduled_for as string | null) ?? null,
        paidAt: (payoutRow.paid_at as string | null) ?? null,
        holdReasons: payoutRow.status === PAYOUT_HELD && Array.isArray(heldReasons) ? heldReasons.filter((r): r is string => typeof r === 'string') : [],
      }
    : null

  return {
    order,
    events: all.map((e) => ({ id: e.id, event: e.event, created_at: e.created_at, actor_id: e.actor_id })),
    viewerRole: isProvider ? 'provider' : 'msme',
    extras: {
      requirementsTemplate: template,
      requirements: readRequirements(latest('requirements_data'), template),
      lastRevisionNote: asText((revisionEv?.payload as { revisionNote?: unknown } | null)?.revisionNote),
      refund: refund
        ? { amountPaise: Number(refund.amount_paise), status: String(refund.status), createdAt: String(refund.created_at) }
        : null,
      disputeWindowEndsAt: disputeEndsAt,
      payout,
    },
  }
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

export interface ProviderPayout {
  id: string
  orderId: string
  orderNumber: string | null
  orderTitle: string | null
  amountPaise: number
  status: string
  scheduledFor: string | null
  paidAt: string | null
  /** Why a held payout is held (latest `payout_held` event's payload.reasons). Empty unless held. */
  holdReasons: string[]
}

/** List the provider's payouts (newest first), joined to their order. */
export async function listMyPayouts(userId: string): Promise<ProviderPayout[]> {
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return []
  const { data } = await admin
    .from('payouts')
    .select('id, order_id, amount_paise, status, scheduled_for, paid_at, orders(order_number, title)')
    .eq('provider_id', actor.providerId)
    .order('created_at', { ascending: false })
  const rows = data ?? []
  // Hold reasons live on the payout_held order_event (schedulePayout / raise_dispute).
  const heldOrderIds = rows.filter((p) => p.status === PAYOUT_HELD).map((p) => p.order_id).filter(Boolean)
  const { data: heldEvents } = heldOrderIds.length
    ? await admin
        .from('order_events')
        .select('order_id, payload, created_at')
        .eq('event', 'payout_held')
        .in('order_id', heldOrderIds)
        .order('created_at', { ascending: false })
    : { data: [] as { order_id: string; payload: unknown; created_at: string }[] }
  const reasonsByOrder = new Map<string, string[]>()
  for (const e of heldEvents ?? []) {
    if (reasonsByOrder.has(e.order_id)) continue
    const reasons = (e.payload as { reasons?: unknown } | null)?.reasons
    reasonsByOrder.set(e.order_id, Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === 'string') : [])
  }
  return rows.map((p) => {
    // Supabase types an embedded to-one relation as an array; take the first.
    const rel = p.orders as unknown as { order_number: string; title: string }[] | { order_number: string; title: string } | null
    const order = Array.isArray(rel) ? rel[0] ?? null : rel
    return {
      id: p.id,
      orderId: p.order_id,
      orderNumber: order?.order_number ?? null,
      orderTitle: order?.title ?? null,
      amountPaise: Number(p.amount_paise),
      status: p.status,
      scheduledFor: p.scheduled_for,
      paidAt: p.paid_at,
      holdReasons: p.status === PAYOUT_HELD ? (reasonsByOrder.get(p.order_id) ?? []) : [],
    }
  })
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
