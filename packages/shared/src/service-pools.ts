import { z } from 'zod'
import { paiseSchema, uuidSchema } from './schemas/index'
import { quoteChargeAmounts } from './quote-v3'

/**
 * S3.4 — demand aggregation for services (ADR 024). A group ("pool") is several buyers' OWN open requests with the
 * same (category, service, state). The agent proposes it (code, no model), each buyer opts in, eligible providers
 * state a volume-tier offer up front, buyers commit to one, and at close every committed member gets ONE ordinary
 * quote at the tier the count reached. Everything after that is the ordinary quote → order path.
 *
 * The laws here are pure and shared with the web routes, the cron and (later) mobile:
 *   - the pool machine (`SERVICE_POOL_TRANSITIONS`) and the member actions;
 *   - who may be proposed together (`clusterPoolCandidates`), with the timing rule that keeps every group price
 *     inside the request's own 72-hour clock;
 *   - what an offer's tiers must look like (`poolTierProblems`) and which tier a count reaches (`achievedTier`);
 *   - the all-in figure a buyer sees per tier (`poolTierViews` = `quoteChargeAmounts`, the checkout's own rule).
 */

// ── the pool machine ─────────────────────────────────────────────────────────

export const SERVICE_POOL_STATUSES = ['forming', 'open', 'closing', 'closed', 'lapsed', 'cancelled'] as const
export type ServicePoolStatus = (typeof SERVICE_POOL_STATUSES)[number]

export const SERVICE_POOL_TRANSITIONS: Record<ServicePoolStatus, readonly ServicePoolStatus[]> = {
  forming: ['open', 'lapsed', 'cancelled'],
  open: ['closing', 'cancelled'],
  closing: ['closed'],
  closed: [],
  lapsed: [],
  cancelled: [],
}

export function canTransitionServicePool(from: ServicePoolStatus, to: ServicePoolStatus): boolean {
  return SERVICE_POOL_TRANSITIONS[from].includes(to)
}

/** Statuses in which a pool still holds its members (a request is in at most one such pool). */
export const SERVICE_POOL_LIVE: readonly ServicePoolStatus[] = ['forming', 'open', 'closing']

export const POOL_MEMBER_STATUSES = ['invited', 'joined', 'left', 'dismissed', 'released'] as const
export type PoolMemberStatus = (typeof POOL_MEMBER_STATUSES)[number]

export const POOL_MEMBER_ACTIONS = ['join', 'leave', 'dismiss'] as const
export type PoolMemberAction = (typeof POOL_MEMBER_ACTIONS)[number]

/** The member status an action moves FROM → TO. Anything else is refused (409). */
export const POOL_MEMBER_ACTION_MAP: Record<PoolMemberAction, { from: readonly PoolMemberStatus[]; to: PoolMemberStatus }> = {
  join: { from: ['invited', 'left'], to: 'joined' },
  leave: { from: ['joined'], to: 'left' },
  dismiss: { from: ['invited'], to: 'dismissed' },
}

/** Members act only while the pool is forming or open. */
export function memberActionAllowed(action: PoolMemberAction, member: PoolMemberStatus, pool: ServicePoolStatus): boolean {
  if (pool !== 'forming' && pool !== 'open') return false
  return POOL_MEMBER_ACTION_MAP[action].from.includes(member)
}

export const POOL_OFFER_STATUSES = ['active', 'withdrawn'] as const
export type PoolOfferStatus = (typeof POOL_OFFER_STATUSES)[number]

/** Why a committed member did not get a group quote at close. */
export const POOL_SKIP_REASONS = ['provider_inactive', 'rfq_closed', 'already_quoted', 'declined'] as const
export type PoolSkipReason = (typeof POOL_SKIP_REASONS)[number]

export const POOL_EVENT_KINDS = [
  'proposed', 'invited', 'joined', 'left', 'dismissed', 'opened', 'offer_submitted', 'offer_withdrawn',
  'committed', 'uncommitted', 'closing', 'closed', 'lapsed', 'cancelled',
] as const
export type PoolEventKind = (typeof POOL_EVENT_KINDS)[number]

// ── offers and tiers ─────────────────────────────────────────────────────────

export const POOL_MAX_TIERS = 3
/** Hard ceiling on any threshold (pool_max_members can only be set below it). */
export const POOL_MEMBERS_CEILING = 50

export const poolOfferTierSchema = z.object({
  min_members: z.number().int().min(1).max(POOL_MEMBERS_CEILING),
  price_paise: paiseSchema,
}).strict()
export type PoolOfferTier = z.infer<typeof poolOfferTierSchema>

/** A provider's group offer. GST and validity are required statements (ADR 017), as on a v3 quote. */
export const poolOfferSchema = z.object({
  tiers: z.array(poolOfferTierSchema).min(1).max(POOL_MAX_TIERS),
  delivery_days: z.number().int().positive().max(365),
  scope: z.string().trim().min(20).max(2000),
  message: z.string().trim().max(500).optional(),
  gst_included: z.boolean(),
  transport_included: z.boolean().optional(),
  valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  advance_percent: z.number().int().min(0).max(100).optional(),
}).strict()
export type PoolOfferInput = z.infer<typeof poolOfferSchema>

export const poolMembershipSchema = z.object({ action: z.enum(POOL_MEMBER_ACTIONS) }).strict()
export const poolCommitSchema = z.object({ offer_id: uuidSchema.nullable() }).strict()
export const poolCancelSchema = z.object({ reason: z.string().trim().min(3).max(300) }).strict()

export type PoolTierProblem = 'first_tier_not_one' | 'thresholds_not_increasing' | 'prices_not_decreasing' | 'threshold_over_max'

/**
 * The tier rule (the E12b coherence idea applied to a count): the first tier is the price for one business on its
 * own (min_members = 1); every further tier has a strictly higher threshold and a strictly LOWER price; no threshold
 * exceeds the pool's maximum size. Tiers are read in the order given. [] = coherent.
 */
export function poolTierProblems(tiers: readonly PoolOfferTier[], maxMembers: number): PoolTierProblem[] {
  const out = new Set<PoolTierProblem>()
  if (tiers.length === 0 || tiers[0]!.min_members !== 1) out.add('first_tier_not_one')
  for (let i = 1; i < tiers.length; i++) {
    if (tiers[i]!.min_members <= tiers[i - 1]!.min_members) out.add('thresholds_not_increasing')
    if (tiers[i]!.price_paise >= tiers[i - 1]!.price_paise) out.add('prices_not_decreasing')
  }
  if (tiers.some((t) => t.min_members > maxMembers)) out.add('threshold_over_max')
  return [...out]
}

/** The tier a count reaches: the highest threshold ≤ count. null when count < 1 (nobody to quote). */
export function achievedTier<T extends { min_members: number; price_paise: number }>(tiers: readonly T[], count: number): T | null {
  if (!Number.isInteger(count) || count < 1) return null
  let best: T | null = null
  for (const t of tiers) if (t.min_members <= count && (!best || t.min_members > best.min_members)) best = t
  return best
}

export interface PoolTierView {
  minMembers: number
  pricePaise: number
  gstPaise: number
  /** What the buyer pays at this tier (the checkout's own rule for a quote at this price). */
  totalPaise: number
}

/** Every tier with the server's all-in figure: `quoteChargeAmounts` under the offer's GST mode. */
export function poolTierViews(tiers: readonly PoolOfferTier[], gstIncluded: boolean, commissionBps: number): PoolTierView[] {
  return [...tiers]
    .sort((a, b) => a.min_members - b.min_members)
    .map((t) => {
      const a = quoteChargeAmounts({ pricePaise: t.price_paise, gstIncluded, commissionBps })
      return { minMembers: t.min_members, pricePaise: t.price_paise, gstPaise: a.gstPaise, totalPaise: a.totalPaise }
    })
}

// ── detection (the agent's proposal: code, no model) ─────────────────────────

export interface PoolTiming {
  formHours: number
  openHours: number
  payBufferHours: number
}

export const POOL_TIMING_DEFAULT: PoolTiming = { formHours: 12, openHours: 24, payBufferHours: 12 }

export interface PoolCandidate {
  rfqId: string
  msmeId: string
  categoryId: string
  /** details.service_slug from the v3 form; null = not poolable. */
  serviceSlug: string | null
  /** The buyer's state (fan-out's rule: compliance is local); null = not poolable. */
  state: string | null
  hasMustHaves: boolean
  createdAt: string
  expiresAt: string
}

const HOUR = 3600_000

export function poolKey(p: { categoryId: string; serviceSlug: string; state: string }): string {
  return `${p.categoryId}|${p.serviceSlug}|${p.state}`
}

/**
 * Can this request join a NEW pool now? It needs a service and a state, no must-haves (a group is the standard
 * version of a service), and enough of its own clock left for the whole pool: forming + open + the pay buffer.
 */
export function poolCandidateEligible(c: PoolCandidate, now: Date, timing: PoolTiming): boolean {
  if (!c.serviceSlug || !c.state || c.hasMustHaves) return false
  const need = (timing.formHours + timing.openHours + timing.payBufferHours) * HOUR
  return Date.parse(c.expiresAt) - now.getTime() >= need
}

/**
 * Can this request join an EXISTING live pool? A forming pool needs the full remaining window (as for a new pool,
 * measured from now); an open pool needs its fixed closes_at to leave the pay buffer before this request expires.
 */
export function poolCandidateFits(c: PoolCandidate, pool: { status: ServicePoolStatus; closesAt: string | null }, now: Date, timing: PoolTiming): boolean {
  if (!c.serviceSlug || !c.state || c.hasMustHaves) return false
  if (pool.status === 'forming') return poolCandidateEligible(c, now, timing)
  if (pool.status === 'open' && pool.closesAt) return Date.parse(c.expiresAt) - timing.payBufferHours * HOUR >= Date.parse(pool.closesAt)
  return false
}

export interface PoolCluster {
  key: string
  categoryId: string
  serviceSlug: string
  state: string
  /** Earliest-created first; one request per buyer (their newest); at most maxMembers. */
  rfqIds: string[]
}

/**
 * Group eligible candidates by (category, service, state). One request per buyer (their newest), earliest-created
 * first, capped at maxMembers. Only groups of at least minMembers DISTINCT buyers are proposed. Deterministic.
 */
export function clusterPoolCandidates(
  candidates: readonly PoolCandidate[],
  opts: { now: Date; minMembers: number; maxMembers: number; timing: PoolTiming },
): PoolCluster[] {
  const groups = new Map<string, Map<string, PoolCandidate>>()
  for (const c of candidates) {
    if (!poolCandidateEligible(c, opts.now, opts.timing)) continue
    const key = poolKey({ categoryId: c.categoryId, serviceSlug: c.serviceSlug!, state: c.state! })
    const byBuyer = groups.get(key) ?? new Map<string, PoolCandidate>()
    const prev = byBuyer.get(c.msmeId)
    const newer = !prev || c.createdAt > prev.createdAt || (c.createdAt === prev.createdAt && c.rfqId > prev.rfqId)
    if (newer) byBuyer.set(c.msmeId, c)
    groups.set(key, byBuyer)
  }
  const out: PoolCluster[] = []
  for (const [key, byBuyer] of groups) {
    if (byBuyer.size < opts.minMembers) continue
    const members = [...byBuyer.values()]
      .sort((a, b) => (a.createdAt === b.createdAt ? a.rfqId.localeCompare(b.rfqId) : a.createdAt.localeCompare(b.createdAt)))
      .slice(0, opts.maxMembers)
    const first = members[0]!
    out.push({ key, categoryId: first.categoryId, serviceSlug: first.serviceSlug!, state: first.state!, rfqIds: members.map((m) => m.rfqId) })
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

/**
 * When an opening pool closes: the earlier of (opened + open window) and (the earliest joined member's expiry −
 * the pay buffer), so every group quote arrives while its request can still be paid.
 */
export function poolClosesAt(openedAt: Date, memberExpiries: readonly string[], timing: PoolTiming): Date {
  let t = openedAt.getTime() + timing.openHours * HOUR
  for (const e of memberExpiries) t = Math.min(t, Date.parse(e) - timing.payBufferHours * HOUR)
  return new Date(t)
}

// ── the close ────────────────────────────────────────────────────────────────

export interface PoolClosePlanOffer {
  offerId: string
  count: number
  tier: PoolOfferTier | null
}

/**
 * Per offer: how many members were CLAIMED for it (their request's quote slot is held) and the tier that count
 * reaches. Skipped members never count. An offer nobody was claimed for has count 0 and no tier.
 */
export function planPoolClose(
  offers: ReadonlyArray<{ offerId: string; tiers: readonly PoolOfferTier[] }>,
  claimed: ReadonlyArray<{ offerId: string }>,
): PoolClosePlanOffer[] {
  return offers.map((o) => {
    const count = claimed.filter((m) => m.offerId === o.offerId).length
    const t = achievedTier(o.tiers, count)
    return { offerId: o.offerId, count, tier: t ? { min_members: t.min_members, price_paise: t.price_paise } : null }
  })
}

// ── API views (web + mobile read the same shapes) ────────────────────────────

export interface PoolOfferView {
  id: string
  providerName: string
  providerSlug: string | null
  deliveryDays: number
  scope: string
  message: string | null
  gstIncluded: boolean
  validUntil: string
  advancePercent: number | null
  tiers: PoolTierView[]
  /** Members committed to this offer so far (buyers see it; providers never see another offer's count). */
  committedCount: number
  /** False when this provider already quoted or declined the viewer's own request (the direct route stays). */
  availableToMe: boolean
}

export interface PoolBuyerView {
  id: string
  status: ServicePoolStatus
  serviceSlug: string
  categoryName: string
  state: string
  joinedCount: number
  minMembers: number
  formBy: string
  closesAt: string | null
  me: { memberId: string; rfqId: string; status: PoolMemberStatus; committedOfferId: string | null; quoteId: string | null }
  offers: PoolOfferView[]
}
