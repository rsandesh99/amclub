import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  pickI18n,
  poolTierViews,
  type PoolBuyerView,
  type PoolMemberStatus,
  type PoolOfferTier,
  type PoolOfferView,
  type ServicePoolStatus,
} from '@amclub/shared'
import { chunks, dualRoleMsmeIds, loadPool, providerUsers, type PoolRow } from './core'
import type { PoolProviderView, PoolRfqCard } from './types'

export type { PoolProviderView, PoolRfqCard } from './types'
import { eligibleProviderIds, offerAvailableTo } from './actions'

/**
 * S3.4 (ADR 024) — role-shaped reads. Buyers see the count and every offer (never another member); providers see the
 * count, the requests they are matched to, and ONLY their own offer (sealed); ops see everything. All money figures
 * are the server's (`poolTierViews` = the checkout's own rule).
 */

async function categoryOf(admin: SupabaseClient, categoryId: string, locale: string): Promise<{ name: string; commissionBps: number }> {
  const { data } = await admin.from('categories').select('name_i18n, commission_bps').eq('id', categoryId).maybeSingle()
  const c = data as { name_i18n: { en: string; hi?: string; te?: string; ta?: string } | null; commission_bps: number | null } | null
  return { name: c?.name_i18n ? pickI18n(c.name_i18n, locale) : '', commissionBps: c?.commission_bps ?? 1000 }
}

async function tiersFor(admin: SupabaseClient, offerIds: readonly string[]): Promise<Map<string, PoolOfferTier[]>> {
  const out = new Map<string, PoolOfferTier[]>()
  for (const part of chunks([...offerIds])) {
    const { data } = await admin.from('service_pool_offer_tiers').select('offer_id, min_members, price_paise').in('offer_id', part)
    for (const t of (data ?? []) as Array<{ offer_id: string; min_members: number; price_paise: number }>) {
      const list = out.get(t.offer_id) ?? []
      list.push({ min_members: t.min_members, price_paise: Number(t.price_paise) })
      out.set(t.offer_id, list)
    }
  }
  return out
}

async function joinedCount(admin: SupabaseClient, poolId: string): Promise<number> {
  const { count } = await admin.from('service_pool_members').select('id', { count: 'exact', head: true }).eq('pool_id', poolId).eq('status', 'joined')
  return count ?? 0
}

interface OfferRow {
  id: string
  provider_id: string
  status: string
  delivery_days: number
  scope: string
  message: string | null
  gst_included: boolean
  valid_until: string
  advance_percent: number | null
  achieved_count: number | null
  achieved_price_paise: number | null
}
const OFFER_COLS = 'id, provider_id, status, delivery_days, scope, message, gst_included, valid_until, advance_percent, achieved_count, achieved_price_paise'

// ── buyer ───────────────────────────────────────────────────────────────────

export async function poolBuyerView(admin: SupabaseClient, poolId: string, msmeId: string, locale = 'en'): Promise<PoolBuyerView | null> {
  const pool = await loadPool(admin, poolId)
  if (!pool) return null
  const { data: me } = await admin.from('service_pool_members').select('id, rfq_id, status, committed_offer_id, quote_id').eq('pool_id', poolId).eq('msme_id', msmeId).maybeSingle()
  const m = me as { id: string; rfq_id: string; status: PoolMemberStatus; committed_offer_id: string | null; quote_id: string | null } | null
  if (!m) return null
  const cat = await categoryOf(admin, pool.category_id, locale)

  // Offers are shown only to members who joined (an invitee sees the group, not its prices), and never to an
  // account that also sells services (audit M45: the sealed offers of its competitors).
  let offers: PoolOfferView[] = []
  if ((m.status === 'joined' || m.status === 'released') && !(await dualRoleMsmeIds(admin, [msmeId])).has(msmeId)) {
    const { data } = await admin.from('service_pool_offers').select(OFFER_COLS).eq('pool_id', poolId).eq('status', 'active').order('created_at')
    const rows = (data ?? []) as OfferRow[]
    const tiers = await tiersFor(admin, rows.map((r) => r.id))
    const users = await providerUsers(admin, rows.map((r) => r.provider_id))
    const { data: commits } = await admin.from('service_pool_members').select('committed_offer_id').eq('pool_id', poolId).not('committed_offer_id', 'is', null)
    const committed = new Map<string, number>()
    for (const c of (commits ?? []) as Array<{ committed_offer_id: string }>) committed.set(c.committed_offer_id, (committed.get(c.committed_offer_id) ?? 0) + 1)
    offers = await Promise.all(rows.map(async (r) => ({
      id: r.id,
      providerName: users.get(r.provider_id)?.name ?? '',
      providerSlug: users.get(r.provider_id)?.slug ?? null,
      deliveryDays: r.delivery_days,
      scope: r.scope,
      message: r.message,
      gstIncluded: r.gst_included,
      validUntil: r.valid_until,
      advancePercent: r.advance_percent,
      tiers: poolTierViews(tiers.get(r.id) ?? [], r.gst_included, cat.commissionBps),
      committedCount: committed.get(r.id) ?? 0,
      availableToMe: pool.status === 'open' ? await offerAvailableTo(admin, r.provider_id, m.rfq_id) : false,
    })))
  }
  return {
    id: pool.id,
    status: pool.status as ServicePoolStatus,
    serviceSlug: pool.service_slug,
    categoryName: cat.name,
    state: pool.state,
    joinedCount: await joinedCount(admin, poolId),
    minMembers: pool.min_members,
    formBy: pool.form_by,
    closesAt: pool.closes_at,
    me: { memberId: m.id, rfqId: m.rfq_id, status: m.status, committedOfferId: m.committed_offer_id, quoteId: m.quote_id },
    offers,
  }
}


/** The buyer's group for ONE of their requests (the card on the request page). Live groups, or the one that quoted it. */
export async function poolForRfq(admin: SupabaseClient, rfqId: string, msmeId: string): Promise<PoolRfqCard | null> {
  const { data } = await admin
    .from('service_pool_members')
    .select('pool_id, status, quote_id, created_at')
    .eq('rfq_id', rfqId)
    .eq('msme_id', msmeId)
    .order('created_at', { ascending: false })
    .limit(1)
  const m = (data as Array<{ pool_id: string; status: PoolMemberStatus; quote_id: string | null }> | null)?.[0]
  if (!m) return null
  // A dismissed invitation or a finished group with nothing to show stays out of the way.
  if (m.status === 'dismissed') return null
  const pool = await loadPool(admin, m.pool_id)
  if (!pool) return null
  if (!['forming', 'open', 'closing'].includes(pool.status) && !m.quote_id) return null
  return {
    poolId: pool.id,
    status: pool.status as ServicePoolStatus,
    memberStatus: m.status,
    joinedCount: await joinedCount(admin, pool.id),
    minMembers: pool.min_members,
    formBy: pool.form_by,
    closesAt: pool.closes_at,
    quoteId: m.quote_id,
  }
}

// ── provider ────────────────────────────────────────────────────────────────


export async function poolProviderView(admin: SupabaseClient, poolId: string, providerId: string, locale = 'en'): Promise<PoolProviderView | null> {
  const pool = await loadPool(admin, poolId)
  if (!pool) return null
  const { data: mineData } = await admin.from('service_pool_offers').select(OFFER_COLS).eq('pool_id', poolId).eq('provider_id', providerId).order('created_at', { ascending: false }).limit(1)
  const mine = (mineData as OfferRow[] | null)?.[0] ?? null
  // Visible to an eligible provider while open, and to a provider who made an offer afterwards.
  if (!mine && !(pool.status === 'open' && (await eligibleProviderIds(admin, poolId)).includes(providerId))) return null
  const cat = await categoryOf(admin, pool.category_id, locale)
  const { data: members } = await admin.from('service_pool_members').select('rfq_id').eq('pool_id', poolId).in('status', ['joined', 'released'])
  const rfqIds = ((members ?? []) as Array<{ rfq_id: string }>).map((r) => r.rfq_id)
  const matched: string[] = []
  for (const part of chunks(rfqIds)) {
    const { data } = await admin.from('rfq_matches').select('rfq_id').eq('provider_id', providerId).in('rfq_id', part)
    matched.push(...((data ?? []) as Array<{ rfq_id: string }>).map((r) => r.rfq_id))
  }
  const tiers = mine ? await tiersFor(admin, [mine.id]) : new Map<string, PoolOfferTier[]>()
  return {
    id: pool.id,
    status: pool.status as ServicePoolStatus,
    serviceSlug: pool.service_slug,
    categoryName: cat.name,
    state: pool.state,
    joinedCount: await joinedCount(admin, poolId),
    maxMembers: pool.max_members,
    closesAt: pool.closes_at,
    matchedRfqIds: matched,
    mine: mine
      ? {
          id: mine.id,
          status: mine.status,
          deliveryDays: mine.delivery_days,
          scope: mine.scope,
          gstIncluded: mine.gst_included,
          validUntil: mine.valid_until,
          tiers: poolTierViews(tiers.get(mine.id) ?? [], mine.gst_included, cat.commissionBps),
          achievedCount: mine.achieved_count,
          achievedPricePaise: mine.achieved_price_paise === null ? null : Number(mine.achieved_price_paise),
        }
      : null,
  }
}

export interface PoolListItem {
  id: string
  status: ServicePoolStatus
  serviceSlug: string
  state: string
  joinedCount: number
  closesAt: string | null
  hasMyOffer: boolean
}

/** Open groups a provider may offer on, plus any group they already offered on (newest first). */
export async function providerPools(admin: SupabaseClient, providerId: string): Promise<PoolListItem[]> {
  const { data: open } = await admin.from('service_pools').select('id, status, service_slug, state, closes_at').eq('status', 'open').order('closes_at')
  const { data: offered } = await admin.from('service_pool_offers').select('pool_id').eq('provider_id', providerId)
  const offeredIds = new Set(((offered ?? []) as Array<{ pool_id: string }>).map((o) => o.pool_id))
  const out: PoolListItem[] = []
  for (const p of (open ?? []) as Array<{ id: string; status: ServicePoolStatus; service_slug: string; state: string; closes_at: string | null }>) {
    if (!offeredIds.has(p.id) && !(await eligibleProviderIds(admin, p.id)).includes(providerId)) continue
    out.push({ id: p.id, status: p.status, serviceSlug: p.service_slug, state: p.state, joinedCount: await joinedCount(admin, p.id), closesAt: p.closes_at, hasMyOffer: offeredIds.has(p.id) })
  }
  const past = [...offeredIds].filter((id) => !out.some((o) => o.id === id))
  for (const part of chunks(past)) {
    const { data } = await admin.from('service_pools').select('id, status, service_slug, state, closes_at').in('id', part)
    for (const p of (data ?? []) as Array<{ id: string; status: ServicePoolStatus; service_slug: string; state: string; closes_at: string | null }>) {
      out.push({ id: p.id, status: p.status, serviceSlug: p.service_slug, state: p.state, joinedCount: await joinedCount(admin, p.id), closesAt: p.closes_at, hasMyOffer: true })
    }
  }
  return out
}

// ── ops ─────────────────────────────────────────────────────────────────────

export interface PoolAdminItem extends PoolRow {
  invited: number
  joined: number
  offers: number
  quoted: number
  /** Group quotes the buyer went on to accept & pay (the honest-commitment measure, ADR 024 §3). */
  paid: number
}

export async function adminPools(admin: SupabaseClient, limit = 100): Promise<PoolAdminItem[]> {
  const { data } = await admin.from('service_pools').select('id, category_id, service_slug, state, status, min_members, max_members, form_by, opened_at, closes_at, closed_at').order('created_at', { ascending: false }).limit(limit)
  const pools = (data ?? []) as PoolRow[]
  const out: PoolAdminItem[] = []
  for (const p of pools) {
    const { data: members } = await admin.from('service_pool_members').select('status, joined_at, quote_id').eq('pool_id', p.id)
    const ms = (members ?? []) as Array<{ status: string; joined_at: string | null; quote_id: string | null }>
    const { count: offers } = await admin.from('service_pool_offers').select('id', { count: 'exact', head: true }).eq('pool_id', p.id).eq('status', 'active')
    const quoteIds = ms.map((m) => m.quote_id).filter((q): q is string => !!q)
    let paid = 0
    if (quoteIds.length) {
      const { count } = await admin.from('quotes').select('id', { count: 'exact', head: true }).in('id', quoteIds).eq('status', 'accepted')
      paid = count ?? 0
    }
    out.push({ ...p, invited: ms.length, joined: ms.filter((m) => m.joined_at).length, offers: offers ?? 0, quoted: quoteIds.length, paid })
  }
  return out
}
