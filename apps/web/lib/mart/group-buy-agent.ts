/**
 * Group-Buy Agent v1 (MART_DESIGN.md §5) — drafts pools from demand signals
 * and the monthly schedule, and drafts the vernacular one-line pitch for the
 * WhatsApp pool card. Draft-and-approve doctrine: it NEVER opens or awards a
 * pool; the founder confirms every term in the admin worklist and the
 * confirmation (proposed vs final) is written to ai_decisions.
 *
 * Every number in a draft comes from the catalogue, never from a model:
 *   unit price  = the seller's OWN bulk tier at the target quantity (the pool
 *                 gives small buyers the big-order price the seller already
 *                 publishes — nothing is invented)
 *   target qty  = 30-day cluster demand rounded up to the tier step (or 5×
 *                 MOQ when there is no history — the schedule case)
 *   min qty     = the tier's min_qty (the quantity that unlocks the price)
 *   closes_at   = +7 days
 * The optional model call (OpenRouter, temperature 0) only polishes the
 * title and writes the pitch in en/hi/te; without OPENROUTER_API_KEY the
 * stub templates are used and the draft is marked stub.
 */
import 'server-only'
import { resolveTier, poolSaving, type PoolDraft } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { VendorHttpError } from '@/lib/voice/types'
import { getPoolCategories, listPools } from './pools'

type Admin = Awaited<ReturnType<typeof createAdminClient>>
/* eslint-disable @typescript-eslint/no-explicit-any */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite'
const SIGNAL_DAYS = 30
const OPEN_DAYS = 7

export interface PoolProposal {
  draft: PoolDraft
  card_i18n: { en: string; hi: string; te: string }
  product: { id: string; name: string; unit: string; list_price_paise: number | null; seller_name: string }
  signal: { orders: number; qty: number; buyers: number; kind: 'demand' | 'schedule' }
  saving_pct: number
  stub: boolean
  vendor: string
}

interface Candidate {
  product: any
  tiers: { min_qty: number; unit_price_paise: number }[]
  orders: number
  qty: number
  buyers: Set<string>
  orderIds: string[]
}

function roundUpTo(n: number, step: number): number {
  if (step <= 1) return Math.max(1, Math.ceil(n))
  return Math.max(step, Math.ceil(n / step) * step)
}

/**
 * Demand signals: goods orders in the last 30 days, per product, in the
 * pool-enabled categories; plus one scheduled candidate per category (the
 * best-selling or, failing history, the cheapest-tiered active product).
 */
async function candidates(admin: Admin, categories: string[]): Promise<Candidate[]> {
  const since = new Date(Date.now() - SIGNAL_DAYS * 86_400_000).toISOString()
  const { data: orders } = await admin
    .from('orders')
    .select('id, msme_id, line_items, status, created_at')
    .eq('kind', 'goods')
    .gte('created_at', since)
    .not('status', 'in', '("cancelled_by_buyer","auto_cancelled","refunded")')
    .limit(2000)
  const byProduct = new Map<string, Candidate>()
  for (const o of orders ?? []) {
    for (const li of (o.line_items ?? []) as { product_id: string; qty: number }[]) {
      const c = byProduct.get(li.product_id) ?? { product: null, tiers: [], orders: 0, qty: 0, buyers: new Set<string>(), orderIds: [] }
      c.orders += 1
      c.qty += Number(li.qty)
      c.buyers.add(o.msme_id)
      c.orderIds.push(o.id)
      byProduct.set(li.product_id, c)
    }
  }
  const { data: products } = await admin
    .from('products')
    .select('id, name, unit, category_slug, list_price_paise, min_order_qty, status, seller_id, seller:provider_profiles!inner(display_name, status, sells_goods), tiers:price_tiers(min_qty, unit_price_paise)')
    .eq('status', 'active')
    .is('deleted_at', null)
    .in('category_slug', categories)
  const out: Candidate[] = []
  const seenCategory = new Set<string>()
  const active = (products ?? []).filter((p: any) => {
    const s = Array.isArray(p.seller) ? p.seller[0] : p.seller
    return s?.status === 'active' && s?.sells_goods
  })
  // Demand-backed first (most units), then one schedule candidate per category without demand.
  const withDemand = active
    .filter((p: any) => byProduct.has(p.id))
    .sort((a: any, b: any) => byProduct.get(b.id)!.qty - byProduct.get(a.id)!.qty)
  for (const p of withDemand) {
    const c = byProduct.get(p.id)!
    c.product = p
    c.tiers = (p.tiers ?? []).map((t: any) => ({ min_qty: Number(t.min_qty), unit_price_paise: Number(t.unit_price_paise) }))
    out.push(c)
    seenCategory.add(p.category_slug)
  }
  for (const cat of categories) {
    if (seenCategory.has(cat)) continue
    const pick = active
      .filter((p: any) => p.category_slug === cat && (p.tiers ?? []).length >= 2)
      .sort((a: any, b: any) => Number(a.list_price_paise ?? 0) - Number(b.list_price_paise ?? 0))[0]
    if (!pick) continue
    out.push({
      product: pick,
      tiers: (pick.tiers ?? []).map((t: any) => ({ min_qty: Number(t.min_qty), unit_price_paise: Number(t.unit_price_paise) })),
      orders: 0,
      qty: 0,
      buyers: new Set(),
      orderIds: [],
    })
  }
  return out
}

function stubCard(title: string, savingPct: number): { en: string; hi: string; te: string } {
  const s = savingPct > 0 ? `${savingPct}%` : ''
  return {
    en: s ? `Buy ${title} together and save ${s} — AMC members only.` : `Buy ${title} together at the bulk price — AMC members only.`,
    hi: s ? `${title} साथ खरीदें, ${s} बचाएँ — सिर्फ़ AMC सदस्यों के लिए।` : `${title} साथ खरीदें, थोक दाम पर — सिर्फ़ AMC सदस्यों के लिए।`,
    te: s ? `${title} కలిసి కొనండి, ${s} ఆదా చేయండి — AMC సభ్యులకు మాత్రమే.` : `${title} కలిసి కొనండి, హోల్‌సేల్ ధరకే — AMC సభ్యులకు మాత్రమే.`,
  }
}

async function polish(title: string, savingPct: number, unit: string): Promise<{ title: string; card: { en: string; hi: string; te: string }; stub: boolean; vendor: string }> {
  const key = process.env['OPENROUTER_API_KEY']
  const model = process.env['GROUP_BUY_AGENT_MODEL'] ?? process.env['CATALOG_AGENT_MODEL'] ?? DEFAULT_MODEL
  if (!key) return { title, card: stubCard(title, savingPct), stub: true, vendor: 'stub' }
  const prompt = `You write one-line WhatsApp pitches for an Indian MSME group-buy of industrial consumables. Return ONLY JSON: {"title": string, "en": string, "hi": string, "te": string}. title ≤ 60 chars, product-first. Each pitch ≤ 110 chars, plain, no emoji, no prices (numbers are added separately), mention the saving "${savingPct}%" if > 0. hi = Hindi in Devanagari, te = Telugu script. Product: "${title}" sold per ${unit}.`
  try {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' } }),
    })
    if (!res.ok) throw new VendorHttpError('openrouter', res.status, await res.text().catch(() => ''))
    const d = await res.json()
    const raw = JSON.parse(d.choices?.[0]?.message?.content ?? '{}')
    const clean = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)
    const fallback = stubCard(title, savingPct)
    return {
      title: clean(raw.title, 140) ?? title,
      card: { en: clean(raw.en, 160) ?? fallback.en, hi: clean(raw.hi, 160) ?? fallback.hi, te: clean(raw.te, 160) ?? fallback.te },
      stub: false,
      vendor: `openrouter:${model}`,
    }
  } catch (e) {
    console.error('[group-buy-agent polish]', e instanceof Error ? e.message : e)
    return { title, card: stubCard(title, savingPct), stub: true, vendor: 'stub' }
  }
}

/** Propose pools (not persisted). One per product; skips products that already have a live pool. */
export async function proposePools(admin: Admin, opts: { limit?: number } = {}): Promise<PoolProposal[]> {
  const categories = await getPoolCategories(admin)
  if (categories.length === 0) return []
  const live = await listPools(admin, { statuses: ['draft', 'open', 'closed_met'], limit: 500 })
  const liveProducts = new Set(live.map((p) => p.product_id).filter(Boolean))
  const out: PoolProposal[] = []
  for (const c of await candidates(admin, categories)) {
    if (out.length >= (opts.limit ?? 6)) break
    const p = c.product
    if (liveProducts.has(p.id)) continue
    const tiers = [...c.tiers].sort((a, b) => a.min_qty - b.min_qty)
    if (tiers.length < 2) continue
    const bulk = tiers[tiers.length - 1]!
    const list = tiers[0]!
    const moq = Number(p.min_order_qty ?? 1)
    const demand = c.qty > 0 ? c.qty * 1.5 : bulk.min_qty * 5
    const targetQty = roundUpTo(Math.max(demand, bulk.min_qty, moq * 5), bulk.min_qty)
    const tier = resolveTier(tiers, targetQty) ?? bulk
    const listPrice = Number(p.list_price_paise ?? list.unit_price_paise)
    if (tier.unit_price_paise >= listPrice) continue
    const saving = poolSaving(tier.unit_price_paise, listPrice)
    const polished = await polish(p.name, saving.pct, p.unit)
    const seller = Array.isArray(p.seller) ? p.seller[0] : p.seller
    out.push({
      draft: {
        product_id: p.id,
        category_slug: p.category_slug,
        title: polished.title,
        spec: null,
        unit: p.unit,
        target_qty: targetQty,
        min_qty: tier.min_qty,
        unit_price_paise: tier.unit_price_paise,
        closes_at: new Date(Date.now() + OPEN_DAYS * 86_400_000).toISOString(),
        rationale: {
          signal: c.qty > 0 ? 'orders_30d' : 'monthly_schedule',
          order_ids: c.orderIds.slice(0, 50),
          orders: c.orders,
          qty_30d: c.qty,
          buyers: c.buyers.size,
          tier_min_qty: tier.min_qty,
          list_price_paise: listPrice,
          agent: polished.vendor,
        },
      },
      card_i18n: polished.card,
      product: { id: p.id, name: p.name, unit: p.unit, list_price_paise: listPrice, seller_name: seller?.display_name ?? '' },
      signal: { orders: c.orders, qty: c.qty, buyers: c.buyers.size, kind: c.qty > 0 ? 'demand' : 'schedule' },
      saving_pct: saving.pct,
      stub: polished.stub,
      vendor: polished.vendor,
    })
  }
  return out
}
