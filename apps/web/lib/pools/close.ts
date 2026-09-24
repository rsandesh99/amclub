import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatRupees, planPoolClose, quoteChargeAmounts, type PoolOfferTier, type PoolSkipReason } from '@amclub/shared'
import { loadRfqRowForQuote, quoteRowColumns, quoteTermsSnapshot, resolveQuoteTerms } from '@/lib/rfq/quote-terms'
import { addQuoteEvent } from '@/lib/rfq/events'
import { createNotification } from '@/lib/notifications/create'
import { notifyText } from '@/lib/i18n/notify'
import { captureServerEvent } from '@/lib/analytics/server'
import { addPoolEvent, loadPool, providerUsers } from './core'
import { notifyBuyer } from './actions'
import { providerOwnsRequest } from '@/lib/orders/self-dealing'

/**
 * S3.4 (ADR 024) — the clock: forming groups that ran out of time lapse; open groups past closes_at close. The close
 * is the one money-adjacent step and it only writes ORDINARY quotes, through the same terms path as the submit route:
 *
 *   1. per committed member: pre-checks (provider active; request open/quoted and unexpired; no quote from this
 *      provider; match not declined) → `skipped` with a reason, else `service_pool_claim` claims the request's quote
 *      slot (7-cap, status, expiry enforced by claim_quote_slot) and marks the member claimed in ONE transaction;
 *   2. per offer: the tier its CLAIMED count reaches (shared planPoolClose), persisted on the offer before any quote;
 *   3. one quote per claimed member at that price; member ↔ quote linked; buyer and provider told;
 *   4. closing → closed; memberships released.
 * Replay-safe at every step: guarded updates, the claim function's own guard, the unique (rfq, provider) quote.
 * Audit L9: one close per pool at a time (a compare-and-set lease, close_lease_until), and a resumed close that
 * meets its own earlier quote (quotes.pool_member_id) links it instead of giving its slot back.
 */

interface OfferRow {
  id: string
  provider_id: string
  status: string
  delivery_days: number
  scope: string
  message: string | null
  gst_included: boolean
  transport_included: boolean | null
  valid_until: string
  advance_percent: number | null
  achieved_count: number | null
  achieved_min_members: number | null
  achieved_price_paise: number | null
}
const OFFER_COLS = 'id, provider_id, status, delivery_days, scope, message, gst_included, transport_included, valid_until, advance_percent, achieved_count, achieved_min_members, achieved_price_paise'

interface MemberRow {
  id: string
  rfq_id: string
  msme_id: string
  status: string
  committed_offer_id: string | null
  claim_state: 'claimed' | 'skipped' | null
  claim_offer_id: string | null
  skip_reason: PoolSkipReason | null
  quote_id: string | null
}
const MEMBER_COLS = 'id, rfq_id, msme_id, status, committed_offer_id, claim_state, claim_offer_id, skip_reason, quote_id'

export interface CloseResult {
  poolId: string
  closed: boolean
  quotes: number
  skipped: number
}

async function skip(admin: SupabaseClient, m: MemberRow, reason: PoolSkipReason): Promise<void> {
  await admin.from('service_pool_members').update({ claim_state: 'skipped', skip_reason: reason, claim_offer_id: m.committed_offer_id }).eq('id', m.id).is('claim_state', null)
}

async function precheck(admin: SupabaseClient, m: MemberRow, providerId: string, providerActive: boolean): Promise<PoolSkipReason | null> {
  if (!providerActive) return 'provider_inactive'
  const [{ data: rfq }, { data: quote }, { data: match }] = await Promise.all([
    admin.from('rfqs').select('status, expires_at, deleted_at').eq('id', m.rfq_id).maybeSingle(),
    admin.from('quotes').select('id').eq('rfq_id', m.rfq_id).eq('provider_id', providerId).maybeSingle(),
    admin.from('rfq_matches').select('declined_at').eq('rfq_id', m.rfq_id).eq('provider_id', providerId).maybeSingle(),
  ])
  const r = rfq as { status: string; expires_at: string; deleted_at: string | null } | null
  if (!r || r.deleted_at || (r.status !== 'open' && r.status !== 'quoted') || Date.parse(r.expires_at) <= Date.now()) return 'rfq_closed'
  if (quote) return 'already_quoted'
  if ((match as { declined_at: string | null } | null)?.declined_at) return 'declined'
  // Audit M22 (ADR 029) — never a quote from the member's own provider profile.
  if (await providerOwnsRequest(admin, providerId, m.rfq_id)) return 'self_dealing'
  return null
}

/** How long one close may hold a pool before another run may resume it (the clock runs hourly). */
export const CLOSE_LEASE_MS = 10 * 60_000

/**
 * Audit L9 — take the per-pool close lease (compare-and-set on close_lease_until, 0077):
 * at most one close runs a pool at a time; a run that dies leaves the lease to expire,
 * and the next clock tick resumes. False = another close holds it (or the read failed).
 */
async function takeCloseLease(admin: SupabaseClient, poolId: string, now = new Date()): Promise<boolean> {
  const nowIso = now.toISOString()
  const { data, error } = await admin
    .from('service_pools')
    .update({ close_lease_until: new Date(now.getTime() + CLOSE_LEASE_MS).toISOString() })
    .eq('id', poolId)
    .eq('status', 'closing')
    .or(`close_lease_until.is.null,close_lease_until.lt."${nowIso}"`)
    .select('id')
  if (error) {
    console.error('[pools] close lease failed', { poolId, message: error.message })
    return false
  }
  return (data ?? []).length > 0
}

/**
 * Audit L9 — on a unique (rfq, provider) violation: is the quote already there THIS
 * member's group quote (a resumed close wrote it, then stopped before linking)? Then it
 * is linked and its slot kept. Also says whether its 'submitted' event was written, so
 * a resume finishes exactly what the stopped run did not.
 */
async function ownGroupQuote(admin: SupabaseClient, m: MemberRow, providerId: string): Promise<{ id: string; hasEvent: boolean } | null> {
  const { data } = await admin.from('quotes').select('id, pool_member_id').eq('rfq_id', m.rfq_id).eq('provider_id', providerId).maybeSingle()
  const q = data as { id: string; pool_member_id: string | null } | null
  if (!q || q.pool_member_id !== m.id) return null
  const { count } = await admin.from('quote_events').select('id', { count: 'exact', head: true }).eq('quote_id', q.id).eq('event_type', 'submitted')
  return { id: q.id, hasEvent: (count ?? 0) > 0 }
}

export async function closePool(admin: SupabaseClient, poolId: string): Promise<CloseResult> {
  const pool = await loadPool(admin, poolId)
  if (!pool || pool.status !== 'closing') return { poolId, closed: false, quotes: 0, skipped: 0 }
  if (!(await takeCloseLease(admin, poolId))) return { poolId, closed: false, quotes: 0, skipped: 0 }

  const { data: offerData } = await admin.from('service_pool_offers').select(OFFER_COLS).eq('pool_id', poolId).eq('status', 'active')
  const offers = new Map(((offerData ?? []) as OfferRow[]).map((o) => [o.id, o]))
  const tiersOf = new Map<string, PoolOfferTier[]>()
  if (offers.size) {
    const { data: tiers } = await admin.from('service_pool_offer_tiers').select('offer_id, min_members, price_paise').in('offer_id', [...offers.keys()])
    for (const t of (tiers ?? []) as Array<{ offer_id: string; min_members: number; price_paise: number }>) {
      const list = tiersOf.get(t.offer_id) ?? []
      list.push({ min_members: t.min_members, price_paise: Number(t.price_paise) })
      tiersOf.set(t.offer_id, list)
    }
  }
  const providers = await providerUsers(admin, [...offers.values()].map((o) => o.provider_id))

  // 1. Claims (or skips) for every committed member not yet settled.
  const { data: memberData } = await admin.from('service_pool_members').select(MEMBER_COLS).eq('pool_id', poolId).eq('status', 'joined').not('committed_offer_id', 'is', null)
  for (const m of (memberData ?? []) as MemberRow[]) {
    if (m.claim_state) continue
    const offer = offers.get(m.committed_offer_id!)
    if (!offer) continue // committed to a withdrawn offer (withdraw clears these; a race leaves it uncounted)
    const reason = await precheck(admin, m, offer.provider_id, providers.get(offer.provider_id)?.active ?? false)
    if (reason) { await skip(admin, m, reason); continue }
    // The provider may quote this request: the same fact fan-out records (idempotent on the (rfq, provider) key).
    await admin.from('rfq_matches').upsert({ rfq_id: m.rfq_id, provider_id: offer.provider_id }, { onConflict: 'rfq_id,provider_id', ignoreDuplicates: true })
    const { error } = await admin.rpc('service_pool_claim', { p_member_id: m.id })
    if (error) console.error('[pools] claim failed', { member: m.id, message: error.message })
  }

  // 2. The tier each offer's CLAIMED count reaches, persisted once before any quote (a resumed close reuses it).
  const { data: settledData } = await admin.from('service_pool_members').select(MEMBER_COLS).eq('pool_id', poolId).not('claim_state', 'is', null)
  const settled = (settledData ?? []) as MemberRow[]
  const claimed = settled.filter((m) => m.claim_state === 'claimed' && m.claim_offer_id)
  const plan = planPoolClose([...offers.values()].map((o) => ({ offerId: o.id, tiers: tiersOf.get(o.id) ?? [] })), claimed.map((m) => ({ offerId: m.claim_offer_id! })))
  for (const p of plan) {
    const o = offers.get(p.offerId)!
    if (o.achieved_count !== null) continue
    const { data: set } = await admin
      .from('service_pool_offers')
      .update({ achieved_count: p.count, achieved_min_members: p.tier?.min_members ?? null, achieved_price_paise: p.tier?.price_paise ?? null })
      .eq('id', o.id)
      .is('achieved_count', null)
      .select(OFFER_COLS)
    const row = (set as OfferRow[] | null)?.[0]
    if (row) offers.set(o.id, row)
    else {
      const { data: again } = await admin.from('service_pool_offers').select(OFFER_COLS).eq('id', o.id).maybeSingle()
      if (again) offers.set(o.id, again as OfferRow)
    }
  }

  // 3. One ordinary quote per claimed member, at the persisted price.
  let quotes = 0
  const perOffer = new Map<string, number>() // every group quote per offer (this run and earlier ones)
  const newThisRun = new Map<string, number>() // only the quotes written now: a resumed close never re-notifies
  for (const m of claimed) {
    const o = offers.get(m.claim_offer_id!)
    if (!o || !o.achieved_price_paise) continue
    if (m.quote_id) { perOffer.set(o.id, (perOffer.get(o.id) ?? 0) + 1); continue }
    const body = {
      price_paise: Number(o.achieved_price_paise),
      delivery_days: o.delivery_days,
      scope: o.scope,
      ...(o.message ? { message: o.message } : {}),
      gst_included: o.gst_included,
      ...(o.transport_included !== null ? { transport_included: o.transport_included } : {}),
      valid_until: o.valid_until,
      ...(o.advance_percent !== null ? { advance_percent: o.advance_percent } : {}),
    }
    const rfqRow = await loadRfqRowForQuote(admin, m.rfq_id)
    const resolved = await resolveQuoteTerms(admin, { rfqRow: rfqRow ?? { id: m.rfq_id }, providerId: o.provider_id, body })
    if (!resolved.ok) {
      console.error('[pools] quote terms refused', { member: m.id, error: resolved.error })
      continue
    }
    // The quote names its member in the same INSERT (quotes.pool_member_id, 0077): a replay
    // can always tell this group's quote from a direct one.
    const { data: inserted, error } = await admin
      .from('quotes')
      .insert({ rfq_id: m.rfq_id, provider_id: o.provider_id, ...quoteRowColumns(resolved.value, body), status: 'submitted', pool_member_id: m.id })
      .select('id')
      .single()
    let quoteId = (inserted as { id: string } | null)?.id ?? null
    let finishQuote = true
    if (!quoteId) {
      const unique = (error as { code?: string } | null)?.code === '23505'
      // Audit L9 — this member's own quote from a stopped run: link it, keep its slot (never release it).
      const own = unique ? await ownGroupQuote(admin, m, o.provider_id) : null
      if (!own) {
        // A direct quote landed between the pre-check and here (unique rfq + provider): give the slot back, record it.
        await admin.rpc('release_quote_slot', { p_rfq_id: m.rfq_id })
        await admin.from('service_pool_members').update({ claim_state: 'skipped', skip_reason: 'already_quoted' }).eq('id', m.id).eq('claim_state', 'claimed').is('quote_id', null)
        if (!unique) console.error('[pools] quote insert failed', { member: m.id, message: error?.message })
        continue
      }
      quoteId = own.id
      finishQuote = !own.hasEvent
    }
    await admin.from('service_pool_members').update({ quote_id: quoteId }).eq('id', m.id).is('quote_id', null)
    if (!finishQuote) { perOffer.set(o.id, (perOffer.get(o.id) ?? 0) + 1); continue }
    const quote = { id: quoteId }
    const provider = providers.get(o.provider_id)
    await addQuoteEvent(admin, {
      quoteId: quote.id,
      eventType: 'submitted',
      actor: 'system',
      payload: {
        rfq_id: m.rfq_id,
        pool_id: poolId,
        pool_offer_id: o.id,
        pool_count: o.achieved_count,
        pool_min_members: o.achieved_min_members,
        authorised_by: provider?.userId ?? null,
        ...quoteTermsSnapshot(resolved.value, body),
      },
    })
    quotes++
    perOffer.set(o.id, (perOffer.get(o.id) ?? 0) + 1)
    newThisRun.set(o.id, (newThisRun.get(o.id) ?? 0) + 1)
    const total = quoteChargeAmounts({ pricePaise: Number(o.achieved_price_paise), gstIncluded: o.gst_included, commissionBps: 0 }).totalPaise
    await notifyBuyer(admin, m.msme_id, {
      kind: 'pool_quote',
      titleKey: 'pool_quote.title',
      bodyKey: 'pool_quote.body',
      values: { provider: provider?.name ?? '', total: formatRupees(total), n: o.achieved_count ?? 1 },
      link: `/app/rfq/${m.rfq_id}`,
    })
  }

  // Providers hear their count and price, once: only when this run wrote their quotes.
  for (const [offerId, n] of perOffer) {
    if (!newThisRun.get(offerId)) continue
    const o = offers.get(offerId)!
    const u = providers.get(o.provider_id)
    if (!u || !o.achieved_price_paise) continue
    await createNotification(admin, {
      userId: u.userId,
      kind: 'pool_closed_provider',
      titleI18n: notifyText('pool_closed_provider.title'),
      bodyI18n: notifyText('pool_closed_provider.body', { n, price: formatRupees(Number(o.achieved_price_paise)) }),
      link: '/partner/rfqs',
    })
    captureServerEvent(u.userId, 'pool_offer_closed', { pool_id: poolId, count: n })
  }

  // Joined members who got no group quote hear why, in one line (their request carries on as normal).
  const { data: joinedData } = await admin.from('service_pool_members').select(MEMBER_COLS).eq('pool_id', poolId).eq('status', 'joined')
  const noQuote = ((joinedData ?? []) as MemberRow[]).filter((m) => !m.quote_id)
  for (const m of noQuote) {
    await notifyBuyer(admin, m.msme_id, { kind: 'pool_ended', titleKey: 'pool_ended.title', bodyKey: 'pool_ended.body', link: `/app/rfq/${m.rfq_id}` })
  }

  // 4. closing → closed; every live membership released (the request can be grouped again in future).
  const { data: done } = await admin.from('service_pools').update({ status: 'closed', closed_at: new Date().toISOString(), close_lease_until: null }).eq('id', poolId).eq('status', 'closing').select('id')
  if (done?.length) {
    await admin.from('service_pool_members').update({ status: 'released' }).eq('pool_id', poolId).in('status', ['invited', 'joined'])
    await addPoolEvent(admin, poolId, 'closed', null, { quotes: [...perOffer.values()].reduce((a, b) => a + b, 0), skipped: settled.filter((m) => m.claim_state === 'skipped').length, offers: plan.map((p) => ({ offer_id: p.offerId, count: p.count, min_members: p.tier?.min_members ?? null })) })
  }
  return { poolId, closed: !!done?.length, quotes, skipped: settled.filter((m) => m.claim_state === 'skipped').length }
}

export interface ClockResult {
  lapsed: number
  closed: CloseResult[]
}

/** Lapse forming groups past form_by; close open groups past closes_at (and resume any close that stopped half-way). */
export async function runPoolClock(admin: SupabaseClient, now = new Date()): Promise<ClockResult> {
  const nowIso = now.toISOString()
  let lapsed = 0

  const { data: forming } = await admin.from('service_pools').select('id').eq('status', 'forming').lte('form_by', nowIso)
  for (const p of (forming ?? []) as Array<{ id: string }>) {
    const { data: moved } = await admin.from('service_pools').update({ status: 'lapsed' }).eq('id', p.id).eq('status', 'forming').select('id')
    if (!moved?.length) continue
    lapsed++
    const { data: joined } = await admin.from('service_pool_members').select('msme_id, rfq_id').eq('pool_id', p.id).eq('status', 'joined')
    await admin.from('service_pool_members').update({ status: 'released' }).eq('pool_id', p.id).in('status', ['invited', 'joined'])
    await addPoolEvent(admin, p.id, 'lapsed', null, {})
    for (const m of (joined ?? []) as Array<{ msme_id: string; rfq_id: string }>) {
      await notifyBuyer(admin, m.msme_id, { kind: 'pool_lapsed', titleKey: 'pool_lapsed.title', bodyKey: 'pool_lapsed.body', link: `/app/rfq/${m.rfq_id}` })
    }
  }

  const { data: due } = await admin.from('service_pools').select('id').eq('status', 'open').lte('closes_at', nowIso)
  for (const p of (due ?? []) as Array<{ id: string }>) {
    const { data: moved } = await admin.from('service_pools').update({ status: 'closing' }).eq('id', p.id).eq('status', 'open').select('id')
    if (moved?.length) await addPoolEvent(admin, p.id, 'closing', null, {})
  }
  const { data: closing } = await admin.from('service_pools').select('id').eq('status', 'closing')
  const closed: CloseResult[] = []
  for (const p of (closing ?? []) as Array<{ id: string }>) closed.push(await closePool(admin, p.id))
  return { lapsed, closed }
}

