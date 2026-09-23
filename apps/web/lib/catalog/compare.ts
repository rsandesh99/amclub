/**
 * Experience v3 E2 FR-2.9 (N34) — the shortlist compare: up to 4 of the
 * buyer's shortlisted packages, public data only (anon client, active rows),
 * each with its server price display and the provider's buyer-safe trust
 * facts. The same fields for every column, so the rows always line up.
 */
import 'server-only'
import { packageTierSchema, priceDisplay, type PackageTier, type PriceDisplay } from '@amclub/shared'
import { createPublicClient } from '@/lib/supabase/server'
import { getProviderTrust, type ProviderTrust } from '@/lib/trust/provider-trust'
import type { I18nText } from './types'

export const COMPARE_MAX_ITEMS = 4

export interface CompareColumn {
  packageId: string
  packageSlug: string
  titleI18n: I18nText
  categorySlug: string
  providerSlug: string
  providerName: string
  display: PriceDisplay
  deliveryDays: number
  revisionCount: number
  avgRating: number
  reviewCount: number
  completedOrders: number
  tier: PackageTier | null
  trust: ProviderTrust | null
}

/** `items` from the URL → at most 4 distinct UUIDs, in order. */
export function parseCompareItems(raw: string | undefined): string[] {
  const out: string[] = []
  for (const id of (raw ?? '').split(',')) {
    const v = id.trim().toLowerCase()
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) && !out.includes(v)) out.push(v)
    if (out.length === COMPARE_MAX_ITEMS) break
  }
  return out
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function getCompareColumns(ids: string[], opts: { withTrust: boolean }): Promise<CompareColumn[]> {
  if (ids.length === 0) return []
  const supabase = createPublicClient()
  const { data } = await supabase
    .from('packages')
    .select('id, slug, title_i18n, price_paise, discount_bps, member_extra_discount_bps, delivery_days, revision_count, provider_id, category:categories(slug), provider:provider_profiles!inner(slug, display_name, avg_rating, review_count, completed_orders, status, deleted_at)')
    .in('id', ids)
    .eq('status', 'active')
    .is('deleted_at', null)
  const rows = ((data ?? []) as any[]).filter((r) => r.provider?.status === 'active' && !r.provider?.deleted_at)
  // Tier (0050) is read separately so a database without it still compares.
  const tiers = new Map<string, PackageTier>()
  const { data: tierRows, error: tierErr } = await supabase.from('packages').select('id, tier').in('id', rows.map((r) => r.id))
  if (!tierErr) for (const r of (tierRows ?? []) as any[]) { const t = packageTierSchema.safeParse(r.tier); if (t.success) tiers.set(r.id, t.data) }
  const trust = new Map<string, ProviderTrust>()
  if (opts.withTrust) {
    const providers = [...new Set(rows.map((r) => r.provider_id as string))]
    const got = await Promise.all(providers.map(async (p) => [p, await getProviderTrust(p)] as const))
    for (const [p, tr] of got) trust.set(p, tr)
  }
  const cols = rows.map((r): CompareColumn => ({
    packageId: r.id,
    packageSlug: r.slug,
    titleI18n: r.title_i18n,
    categorySlug: r.category?.slug ?? '',
    providerSlug: r.provider.slug,
    providerName: r.provider.display_name,
    display: priceDisplay({ pricePaise: Number(r.price_paise), discountBps: r.discount_bps, memberExtraDiscountBps: r.member_extra_discount_bps }),
    deliveryDays: r.delivery_days,
    revisionCount: r.revision_count,
    avgRating: Number(r.provider.avg_rating ?? 0),
    reviewCount: r.provider.review_count ?? 0,
    completedOrders: r.provider.completed_orders ?? 0,
    tier: tiers.get(r.id) ?? null,
    trust: trust.get(r.provider_id) ?? null,
  }))
  // Keep the buyer's order.
  return ids.map((id) => cols.find((c) => c.packageId === id)).filter((c): c is CompareColumn => !!c)
}
/* eslint-enable @typescript-eslint/no-explicit-any */
