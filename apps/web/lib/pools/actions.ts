import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  redactContactInfo,
  POOL_MEMBER_ACTION_MAP,
  memberActionAllowed,
  poolClosesAt,
  poolTierProblems,
  type PoolMemberAction,
  type PoolMemberStatus,
  type PoolOfferInput,
  type ServicePoolStatus,
} from '@amclub/shared'
import { recordAiDecision } from '@/lib/mart/events'
import { createNotification, createNotificationsBulk } from '@/lib/notifications/create'
import { notifyText } from '@/lib/i18n/notify'
import { captureServerEvent } from '@/lib/analytics/server'
import { addPoolEvent, chunks, cohortUserIds, loadPool, poolSettings, providerUsers, type PoolRow } from './core'
import { providerOwnsRequest } from '@/lib/orders/self-dealing'

/**
 * S3.4 (ADR 024) — every pool move a person makes. Each write is guarded on the status it expects (a replay or a
 * race changes nothing), and each returns a typed outcome the route maps to HTTP. Money never moves here: the only
 * money-adjacent step is the close (close.ts), which writes ordinary quotes.
 */

export type PoolActionError =
  | 'not_found'
  | 'not_allowed'
  | 'conflict'
  | 'rfq_closed'
  | 'too_late'
  | 'offer_unavailable'
  | 'not_eligible'
  | 'offer_exists'
  | 'tiers_incoherent'
  | 'validity_too_short'
  | 'pool_not_open'
  | 'failed'

export type PoolActionResult<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; error: PoolActionError; detail?: unknown }

const STATUS: Record<PoolActionError, number> = {
  not_found: 404,
  not_allowed: 409,
  conflict: 409,
  rfq_closed: 409,
  too_late: 409,
  offer_unavailable: 409,
  not_eligible: 403,
  offer_exists: 409,
  tiers_incoherent: 400,
  validity_too_short: 422,
  pool_not_open: 409,
  failed: 500,
}
export const poolErrorStatus = (e: PoolActionError): number => STATUS[e]

interface MemberRow {
  id: string
  pool_id: string
  rfq_id: string
  msme_id: string
  status: PoolMemberStatus
  committed_offer_id: string | null
  claim_state: string | null
  quote_id: string | null
}
const MEMBER_COLS = 'id, pool_id, rfq_id, msme_id, status, committed_offer_id, claim_state, quote_id'

async function loadMember(admin: SupabaseClient, poolId: string, msmeId: string): Promise<MemberRow | null> {
  const { data } = await admin.from('service_pool_members').select(MEMBER_COLS).eq('pool_id', poolId).eq('msme_id', msmeId).maybeSingle()
  return (data as MemberRow | null) ?? null
}

async function rfqWindow(admin: SupabaseClient, rfqId: string): Promise<{ status: string; expires_at: string } | null> {
  const { data } = await admin.from('rfqs').select('status, expires_at').eq('id', rfqId).is('deleted_at', null).maybeSingle()
  return (data as { status: string; expires_at: string } | null) ?? null
}

/** Providers eligible for a pool: fan-out-matched (not declined) to at least one JOINED member, active, in the cohort. */
export async function eligibleProviderIds(admin: SupabaseClient, poolId: string): Promise<string[]> {
  const { data: members } = await admin.from('service_pool_members').select('rfq_id').eq('pool_id', poolId).eq('status', 'joined')
  const rfqIds = ((members ?? []) as Array<{ rfq_id: string }>).map((m) => m.rfq_id)
  if (rfqIds.length === 0) return []
  const ids = new Set<string>()
  for (const part of chunks(rfqIds)) {
    const { data } = await admin.from('rfq_matches').select('provider_id').in('rfq_id', part).is('declined_at', null)
    for (const m of (data ?? []) as Array<{ provider_id: string }>) ids.add(m.provider_id)
  }
  const users = await providerUsers(admin, [...ids])
  const cohort = new Set(await cohortUserIds(admin))
  return [...ids].filter((id) => {
    const u = users.get(id)
    return !!u && u.active && cohort.has(u.userId)
  })
}

async function joinedMembers(admin: SupabaseClient, poolId: string): Promise<Array<{ rfq_id: string; msme_id: string }>> {
  const { data } = await admin.from('service_pool_members').select('rfq_id, msme_id').eq('pool_id', poolId).eq('status', 'joined')
  return (data ?? []) as Array<{ rfq_id: string; msme_id: string }>
}

async function buyerUserIds(admin: SupabaseClient, msmeIds: readonly string[]): Promise<string[]> {
  if (msmeIds.length === 0) return []
  const out: string[] = []
  for (const part of chunks([...msmeIds])) {
    const { data } = await admin.from('msme_profiles').select('user_id').in('id', part)
    out.push(...((data ?? []) as Array<{ user_id: string }>).map((m) => m.user_id))
  }
  return out
}

/** forming → open once enough buyers joined: fix closes_at from the joined members' clocks, then tell providers. */
async function maybeOpen(admin: SupabaseClient, pool: PoolRow, actorUserId: string): Promise<boolean> {
  if (pool.status !== 'forming') return false
  const joined = await joinedMembers(admin, pool.id)
  if (joined.length < pool.min_members) return false
  const s = await poolSettings(admin)
  const expiries: string[] = []
  for (const part of chunks(joined.map((j) => j.rfq_id))) {
    const { data } = await admin.from('rfqs').select('expires_at').in('id', part)
    expiries.push(...((data ?? []) as Array<{ expires_at: string }>).map((r) => r.expires_at))
  }
  const now = new Date()
  const closesAt = poolClosesAt(now, expiries, s.timing)
  const { data: opened } = await admin
    .from('service_pools')
    .update({ status: 'open', opened_at: now.toISOString(), closes_at: closesAt.toISOString() })
    .eq('id', pool.id)
    .eq('status', 'forming')
    .select('id')
  if (!opened?.length) return false
  await addPoolEvent(admin, pool.id, 'opened', actorUserId, { joined: joined.length, closes_at: closesAt.toISOString() })
  const providers = await eligibleProviderIds(admin, pool.id)
  const users = await providerUsers(admin, providers)
  await createNotificationsBulk(admin, providers.map((p) => users.get(p)!.userId), {
    kind: 'pool_open',
    titleI18n: notifyText('pool_open.title'),
    bodyI18n: notifyText('pool_open.body', { n: joined.length }),
    link: `/partner/pools/${pool.id}`,
  })
  await createNotificationsBulk(admin, await buyerUserIds(admin, joined.map((j) => j.msme_id)), {
    kind: 'pool_opened_buyer',
    titleI18n: notifyText('pool_opened_buyer.title'),
    bodyI18n: notifyText('pool_opened_buyer.body', { n: joined.length }),
    link: `/app/pools/${pool.id}`,
  })
  return true
}

// ── buyer: join / leave / dismiss ─────────────────────────────────────────────

export async function memberAction(
  admin: SupabaseClient,
  a: { userId: string; msmeId: string; poolId: string; action: PoolMemberAction },
): Promise<PoolActionResult<{ status: PoolMemberStatus; poolStatus: ServicePoolStatus }>> {
  const pool = await loadPool(admin, a.poolId)
  const member = pool ? await loadMember(admin, a.poolId, a.msmeId) : null
  if (!pool || !member) return { ok: false, error: 'not_found' }
  const poolStatus = pool.status as ServicePoolStatus
  if (!memberActionAllowed(a.action, member.status, poolStatus)) return { ok: false, error: 'not_allowed' }

  if (a.action === 'join') {
    const w = await rfqWindow(admin, member.rfq_id)
    if (!w || (w.status !== 'open' && w.status !== 'quoted') || Date.parse(w.expires_at) <= Date.now()) return { ok: false, error: 'rfq_closed' }
    if (poolStatus === 'open' && pool.closes_at) {
      const s = await poolSettings(admin)
      if (Date.parse(w.expires_at) - s.timing.payBufferHours * 3600_000 < Date.parse(pool.closes_at)) return { ok: false, error: 'too_late' }
    }
  }

  const to = POOL_MEMBER_ACTION_MAP[a.action].to
  const now = new Date().toISOString()
  const patch: Record<string, unknown> = { status: to }
  if (a.action === 'join') patch['joined_at'] = now
  if (a.action === 'leave') Object.assign(patch, { committed_offer_id: null, committed_at: null })
  const { data: moved } = await admin.from('service_pool_members').update(patch).eq('id', member.id).eq('status', member.status).select('id')
  if (!moved?.length) return { ok: false, error: 'conflict' }

  if (a.action === 'join') {
    // The buyer's tap on the agent's proposal: ONE ai_decisions row (feature demand_pool, tool join_pool).
    const decisionId = await recordAiDecision(
      admin,
      a.userId,
      {
        feature: 'demand_pool',
        input_refs: { pool_id: pool.id, rfq_id: member.rfq_id, member_id: member.id },
        proposed: { pool_id: pool.id, service_slug: pool.service_slug, state: pool.state, join: true },
        final: { pool_id: pool.id, service_slug: pool.service_slug, state: pool.state, join: true },
      },
      { runId: null, tool: 'join_pool' },
    )
    if (decisionId) await admin.from('service_pool_members').update({ decision_id: decisionId }).eq('id', member.id)
    else console.error('[pools] ai_decisions row not recorded for join', member.id)
  }
  await addPoolEvent(admin, pool.id, a.action === 'join' ? 'joined' : a.action === 'leave' ? 'left' : 'dismissed', a.userId, { member_id: member.id })
  captureServerEvent(a.userId, `pool_${a.action === 'join' ? 'joined' : a.action === 'leave' ? 'left' : 'dismissed'}`, { pool_id: pool.id })

  let finalPool = poolStatus
  if (a.action === 'join' && (await maybeOpen(admin, pool, a.userId))) finalPool = 'open'
  return { ok: true, status: to, poolStatus: finalPool }
}

// ── buyer: commit to one offer (or none) ──────────────────────────────────────

/** An offer is available to a member unless its provider already quoted, or declined, the member's own request. */
export async function offerAvailableTo(admin: SupabaseClient, providerId: string, rfqId: string): Promise<boolean> {
  const [{ data: q }, { data: m }, own] = await Promise.all([
    admin.from('quotes').select('id').eq('rfq_id', rfqId).eq('provider_id', providerId).maybeSingle(),
    admin.from('rfq_matches').select('declined_at').eq('rfq_id', rfqId).eq('provider_id', providerId).maybeSingle(),
    // Audit M22 (ADR 027) — a buyer's own provider profile never offers to their request.
    providerOwnsRequest(admin, providerId, rfqId),
  ])
  return !q && !(m as { declined_at: string | null } | null)?.declined_at && !own
}

export async function commit(
  admin: SupabaseClient,
  a: { userId: string; msmeId: string; poolId: string; offerId: string | null },
): Promise<PoolActionResult<{ committedOfferId: string | null }>> {
  const pool = await loadPool(admin, a.poolId)
  const member = pool ? await loadMember(admin, a.poolId, a.msmeId) : null
  if (!pool || !member) return { ok: false, error: 'not_found' }
  if (pool.status !== 'open') return { ok: false, error: 'pool_not_open' }
  if (member.status !== 'joined') return { ok: false, error: 'not_allowed' }
  if (a.offerId) {
    const { data: offer } = await admin.from('service_pool_offers').select('id, pool_id, provider_id, status').eq('id', a.offerId).maybeSingle()
    const o = offer as { id: string; pool_id: string; provider_id: string; status: string } | null
    if (!o || o.pool_id !== pool.id || o.status !== 'active') return { ok: false, error: 'offer_unavailable' }
    if (!(await offerAvailableTo(admin, o.provider_id, member.rfq_id))) return { ok: false, error: 'offer_unavailable' }
  }
  const { data: moved } = await admin
    .from('service_pool_members')
    .update({ committed_offer_id: a.offerId, committed_at: a.offerId ? new Date().toISOString() : null })
    .eq('id', member.id)
    .eq('status', 'joined')
    .is('claim_state', null)
    .select('id')
  if (!moved?.length) return { ok: false, error: 'conflict' }
  await addPoolEvent(admin, pool.id, a.offerId ? 'committed' : 'uncommitted', a.userId, { member_id: member.id, offer_id: a.offerId })
  captureServerEvent(a.userId, a.offerId ? 'pool_committed' : 'pool_uncommitted', { pool_id: pool.id })
  return { ok: true, committedOfferId: a.offerId }
}

// ── provider: one group offer, or withdraw it ─────────────────────────────────

export async function submitOffer(
  admin: SupabaseClient,
  a: { userId: string; providerId: string; poolId: string; body: PoolOfferInput },
): Promise<PoolActionResult<{ offerId: string }>> {
  const pool = await loadPool(admin, a.poolId)
  if (!pool) return { ok: false, error: 'not_found' }
  if (pool.status !== 'open' || !pool.closes_at) return { ok: false, error: 'pool_not_open' }
  if (!(await eligibleProviderIds(admin, pool.id)).includes(a.providerId)) return { ok: false, error: 'not_eligible' }
  const problems = poolTierProblems(a.body.tiers, pool.max_members)
  if (problems.length) return { ok: false, error: 'tiers_incoherent', detail: problems }
  // The quote a close writes must still be valid when it lands.
  if (a.body.valid_until < pool.closes_at.slice(0, 10)) return { ok: false, error: 'validity_too_short' }

  const { data: offer, error } = await admin
    .from('service_pool_offers')
    .insert({
      pool_id: pool.id,
      provider_id: a.providerId,
      status: 'active',
      delivery_days: a.body.delivery_days,
      // Audit M40 — offer text reaches every member before payment: contact details masked (§9.3).
      scope: redactContactInfo(a.body.scope).text,
      message: a.body.message ? redactContactInfo(a.body.message).text : null,
      gst_included: a.body.gst_included,
      transport_included: a.body.transport_included ?? null,
      valid_until: a.body.valid_until,
      advance_percent: a.body.advance_percent ?? null,
    })
    .select('id')
    .single()
  if (error || !offer) {
    if ((error as { code?: string } | null)?.code === '23505') return { ok: false, error: 'offer_exists' }
    console.error('[pools] offer insert failed', error?.message)
    return { ok: false, error: 'failed' }
  }
  const { error: tErr } = await admin.from('service_pool_offer_tiers').insert(a.body.tiers.map((t) => ({ offer_id: offer.id, min_members: t.min_members, price_paise: t.price_paise })))
  if (tErr) {
    // An offer without its tiers must never be visible: remove it (cascade takes any partial tiers).
    await admin.from('service_pool_offers').delete().eq('id', offer.id)
    console.error('[pools] tier insert failed', tErr.message)
    return { ok: false, error: 'failed' }
  }
  await addPoolEvent(admin, pool.id, 'offer_submitted', a.userId, { offer_id: offer.id, tiers: a.body.tiers.length })
  captureServerEvent(a.userId, 'pool_offer_submitted', { pool_id: pool.id, tiers: a.body.tiers.length })
  const joined = await joinedMembers(admin, pool.id)
  await createNotificationsBulk(admin, await buyerUserIds(admin, joined.map((j) => j.msme_id)), {
    kind: 'pool_offer',
    titleI18n: notifyText('pool_offer.title'),
    bodyI18n: notifyText('pool_offer.body'),
    link: `/app/pools/${pool.id}`,
  })
  return { ok: true, offerId: offer.id }
}

export async function withdrawOffer(
  admin: SupabaseClient,
  a: { userId: string; providerId: string; poolId: string },
): Promise<PoolActionResult<{ offerId: string }>> {
  const pool = await loadPool(admin, a.poolId)
  if (!pool) return { ok: false, error: 'not_found' }
  if (pool.status !== 'open') return { ok: false, error: 'pool_not_open' }
  const { data: moved } = await admin
    .from('service_pool_offers')
    .update({ status: 'withdrawn', withdrawn_at: new Date().toISOString() })
    .eq('pool_id', pool.id)
    .eq('provider_id', a.providerId)
    .eq('status', 'active')
    .select('id')
  const offerId = (moved as Array<{ id: string }> | null)?.[0]?.id
  if (!offerId) return { ok: false, error: 'not_found' }
  // Commitments to a withdrawn offer are cleared (never silently moved to another offer).
  const { data: cleared } = await admin
    .from('service_pool_members')
    .update({ committed_offer_id: null, committed_at: null })
    .eq('pool_id', pool.id)
    .eq('committed_offer_id', offerId)
    .is('claim_state', null)
    .select('msme_id')
  await addPoolEvent(admin, pool.id, 'offer_withdrawn', a.userId, { offer_id: offerId, cleared: cleared?.length ?? 0 })
  await createNotificationsBulk(admin, await buyerUserIds(admin, ((cleared ?? []) as Array<{ msme_id: string }>).map((c) => c.msme_id)), {
    kind: 'pool_offer_withdrawn',
    titleI18n: notifyText('pool_offer_withdrawn.title'),
    bodyI18n: notifyText('pool_offer_withdrawn.body'),
    link: `/app/pools/${pool.id}`,
  })
  return { ok: true, offerId }
}

// ── ops: cancel ───────────────────────────────────────────────────────────────

export async function cancelPool(admin: SupabaseClient, a: { adminUserId: string; poolId: string; reason: string }): Promise<PoolActionResult> {
  const pool = await loadPool(admin, a.poolId)
  if (!pool) return { ok: false, error: 'not_found' }
  const { data: moved } = await admin
    .from('service_pools')
    .update({ status: 'cancelled', cancelled_reason: a.reason })
    .eq('id', pool.id)
    .in('status', ['forming', 'open'])
    .select('id')
  if (!moved?.length) return { ok: false, error: 'not_allowed' }
  const joined = await joinedMembers(admin, pool.id)
  await admin.from('service_pool_members').update({ status: 'released' }).eq('pool_id', pool.id).in('status', ['invited', 'joined'])
  await addPoolEvent(admin, pool.id, 'cancelled', a.adminUserId, { reason: a.reason })
  await createNotificationsBulk(admin, await buyerUserIds(admin, joined.map((j) => j.msme_id)), {
    kind: 'pool_ended',
    titleI18n: notifyText('pool_ended.title'),
    bodyI18n: notifyText('pool_ended.body'),
    link: '/app/rfq',
  })
  return { ok: true }
}

/** One notification to one buyer (used by the clock for per-member outcomes). */
export async function notifyBuyer(admin: SupabaseClient, msmeId: string, input: { kind: string; titleKey: string; bodyKey: string; values?: Record<string, string | number>; link: string }): Promise<void> {
  const [userId] = await buyerUserIds(admin, [msmeId])
  if (!userId) return
  await createNotification(admin, { userId, kind: input.kind, titleI18n: notifyText(input.titleKey), bodyI18n: notifyText(input.bodyKey, input.values ?? {}), link: input.link })
}

export { buyerUserIds, joinedMembers }
