import 'server-only'
import {
  isPriceChanged,
  ORDER_REPEATABLE_STATUSES,
  orderPriceDisplay,
  PACKAGE_TIERS,
  pickBuyAgainOrders,
  priceDisplay,
  repeatRequirementHref,
  searchV2ToQueryString,
  type BuyAgain,
  type PackageTier,
} from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

const ORDER_COLS = 'id, title, kind, source, package_id, quote_id, status, price_paise, discount_paise, gst_paise, total_paise, completed_at, created_at, provider:provider_profiles(display_name)'

type OrderRow = {
  id: string
  title: string | null
  kind: string | null
  source: string
  package_id: string | null
  quote_id: string | null
  status: string
  price_paise: number
  discount_paise: number
  gst_paise: number
  total_paise: number
  completed_at: string | null
  created_at: string
  provider: { display_name: string | null } | { display_name: string | null }[] | null
}

type PackageRow = {
  id: string
  status: string
  price_paise: number
  discount_bps: number
  member_extra_discount_bps: number | null
  tier: string | null
  service_slug: string | null
  category: { slug: string } | { slug: string }[] | null
  provider: { status: string; capacity_paused: boolean | null } | { status: string; capacity_paused: boolean | null }[] | null
}

const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v)

/**
 * FR-9.3 — what "again" means for one finished order. A package order that can
 * still be bought → today's server price beside what it charged then; a paused
 * or removed package (or provider) → "Find similar" in search; a quote order →
 * the existing repost. Read-only; checkout prices the new order as usual.
 */
async function resolveBuyAgain(admin: Admin, o: OrderRow): Promise<BuyAgain | null> {
  const common = { orderId: o.id, title: o.title ?? '', providerName: one(o.provider)?.display_name ?? null }
  if (o.source === 'quote') {
    if (!o.quote_id) return null
    const { data: q } = await admin.from('quotes').select('rfq_id').eq('id', o.quote_id).maybeSingle()
    if (!q?.rfq_id) return null
    return { kind: 'repeat', ...common, rfqId: q.rfq_id as string, href: repeatRequirementHref(q.rfq_id as string) }
  }
  if (!o.package_id) return null
  const { data } = await admin
    .from('packages')
    .select('id, status, price_paise, discount_bps, member_extra_discount_bps, tier, service_slug, category:categories(slug), provider:provider_profiles(status, capacity_paused)')
    .eq('id', o.package_id)
    .maybeSingle()
  const pkg = data as unknown as PackageRow | null
  const prov = pkg ? one(pkg.provider) : null
  if (!pkg || pkg.status !== 'active' || prov?.status !== 'active' || prov.capacity_paused) {
    const category = pkg ? one(pkg.category)?.slug : undefined
    const qs = searchV2ToQueryString({ ...(category ? { category } : {}), ...(pkg?.service_slug ? { service: pkg.service_slug } : {}) })
    return { kind: 'similar', ...common, searchHref: `/app/search${qs ? `?${qs}` : ''}` }
  }
  const displayThen = orderPriceDisplay({ pricePaise: Number(o.price_paise), discountPaise: Number(o.discount_paise), gstPaise: Number(o.gst_paise), totalPaise: Number(o.total_paise) })
  const displayNow = priceDisplay({ pricePaise: Number(pkg.price_paise), discountBps: Number(pkg.discount_bps), memberExtraDiscountBps: Number(pkg.member_extra_discount_bps ?? 0) })
  const tier = (PACKAGE_TIERS as readonly string[]).includes(pkg.tier ?? '') ? (pkg.tier as PackageTier) : null
  return { kind: 'package', ...common, packageId: pkg.id, tier, displayThen, displayNow, priceChanged: isPriceChanged(displayThen, displayNow), href: `/app/checkout/${pkg.id}` }
}

export type BuyAgainLookup = { ok: true; value: BuyAgain } | { ok: false; status: 404 | 409; code: 'not_found' | 'not_completed' | 'unavailable' }

/** One order of the caller's own (buyer side only; goods orders follow the Mart flow). */
export async function getBuyAgainForOrder(userId: string, orderId: string): Promise<BuyAgainLookup> {
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.msmeId) return { ok: false, status: 404, code: 'not_found' }
  const { data } = await admin.from('orders').select(ORDER_COLS).eq('id', orderId).eq('msme_id', actor.msmeId).maybeSingle()
  const o = data as unknown as OrderRow | null
  if (!o || o.kind === 'goods') return { ok: false, status: 404, code: 'not_found' }
  if (!(ORDER_REPEATABLE_STATUSES as readonly string[]).includes(o.status)) return { ok: false, status: 409, code: 'not_completed' }
  const value = await resolveBuyAgain(admin, o)
  return value ? { ok: true, value } : { ok: false, status: 404, code: 'unavailable' }
}

/** The home's "Buy again" shelf: up to 4 finished package orders, newest first, one per package. */
export async function listBuyAgainShelf(userId: string): Promise<BuyAgain[]> {
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.msmeId) return []
  const { data } = await admin
    .from('orders')
    .select(ORDER_COLS)
    .eq('msme_id', actor.msmeId)
    .eq('source', 'package')
    .in('status', [...ORDER_REPEATABLE_STATUSES])
    .order('completed_at', { ascending: false, nullsFirst: false })
    .limit(50)
  const rows = ((data ?? []) as unknown as OrderRow[]).filter((o) => o.kind !== 'goods')
  const picked = pickBuyAgainOrders(rows.map((o) => ({ ...o, packageId: o.package_id, completedAt: o.completed_at, createdAt: o.created_at })))
  const out = await Promise.all(picked.map((o) => resolveBuyAgain(admin, o)))
  return out.filter((x): x is BuyAgain => x !== null)
}
