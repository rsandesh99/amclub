/**
 * AMC Mart M1 — group-buy pools (MART_DESIGN.md §4.4). ONE place owns every
 * pool transition and the pool money rule; routes and the cron call these.
 *
 * Mechanic (ADR-006): PAY-ON-CLOSE. Joining records a commitment (qty +
 * delivery snapshot); no money moves. When the pool closes met, every member
 * pays an ordinary goods order — an ordinary checkout_session (kind='goods')
 * → the unchanged webhook → materialize_order → payout.ts. There is no
 * second money path. A member who does not pay inside the window is a
 * DEFAULT (payment_state 'failed') and feeds the buyer discipline inputs.
 *
 * Every transition emits a pool_events row (append-only).
 */
import 'server-only'
import { createHash } from 'node:crypto'
import {
  assertPoolTransition,
  computeGoodsOrderAmounts,
  goodsItcSplit,
  isValidPoolMemberPaymentTransition,
  mayCapturePoolMember,
  poolCloseOutcome,
  poolIsDueToClose,
  poolMemberMayLeave,
  poolOpenProblem,
  poolPayDeadline,
  poolProgress,
  buildPoolCardText,
  type PoolStatus,
  type PoolMemberPaymentState,
  type PoolSummary,
  type PoolDraft,
  type PoolOpenInput,
  type PoolJoinInput,
  type PoolEventType,
  type GoodsLineItem,
} from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { createNotification } from '@/lib/notifications/create'
import { getMartCategory, getMartSetting } from './config'
import { publicAssetUrl } from './assets'

type Admin = Awaited<ReturnType<typeof createAdminClient>>
/* eslint-disable @typescript-eslint/no-explicit-any */

export type PoolLifecycleEvent = PoolEventType | 'drafted' | 'approved' | 'card_confirmed' | 'qty_changed' | 'defaulted' | 'settled'

/** Append a pool_events row (service role; append-only table). Never throws. */
export async function addPoolEvent(
  admin: Admin,
  poolId: string,
  eventType: PoolLifecycleEvent,
  opts: { memberId?: string | null; actorId?: string | null; payload?: unknown } = {},
): Promise<void> {
  const { error } = await admin.from('pool_events').insert({
    pool_id: poolId,
    member_id: opts.memberId ?? null,
    actor_id: opts.actorId ?? null,
    event_type: eventType,
    payload: opts.payload ?? null,
  })
  if (error) console.error('[addPoolEvent]', eventType, error.message)
}

// ── Config ───────────────────────────────────────────────────────────────────

export async function getPoolPayWindowHours(admin: Admin): Promise<number> {
  return Number(await getMartSetting<number | string>(admin, 'pool_pay_window_hours', 48))
}

export async function getPoolCategories(admin: Admin): Promise<string[]> {
  const v = await getMartSetting<string[]>(admin, 'pool_categories', [])
  return Array.isArray(v) ? v : []
}

export async function getPoolPaymentMode(admin: Admin): Promise<'pay_on_close' | 'block_capture'> {
  const v = await getMartSetting<string>(admin, 'pool_payment_mode', 'pay_on_close')
  return v === 'block_capture' ? 'block_capture' : 'pay_on_close'
}

export async function getPoolOpenLimits(admin: Admin): Promise<{ minOpenHours: number; maxOpenDays: number }> {
  const v = await getMartSetting<{ min_open_hours?: number; max_open_days?: number }>(admin, 'pool_open_limits', {})
  return { minOpenHours: Number(v.min_open_hours ?? 24), maxOpenDays: Number(v.max_open_days ?? 30) }
}

// ── Reads ────────────────────────────────────────────────────────────────────

const POOL_SELECT =
  'id, product_id, category_slug, spec, title, unit, target_qty, min_qty, unit_price_paise, closes_at, status, seller_id, ' +
  'created_by, approved_at, closed_at, rationale, card_i18n, created_at, ' +
  'product:products(id, name, images, list_price_paise, gst_rate_bps, hsn_code, min_order_qty, unit, status), ' +
  'seller:provider_profiles(id, display_name, slug, city, state)'

/** A pool as the server sees it — 'draft' precedes the §4.4 machine (agent-drafted, founder approves). */
export type PoolRowStatus = PoolStatus | 'draft'

export interface PoolDetail extends Omit<PoolSummary, 'status'> {
  status: PoolRowStatus
  imageUrl: string | null
  seller: { id: string; displayName: string; slug: string; city: string | null; state: string } | null
  productName: string | null
  gstRateBps: number | null
  closedAt: string | null
  cardI18n: Record<string, string> | null
  rationale: Record<string, unknown>
  createdAt: string
}

/** committed qty + member count per pool (commitments that still stand or were honoured). */
export async function poolCounts(admin: Admin, poolIds: string[]): Promise<Map<string, { committed_qty: number; member_count: number }>> {
  const out = new Map<string, { committed_qty: number; member_count: number }>()
  if (poolIds.length === 0) return out
  const { data } = await admin
    .from('pool_members')
    .select('pool_id, qty, payment_state')
    .in('pool_id', poolIds)
    .in('payment_state', ['blocked', 'captured'])
  for (const m of data ?? []) {
    const cur = out.get(m.pool_id) ?? { committed_qty: 0, member_count: 0 }
    cur.committed_qty += Number(m.qty)
    cur.member_count += 1
    out.set(m.pool_id, cur)
  }
  return out
}

export function mapPool(r: any, counts: { committed_qty: number; member_count: number } | undefined): PoolDetail {
  const product = Array.isArray(r.product) ? r.product[0] : r.product
  const seller = Array.isArray(r.seller) ? r.seller[0] : r.seller
  const listPrice = product?.list_price_paise != null ? Number(product.list_price_paise) : null
  return {
    id: r.id,
    product_id: r.product_id ?? null,
    category_slug: r.category_slug,
    spec: r.spec ?? null,
    title: r.title,
    unit: r.unit,
    target_qty: Number(r.target_qty),
    min_qty: Number(r.min_qty),
    unit_price_paise: Number(r.unit_price_paise),
    list_price_paise: listPrice && listPrice > 0 ? listPrice : null,
    closes_at: r.closes_at,
    status: r.status as PoolRowStatus,
    seller_id: r.seller_id ?? null,
    committed_qty: counts?.committed_qty ?? 0,
    member_count: counts?.member_count ?? 0,
    imageUrl: product?.images?.[0] ? publicAssetUrl(product.images[0]) : null,
    seller: seller ? { id: seller.id, displayName: seller.display_name, slug: seller.slug, city: seller.city ?? null, state: seller.state ?? '' } : null,
    productName: product?.name ?? null,
    gstRateBps: product?.gst_rate_bps != null ? Number(product.gst_rate_bps) : null,
    closedAt: r.closed_at ?? null,
    cardI18n: r.card_i18n ?? null,
    rationale: r.rationale ?? {},
    createdAt: r.created_at,
  }
}

export async function listPools(
  admin: Admin,
  opts: { statuses?: PoolRowStatus[]; category?: string; limit?: number } = {},
): Promise<PoolDetail[]> {
  let q = admin.from('pools').select(POOL_SELECT).is('deleted_at', null).order('closes_at', { ascending: true }).limit(opts.limit ?? 50)
  if (opts.statuses && opts.statuses.length > 0) q = q.in('status', opts.statuses as string[])
  if (opts.category) q = q.eq('category_slug', opts.category)
  const { data } = await q
  const rows = data ?? []
  const counts = await poolCounts(admin, rows.map((r: any) => r.id))
  return rows.map((r: any) => mapPool(r, counts.get(r.id)))
}

/** Open pools first (soonest close), then recently closed — the public list. */
export async function listPublicPools(admin: Admin, category?: string, limit = 24): Promise<PoolDetail[]> {
  const pools = await listPools(admin, { statuses: ['open', 'closed_met', 'ordered', 'fulfilled', 'closed_unmet'], ...(category ? { category } : {}), limit: 100 })
  const rank: Record<string, number> = { open: 0, closed_met: 1, ordered: 1, fulfilled: 2, closed_unmet: 3 }
  return pools.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9)).slice(0, limit)
}

export async function getPool(admin: Admin, id: string): Promise<PoolDetail | null> {
  const { data } = await admin.from('pools').select(POOL_SELECT).eq('id', id).is('deleted_at', null).maybeSingle()
  if (!data) return null
  const counts = await poolCounts(admin, [id])
  return mapPool(data, counts.get(id))
}

export interface PoolMemberRow {
  id: string
  pool_id: string
  msme_id: string
  user_id: string
  qty: number
  payment_state: PoolMemberPaymentState
  delivery_snapshot: Record<string, unknown>
  gst_invoice: Record<string, unknown> | null
  checkout_session_id: string | null
  order_id: string | null
  pay_by: string | null
  committed_at: string
  captured_at: string | null
  released_at: string | null
  failed_at: string | null
}

export async function getMember(admin: Admin, poolId: string, msmeId: string): Promise<PoolMemberRow | null> {
  const { data } = await admin.from('pool_members').select('*').eq('pool_id', poolId).eq('msme_id', msmeId).maybeSingle()
  return (data as PoolMemberRow | null) ?? null
}

export async function listMembers(admin: Admin, poolId: string): Promise<PoolMemberRow[]> {
  const { data } = await admin.from('pool_members').select('*').eq('pool_id', poolId).order('committed_at', { ascending: true })
  return (data ?? []) as PoolMemberRow[]
}

/** The public card text in the pool's locale-specific voice (numbers from the row). */
export function poolCardText(pool: PoolDetail, locale: 'en' | 'hi' | 'te', url: string): string {
  const base = buildPoolCardText(
    {
      title: pool.title,
      unit: pool.unit,
      unitPricePaise: pool.unit_price_paise,
      listPricePaise: pool.list_price_paise,
      committedQty: pool.committed_qty,
      minQty: pool.min_qty,
      targetQty: pool.target_qty,
      memberCount: pool.member_count,
      closesAt: pool.closes_at,
      url,
      sellerName: pool.seller?.displayName ?? null,
    },
    locale,
  )
  const pitch = pool.cardI18n?.[locale] ?? pool.cardI18n?.['en']
  return pitch ? `${pitch}\n${base}` : base
}

// ── Drafts and opening ───────────────────────────────────────────────────────

export async function createDraftPool(
  admin: Admin,
  draft: PoolDraft,
  createdBy: string | null,
  cardI18n?: Record<string, string> | null,
): Promise<{ id: string }> {
  let sellerId: string | null = null
  if (draft.product_id) {
    const { data: p } = await admin.from('products').select('seller_id').eq('id', draft.product_id).maybeSingle()
    sellerId = p?.seller_id ?? null
  }
  const { data, error } = await admin
    .from('pools')
    .insert({
      product_id: draft.product_id,
      category_slug: draft.category_slug,
      spec: draft.spec,
      title: draft.title,
      unit: draft.unit,
      target_qty: draft.target_qty,
      min_qty: draft.min_qty,
      unit_price_paise: draft.unit_price_paise,
      closes_at: draft.closes_at,
      status: 'draft',
      seller_id: sellerId,
      created_by: createdBy,
      rationale: draft.rationale,
      card_i18n: cardI18n ?? null,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`createDraftPool: ${error?.message}`)
  await addPoolEvent(admin, data.id, 'drafted', { actorId: createdBy, payload: { rationale: draft.rationale } })
  return { id: data.id }
}

export type PoolActionResult = { ok: true; pool: PoolDetail } | { ok: false; status: number; error: string }

/**
 * draft → open. The founder may correct any term first; validation is the
 * shared poolOpenProblem (product required, min ≤ target, close window,
 * price below list). The seller is the product's seller.
 */
export async function approveAndOpenPool(admin: Admin, poolId: string, edits: PoolOpenInput, adminId: string, cardI18n?: Record<string, string> | null): Promise<PoolActionResult> {
  const pool = await getPool(admin, poolId)
  if (!pool) return { ok: false, status: 404, error: 'not_found' }
  if (pool.status !== 'draft') return { ok: false, status: 409, error: 'not_draft' }
  const next = {
    product_id: pool.product_id,
    min_qty: edits.min_qty ?? pool.min_qty,
    target_qty: edits.target_qty ?? pool.target_qty,
    unit_price_paise: edits.unit_price_paise ?? pool.unit_price_paise,
    closes_at: edits.closes_at ?? pool.closes_at,
    list_price_paise: pool.list_price_paise,
  }
  const problem = poolOpenProblem(next, new Date(), await getPoolOpenLimits(admin))
  if (problem) return { ok: false, status: 422, error: problem }
  const { data: product } = await admin.from('products').select('seller_id, status').eq('id', pool.product_id!).maybeSingle()
  if (!product || product.status !== 'active') return { ok: false, status: 422, error: 'product_unavailable' }
  const { data, error } = await admin
    .from('pools')
    .update({
      ...(edits.title ? { title: edits.title } : {}),
      min_qty: next.min_qty,
      target_qty: next.target_qty,
      unit_price_paise: next.unit_price_paise,
      closes_at: next.closes_at,
      seller_id: product.seller_id,
      status: 'open',
      approved_by: adminId,
      approved_at: new Date().toISOString(),
      ...(cardI18n !== undefined ? { card_i18n: cardI18n } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('id', poolId)
    .eq('status', 'draft')
    .select('id')
  if (error || !data?.length) return { ok: false, status: 409, error: 'not_draft' }
  await addPoolEvent(admin, poolId, 'approved', { actorId: adminId, payload: { edits } })
  await addPoolEvent(admin, poolId, 'opened', { actorId: adminId })
  return { ok: true, pool: (await getPool(admin, poolId))! }
}

/** Release every standing commitment (unmet / cancelled). Returns the released members. */
async function releaseAll(admin: Admin, poolId: string, reason: string, actorId: string | null): Promise<PoolMemberRow[]> {
  const members = (await listMembers(admin, poolId)).filter((m) => m.payment_state === 'blocked')
  const now = new Date().toISOString()
  for (const m of members) {
    if (!isValidPoolMemberPaymentTransition(m.payment_state, 'released')) continue
    await admin.from('pool_members').update({ payment_state: 'released', released_at: now, updated_at: now }).eq('id', m.id).eq('payment_state', 'blocked')
    await addPoolEvent(admin, poolId, 'released', { memberId: m.id, actorId, payload: { reason } })
  }
  return members
}

export async function cancelPool(admin: Admin, poolId: string, adminId: string, reason: string): Promise<PoolActionResult> {
  const pool = await getPool(admin, poolId)
  if (!pool) return { ok: false, status: 404, error: 'not_found' }
  if (pool.status === 'draft') {
    await admin.from('pools').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', poolId).eq('status', 'draft')
    await addPoolEvent(admin, poolId, 'cancelled', { actorId: adminId, payload: { reason } })
    return { ok: true, pool: (await getPool(admin, poolId))! }
  }
  try {
    assertPoolTransition(pool.status as PoolStatus, 'cancelled')
  } catch {
    return { ok: false, status: 409, error: 'illegal_transition' }
  }
  const { data } = await admin
    .from('pools')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', poolId)
    .eq('status', pool.status)
    .select('id')
  if (!data?.length) return { ok: false, status: 409, error: 'illegal_transition' }
  await addPoolEvent(admin, poolId, 'cancelled', { actorId: adminId, payload: { reason } })
  const released = await releaseAll(admin, poolId, 'cancelled', adminId)
  await notifyMembers(admin, pool, released, 'pool_cancelled')
  return { ok: true, pool: (await getPool(admin, poolId))! }
}

// ── Membership ───────────────────────────────────────────────────────────────

export type JoinResult =
  | { ok: true; member: PoolMemberRow; pool: PoolDetail; changed: boolean }
  | { ok: false; status: number; error: string }

export async function joinPool(
  admin: Admin,
  args: { poolId: string; userId: string; msmeId: string; input: PoolJoinInput },
): Promise<JoinResult> {
  const pool = await getPool(admin, args.poolId)
  if (!pool) return { ok: false, status: 404, error: 'not_found' }
  if (pool.status !== 'open' || poolIsDueToClose('open', pool.closes_at)) return { ok: false, status: 409, error: 'pool_closed' }
  if ((await getPoolPaymentMode(admin)) === 'block_capture') {
    // ADR-006: the block-and-capture adapter is NOT live until the PSP report's
    // live verification passes; refusing here is the only safe behaviour.
    return { ok: false, status: 503, error: 'block_capture_not_live' }
  }
  const existing = await getMember(admin, args.poolId, args.msmeId)
  const now = new Date().toISOString()
  if (existing) {
    if (existing.payment_state === 'captured' || existing.payment_state === 'failed') return { ok: false, status: 409, error: 'already_settled' }
    // Re-join after leaving, or change quantity while open.
    const changed = existing.qty !== args.input.qty || existing.payment_state !== 'blocked'
    const { data, error } = await admin
      .from('pool_members')
      .update({
        qty: args.input.qty,
        payment_state: 'blocked',
        delivery_snapshot: args.input.delivery,
        gst_invoice: args.input.gstInvoice ?? null,
        released_at: null,
        committed_at: existing.payment_state === 'released' ? now : existing.committed_at,
        updated_at: now,
      })
      .eq('id', existing.id)
      .select('*')
      .single()
    if (error || !data) return { ok: false, status: 500, error: 'update_failed' }
    await addPoolEvent(admin, args.poolId, existing.payment_state === 'released' ? 'joined' : 'qty_changed', {
      memberId: existing.id,
      actorId: args.userId,
      payload: { qty: args.input.qty, previous_qty: existing.qty },
    })
    return { ok: true, member: data as PoolMemberRow, pool: (await getPool(admin, args.poolId))!, changed }
  }
  const { data, error } = await admin
    .from('pool_members')
    .insert({
      pool_id: args.poolId,
      msme_id: args.msmeId,
      user_id: args.userId,
      qty: args.input.qty,
      payment_state: 'blocked',
      delivery_snapshot: args.input.delivery,
      gst_invoice: args.input.gstInvoice ?? null,
    })
    .select('*')
    .single()
  if (error || !data) return { ok: false, status: 500, error: 'insert_failed' }
  await addPoolEvent(admin, args.poolId, 'joined', { memberId: data.id, actorId: args.userId, payload: { qty: args.input.qty } })
  return { ok: true, member: data as PoolMemberRow, pool: (await getPool(admin, args.poolId))!, changed: true }
}

export async function leavePool(admin: Admin, args: { poolId: string; userId: string; msmeId: string }): Promise<PoolActionResult> {
  const pool = await getPool(admin, args.poolId)
  if (!pool) return { ok: false, status: 404, error: 'not_found' }
  const member = await getMember(admin, args.poolId, args.msmeId)
  if (!member) return { ok: false, status: 404, error: 'not_member' }
  if (pool.status !== 'open' || !poolMemberMayLeave('open', member.payment_state)) return { ok: false, status: 409, error: 'cannot_leave' }
  const now = new Date().toISOString()
  await admin.from('pool_members').update({ payment_state: 'released', released_at: now, updated_at: now }).eq('id', member.id).eq('payment_state', 'blocked')
  await addPoolEvent(admin, args.poolId, 'left', { memberId: member.id, actorId: args.userId })
  return { ok: true, pool: (await getPool(admin, args.poolId))! }
}

// ── Close ────────────────────────────────────────────────────────────────────

/**
 * open → closed_met | closed_unmet by committed qty vs min. Idempotent and
 * race-safe: the status update is guarded on status='open', so a second
 * caller (cron overlap, admin "close now" during the cron) is a no-op.
 */
export async function closePool(admin: Admin, poolId: string, actorId: string | null, force = false): Promise<PoolActionResult> {
  const pool = await getPool(admin, poolId)
  if (!pool) return { ok: false, status: 404, error: 'not_found' }
  if (pool.status !== 'open') return { ok: false, status: 409, error: 'not_open' }
  if (!force && !poolIsDueToClose('open', pool.closes_at)) return { ok: false, status: 409, error: 'not_due' }
  const outcome = poolCloseOutcome(pool.committed_qty, pool.min_qty)
  assertPoolTransition('open', outcome)
  const now = new Date()
  const { data } = await admin
    .from('pools')
    .update({ status: outcome, closed_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('id', poolId)
    .eq('status', 'open')
    .select('id')
  if (!data?.length) return { ok: false, status: 409, error: 'not_open' }
  await addPoolEvent(admin, poolId, outcome, { actorId, payload: { committed_qty: pool.committed_qty, min_qty: pool.min_qty, member_count: pool.member_count, forced: force } })

  if (outcome === 'closed_unmet') {
    const released = await releaseAll(admin, poolId, 'closed_unmet', actorId)
    await notifyMembers(admin, pool, released, 'pool_unmet')
    return { ok: true, pool: (await getPool(admin, poolId))! }
  }

  // closed_met: every standing member now owes a goods order inside the window.
  const payBy = poolPayDeadline(now, await getPoolPayWindowHours(admin)).toISOString()
  const members = (await listMembers(admin, poolId)).filter((m) => m.payment_state === 'blocked')
  await admin.from('pool_members').update({ pay_by: payBy, updated_at: now.toISOString() }).eq('pool_id', poolId).eq('payment_state', 'blocked')
  await notifyMembers(admin, { ...pool, status: 'closed_met' }, members, 'pool_met', { pay_by: payBy })
  await notifySeller(admin, pool, 'pool_met', { members: members.length, committed_qty: pool.committed_qty })
  return { ok: true, pool: (await getPool(admin, poolId))! }
}

/** Cron: close every open pool whose closes_at has passed. */
export async function closeDuePools(admin: Admin, now = new Date()): Promise<{ checked: number; closed_met: number; closed_unmet: number }> {
  const { data } = await admin.from('pools').select('id').eq('status', 'open').lte('closes_at', now.toISOString()).is('deleted_at', null).limit(200)
  const result = { checked: data?.length ?? 0, closed_met: 0, closed_unmet: 0 }
  for (const row of data ?? []) {
    const r = await closePool(admin, row.id, null)
    if (r.ok) {
      if (r.pool.status === 'closed_met') result.closed_met++
      else if (r.pool.status === 'closed_unmet') result.closed_unmet++
    }
  }
  return result
}

// ── Pay-on-close: the member's goods order ──────────────────────────────────

/** Deterministic idempotency key: the same (pool, member) always maps to ONE checkout session. */
export function poolMemberIdempotencyKey(poolId: string, memberId: string): string {
  const h = createHash('sha256').update(`amc-pool:${poolId}:${memberId}`).digest('hex')
  // RFC 4122 v4-shaped from the hash so the uuid column accepts it.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export interface PoolMemberCheckout {
  sessionId: string
  memberId: string
  amounts: { taxablePaise: number; gstPaise: number; totalPaise: number; afterItcPaise: number }
  lineItems: GoodsLineItem[]
  sellerId: string
  sellerName: string
  deliveryDays: number
  payBy: string | null
}

/**
 * Build (or return) the member's goods checkout session at the POOL price.
 * The money rule is enforced here and nowhere else: a session is created
 * only when mayCapturePoolMember(pool.status, member.payment_state) — i.e. the
 * pool closed met and the member still stands. Replays return the same
 * session (idempotency key), so double-tapping "Pay" or a cron overlap can
 * never create two orders for one member.
 */
export async function prepareMemberCheckout(
  admin: Admin,
  args: { poolId: string; msmeId: string },
): Promise<{ ok: true; checkout: PoolMemberCheckout } | { ok: false; status: number; error: string }> {
  const pool = await getPool(admin, args.poolId)
  if (!pool) return { ok: false, status: 404, error: 'not_found' }
  const member = await getMember(admin, args.poolId, args.msmeId)
  if (!member) return { ok: false, status: 404, error: 'not_member' }
  if (pool.status === 'draft' || !mayCapturePoolMember(pool.status, member.payment_state)) {
    return { ok: false, status: 409, error: pool.status === 'closed_met' ? `member_${member.payment_state}` : `pool_${pool.status}` }
  }
  if (member.pay_by && new Date(member.pay_by).getTime() < Date.now()) return { ok: false, status: 409, error: 'pay_window_lapsed' }
  if (!pool.product_id || !pool.seller_id || pool.gstRateBps == null) return { ok: false, status: 422, error: 'product_unavailable' }

  const { data: product } = await admin
    .from('products')
    .select('id, name, unit, hsn_code, gst_rate_bps, category_slug, status, deleted_at, seller:provider_profiles!inner(id, display_name, status, sells_goods, deleted_at)')
    .eq('id', pool.product_id)
    .maybeSingle()
  const seller = Array.isArray(product?.seller) ? product?.seller[0] : product?.seller
  if (!product || product.status !== 'active' || product.deleted_at || !seller || seller.status !== 'active' || !seller.sells_goods) {
    return { ok: false, status: 422, error: 'product_unavailable' }
  }
  const cat = await getMartCategory(admin, product.category_slug)
  if (!cat || !cat.is_active || cat.bis_blocked) return { ok: false, status: 422, error: 'category_blocked' }

  const gstRateBps = Number(product.gst_rate_bps)
  const taxable = member.qty * pool.unit_price_paise
  const lineItems: GoodsLineItem[] = [
    {
      product_id: product.id,
      name: product.name,
      unit: product.unit,
      qty: member.qty,
      tier_min_qty: pool.min_qty,
      tier_unit_price_paise: pool.unit_price_paise,
      hsn_code: product.hsn_code,
      gst_rate_bps: gstRateBps as GoodsLineItem['gst_rate_bps'],
      line_taxable_paise: taxable,
      line_gst_paise: Math.round((taxable * gstRateBps) / 10000),
    },
  ]
  const amounts = computeGoodsOrderAmounts({ lines: [{ qty: member.qty, unitPricePaise: pool.unit_price_paise, gstRateBps, commissionBps: cat.commission_bps }], commissionBps: cat.commission_bps })
  const deliveryDays = Number(await getMartSetting<number | string>(admin, 'goods_delivery_days', 3))
  const idempotencyKey = poolMemberIdempotencyKey(pool.id, member.id)

  const { data: existing } = await admin.from('checkout_sessions').select('id').eq('idempotency_key', idempotencyKey).maybeSingle()
  let sessionId = existing?.id as string | undefined
  if (!sessionId) {
    const { data: session, error } = await admin
      .from('checkout_sessions')
      .upsert(
        {
          msme_id: member.msme_id,
          provider_id: pool.seller_id,
          source: 'catalog',
          package_id: null,
          quote_id: null,
          title: `${member.qty} ${product.unit} ${product.name} (group buy)`,
          scope_snapshot: { kind: 'goods', pool_id: pool.id, pool_member_id: member.id, seller_name: seller.display_name, categories: [cat.slug] },
          price_paise: amounts.pricePaise,
          discount_paise: 0,
          gst_paise: amounts.gstPaise,
          total_paise: amounts.totalPaise,
          commission_bps: amounts.commissionBps,
          commission_paise: amounts.commissionPaise,
          provider_earning_paise: amounts.providerEarningPaise,
          delivery_days: deliveryDays,
          revision_max: null,
          coupon_code: null,
          gst_invoice: member.gst_invoice,
          kind: 'goods',
          line_items: lineItems,
          delivery_snapshot: member.delivery_snapshot,
          idempotency_key: idempotencyKey,
          status: 'created',
          // Sessions normally expire in 30 min; a pool member has the pay window.
          expires_at: member.pay_by ?? new Date(Date.now() + 48 * 3_600_000).toISOString(),
        },
        { onConflict: 'idempotency_key', ignoreDuplicates: true },
      )
      .select('id')
      .maybeSingle()
    if (error) return { ok: false, status: 500, error: 'session_failed' }
    sessionId = session?.id ?? (await admin.from('checkout_sessions').select('id').eq('idempotency_key', idempotencyKey).maybeSingle()).data?.id
    if (!sessionId) return { ok: false, status: 500, error: 'session_failed' }
    await admin.from('pool_members').update({ checkout_session_id: sessionId, updated_at: new Date().toISOString() }).eq('id', member.id).is('checkout_session_id', null)
    await addPoolEvent(admin, pool.id, 'capture_attempted', { memberId: member.id, actorId: member.user_id, payload: { checkout_session_id: sessionId, total_paise: amounts.totalPaise } })
  }
  return {
    ok: true,
    checkout: {
      sessionId,
      memberId: member.id,
      // E16 N43 — no input credit on an ITC-ineligible category (shared goodsItcSplit).
      amounts: { taxablePaise: amounts.taxablePaise, gstPaise: amounts.gstPaise, totalPaise: amounts.totalPaise, afterItcPaise: goodsItcSplit([{ gstPaise: amounts.gstPaise, itcEligible: cat.itc_eligible !== false }], amounts.totalPaise).afterItcPaise },
      lineItems,
      sellerId: pool.seller_id,
      sellerName: seller.display_name,
      deliveryDays,
      payBy: member.pay_by,
    },
  }
}

// ── Settlement (cron + on-demand) ────────────────────────────────────────────

/**
 * For a closed_met pool: members whose session materialised → captured (+
 * order link); members past pay_by still unpaid → failed (a DEFAULT). When no
 * member still stands: any captured → ordered (seller gets the allocation
 * list); none → cancelled. ordered → fulfilled once every member order is
 * completed. Idempotent: every write is guarded on the state it expects.
 */
export async function settlePool(admin: Admin, poolId: string, now = new Date()): Promise<{ captured: number; defaulted: number; status: PoolRowStatus }> {
  const pool = await getPool(admin, poolId)
  const out = { captured: 0, defaulted: 0, status: (pool?.status ?? 'cancelled') as PoolRowStatus }
  if (!pool) return out
  if (pool.status === 'closed_met') {
    const members = await listMembers(admin, poolId)
    for (const m of members) {
      if (m.payment_state !== 'blocked') continue
      if (m.checkout_session_id) {
        const { data: s } = await admin.from('checkout_sessions').select('order_id, status').eq('id', m.checkout_session_id).maybeSingle()
        if (s?.order_id) {
          // mayCapturePoolMember is the guard: pool closed_met + member blocked.
          if (!mayCapturePoolMember(pool.status, m.payment_state)) continue
          const { data } = await admin
            .from('pool_members')
            .update({ payment_state: 'captured', order_id: s.order_id, captured_at: now.toISOString(), updated_at: now.toISOString() })
            .eq('id', m.id)
            .eq('payment_state', 'blocked')
            .select('id')
          if (data?.length) {
            out.captured++
            await addPoolEvent(admin, poolId, 'captured', { memberId: m.id, payload: { order_id: s.order_id } })
          }
          continue
        }
      }
      if (m.pay_by && new Date(m.pay_by).getTime() < now.getTime()) {
        const { data } = await admin
          .from('pool_members')
          .update({ payment_state: 'failed', failed_at: now.toISOString(), updated_at: now.toISOString() })
          .eq('id', m.id)
          .eq('payment_state', 'blocked')
          .select('id')
        if (data?.length) {
          out.defaulted++
          await addPoolEvent(admin, poolId, 'capture_failed', { memberId: m.id, payload: { reason: 'pay_window_lapsed', pay_by: m.pay_by } })
          await addPoolEvent(admin, poolId, 'defaulted', { memberId: m.id })
          await notifyMembers(admin, pool, [m], 'pool_defaulted')
        }
      }
    }
    const after = await listMembers(admin, poolId)
    const standing = after.some((m) => m.payment_state === 'blocked')
    if (!standing) {
      const captured = after.filter((m) => m.payment_state === 'captured')
      const next: PoolStatus = captured.length > 0 ? 'ordered' : 'cancelled'
      assertPoolTransition('closed_met', next)
      const { data } = await admin.from('pools').update({ status: next, updated_at: now.toISOString() }).eq('id', poolId).eq('status', 'closed_met').select('id')
      if (data?.length) {
        out.status = next
        await addPoolEvent(admin, poolId, next === 'ordered' ? 'ordered' : 'cancelled', { payload: { captured: captured.length, total_qty: captured.reduce((s, m) => s + m.qty, 0) } })
        if (next === 'ordered') await notifySeller(admin, pool, 'pool_ordered', { members: captured.length, qty: captured.reduce((s, m) => s + m.qty, 0) })
      }
    }
    return out
  }
  if (pool.status === 'ordered') {
    const members = (await listMembers(admin, poolId)).filter((m) => m.payment_state === 'captured')
    const orderIds = members.map((m) => m.order_id).filter((x): x is string => !!x)
    if (orderIds.length > 0) {
      const { data: orders } = await admin.from('orders').select('id, status').in('id', orderIds)
      const allDone = (orders ?? []).length === orderIds.length && (orders ?? []).every((o: any) => ['completed', 'reviewed', 'resolved_release', 'resolved_partial'].includes(o.status))
      if (allDone) {
        assertPoolTransition('ordered', 'fulfilled')
        const { data } = await admin.from('pools').update({ status: 'fulfilled', updated_at: now.toISOString() }).eq('id', poolId).eq('status', 'ordered').select('id')
        if (data?.length) {
          out.status = 'fulfilled'
          await addPoolEvent(admin, poolId, 'fulfilled', {})
        }
      }
    }
  }
  return out
}

export async function settleOpenSettlements(admin: Admin, now = new Date()): Promise<{ pools: number; captured: number; defaulted: number }> {
  const { data } = await admin.from('pools').select('id').in('status', ['closed_met', 'ordered']).is('deleted_at', null).limit(200)
  const out = { pools: data?.length ?? 0, captured: 0, defaulted: 0 }
  for (const row of data ?? []) {
    const r = await settlePool(admin, row.id, now)
    out.captured += r.captured
    out.defaulted += r.defaulted
  }
  return out
}

/** Admin: ordered → fulfilled by hand (e.g. offline completion). */
export async function fulfilPool(admin: Admin, poolId: string, adminId: string): Promise<PoolActionResult> {
  const pool = await getPool(admin, poolId)
  if (!pool) return { ok: false, status: 404, error: 'not_found' }
  try {
    assertPoolTransition(pool.status as PoolStatus, 'fulfilled')
  } catch {
    return { ok: false, status: 409, error: 'illegal_transition' }
  }
  const { data } = await admin.from('pools').update({ status: 'fulfilled', updated_at: new Date().toISOString() }).eq('id', poolId).eq('status', 'ordered').select('id')
  if (!data?.length) return { ok: false, status: 409, error: 'illegal_transition' }
  await addPoolEvent(admin, poolId, 'fulfilled', { actorId: adminId })
  return { ok: true, pool: (await getPool(admin, poolId))! }
}

// ── Discipline (§4.5) ────────────────────────────────────────────────────────

export async function buyerDiscipline(admin: Admin, msmeId: string): Promise<{ due: number; honoured: number; defaulted: number; commitments: number }> {
  const { data } = await admin.from('buyer_pool_discipline_v1').select('due, honoured, defaulted, commitments').eq('msme_id', msmeId).maybeSingle()
  return {
    due: Number(data?.due ?? 0),
    honoured: Number(data?.honoured ?? 0),
    defaulted: Number(data?.defaulted ?? 0),
    commitments: Number(data?.commitments ?? 0),
  }
}

// ── Notifications ────────────────────────────────────────────────────────────

type PoolNotifyKind = 'pool_met' | 'pool_unmet' | 'pool_cancelled' | 'pool_defaulted' | 'pool_ordered'

function fmtIst(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
}

async function notifyMembers(admin: Admin, pool: PoolDetail, members: PoolMemberRow[], kind: PoolNotifyKind, extra: { pay_by?: string } = {}): Promise<void> {
  const copy: Record<PoolNotifyKind, { en: [string, string]; hi: [string, string]; link: string; channels: string[] }> = {
    pool_met: {
      en: ['Group buy is on — pay to confirm', `${pool.title}: the pool reached its minimum. Pay your share by ${extra.pay_by ? fmtIst(extra.pay_by) : 'the deadline'} to confirm your order.`],
      hi: ['ग्रुप बाय तय — भुगतान करें', `${pool.title}: पूल का न्यूनतम पूरा हुआ। ${extra.pay_by ? fmtIst(extra.pay_by) : 'समय सीमा'} तक भुगतान कर ऑर्डर पक्का करें।`],
      link: `/app/mart/pools/${pool.id}/pay`,
      channels: ['whatsapp', 'sms', 'email'],
    },
    pool_unmet: {
      en: ['Group buy did not reach its minimum', `${pool.title} closed short of the minimum quantity. Nothing is charged; your commitment is released.`],
      hi: ['ग्रुप बाय न्यूनतम तक नहीं पहुँचा', `${pool.title} न्यूनतम मात्रा से कम पर बंद हुआ। कोई शुल्क नहीं; आपकी प्रतिबद्धता मुक्त कर दी गई।`],
      link: `/mart/pools/${pool.id}`,
      channels: ['whatsapp', 'email'],
    },
    pool_cancelled: {
      en: ['Group buy cancelled', `${pool.title} was cancelled by AMC. Nothing is charged.`],
      hi: ['ग्रुप बाय रद्द', `${pool.title} AMC द्वारा रद्द किया गया। कोई शुल्क नहीं।`],
      link: `/mart/pools/${pool.id}`,
      channels: ['whatsapp', 'email'],
    },
    pool_defaulted: {
      en: ['Pool commitment lapsed', `You did not pay for ${pool.title} inside the window. The commitment is recorded as lapsed on your buyer record.`],
      hi: ['पूल प्रतिबद्धता चूक गई', `${pool.title} के लिए समय सीमा में भुगतान नहीं हुआ। यह आपके खरीदार रिकॉर्ड में दर्ज है।`],
      link: `/app/mart/pools`,
      channels: ['email'],
    },
    pool_ordered: { en: ['', ''], hi: ['', ''], link: '', channels: [] },
  }
  const c = copy[kind]
  for (const m of members) {
    await createNotification(admin, {
      userId: m.user_id,
      kind,
      titleI18n: { en: c.en[0], hi: c.hi[0] },
      bodyI18n: { en: c.en[1], hi: c.hi[1] },
      link: c.link,
      channels: c.channels,
    })
  }
}

async function notifySeller(admin: Admin, pool: PoolDetail, kind: 'pool_met' | 'pool_ordered', extra: { members: number; committed_qty?: number; qty?: number }): Promise<void> {
  if (!pool.seller_id) return
  const { data: p } = await admin.from('provider_profiles').select('user_id').eq('id', pool.seller_id).maybeSingle()
  if (!p?.user_id) return
  const en =
    kind === 'pool_met'
      ? [`Group buy met: ${pool.title}`, `${extra.members} buyers committed ${extra.committed_qty} ${pool.unit}. Their orders arrive as they pay over the next two days.`]
      : [`Group buy ordered: ${pool.title}`, `${extra.members} paid orders totalling ${extra.qty} ${pool.unit}. Accept and dispatch them from your orders.`]
  await createNotification(admin, {
    userId: p.user_id,
    kind,
    titleI18n: { en: en[0]!, hi: en[0]! },
    bodyI18n: { en: en[1]!, hi: en[1]! },
    link: '/partner/goods/pools',
    channels: ['whatsapp', 'email'],
  })
}

/** Progress shape for clients (server computes; clients render). */
export function poolProgressFor(pool: Pick<PoolSummary, 'committed_qty' | 'min_qty' | 'target_qty'>) {
  return poolProgress(pool.committed_qty, pool.min_qty, pool.target_qty)
}
