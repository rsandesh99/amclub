/**
 * Experience v3 E2 (FR-2.1) — search v2: search_packages_v2 + search_facets_v2
 * (migration 0051) through the anon client (SECURITY DEFINER RPCs over active
 * rows only). Any v2 error falls back to the v1 RPC with the filters it knows,
 * so a deploy ahead of the migration keeps search working (facets absent).
 */
import 'server-only'
import {
  isWeakSearch,
  PRICE_BANDS,
  priceDisplay,
  searchV2Window,
  toSearchFacets,
  type SearchFacets,
  type SearchV2,
} from '@amclub/shared'
import { createPublicClient } from '@/lib/supabase/server'
import { searchPackages } from './queries'
import type { CatalogResult } from './types'

export interface SearchV2Result {
  results: CatalogResult[]
  total: number
  facets: SearchFacets | null
  weak: boolean
  /** False when the v1 fallback answered. */
  v2: boolean
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapRow(r: any): CatalogResult {
  return {
    packageId: r.package_id,
    packageSlug: r.package_slug,
    titleI18n: r.title_i18n,
    pricePaise: Number(r.price_paise),
    discountBps: r.discount_bps,
    memberExtraDiscountBps: r.member_extra_discount_bps,
    display: priceDisplay({ pricePaise: Number(r.price_paise), discountBps: r.discount_bps, memberExtraDiscountBps: r.member_extra_discount_bps }),
    deliveryDays: r.delivery_days,
    revisionCount: r.revision_count,
    categoryId: r.category_id,
    categorySlug: r.category_slug,
    categoryNameI18n: r.category_name_i18n,
    providerId: r.provider_id,
    providerSlug: r.provider_slug,
    displayName: r.display_name,
    logoUrl: r.logo_url,
    state: r.state,
    city: r.city,
    languages: r.languages ?? [],
    avgRating: Number(r.avg_rating ?? 0),
    reviewCount: r.review_count ?? 0,
    completedOrders: r.completed_orders ?? 0,
    medianResponseMinutes: r.median_response_minutes,
    topRated: r.top_rated ?? false,
    verified: r.verified ?? false,
    headlineCredential: r.headline_credential ?? null,
    serviceSlug: r.service_slug ?? null,
    textRank: r.text_rank === null || r.text_rank === undefined ? null : Number(r.text_rank),
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function rpcArgs(s: SearchV2) {
  const band = s.price ? (PRICE_BANDS[s.price] as { min?: number; max?: number }) : null
  return {
    p_query: s.query ?? null,
    p_category_slug: s.category ?? null,
    p_service_slug: s.service ?? null,
    p_state: s.state ?? null,
    p_city: s.city ?? null,
    p_credential: s.credential ?? null,
    p_response_max_minutes: s.responseMaxHours ? s.responseMaxHours * 60 : null,
    p_delivery_max_days: s.deliveryMaxDays ?? null,
    p_min_price: band?.min ?? null,
    p_max_price: band?.max ?? null,
    p_min_rating: s.minRating ?? null,
    p_language: s.language ?? null,
    p_verified_only: s.verifiedOnly === true,
  }
}

export async function searchCatalogV2(s: SearchV2, opts: { withFacets?: boolean } = {}): Promise<SearchV2Result> {
  const supabase = createPublicClient()
  const { limit, offset } = searchV2Window(s)
  const args = rpcArgs(s)
  const [rows, facetRows] = await Promise.all([
    supabase.rpc('search_packages_v2', { ...args, p_sort: s.sort ?? 'best', p_limit: limit, p_offset: offset }),
    opts.withFacets === false ? Promise.resolve({ data: null, error: null }) : supabase.rpc('search_facets_v2', args),
  ])

  if (rows.error) {
    console.error('[searchCatalogV2] falling back to v1', rows.error.message)
    const band = s.price ? (PRICE_BANDS[s.price] as { min?: number; max?: number }) : null
    const v1 = await searchPackages({
      ...(s.query ? { query: s.query } : {}),
      ...(s.category ? { categorySlug: s.category } : {}),
      ...(s.state ? { state: s.state } : {}),
      ...(band?.min !== undefined ? { minPrice: band.min } : {}),
      ...(band?.max !== undefined ? { maxPrice: band.max } : {}),
      ...(s.minRating !== undefined ? { minRating: s.minRating } : {}),
      ...(s.language ? { language: s.language } : {}),
      ...(s.verifiedOnly ? { verifiedOnly: true } : {}),
      ...(s.sort && s.sort !== 'best' && s.sort !== 'fastest' ? { sort: s.sort } : {}),
      limit,
      offset,
    })
    return { results: v1.results, total: v1.total, facets: null, weak: isWeakSearch({ total: v1.total, topRank: null, hasQuery: false }), v2: false }
  }

  const data = (rows.data ?? []) as Record<string, unknown>[]
  const results = data.map(mapRow)
  const total = data.length > 0 ? Number(data[0]!['total_count']) : 0
  const topRank = results.reduce<number | null>((m, r) => (r.textRank !== null && r.textRank !== undefined && (m === null || r.textRank > m) ? r.textRank : m), null)
  return {
    results,
    total,
    facets: facetRows.error || !facetRows.data ? null : toSearchFacets(facetRows.data as { facet: string; value: string | null; n: number }[]),
    weak: isWeakSearch({ total, topRank, hasQuery: !!s.query }),
    v2: true,
  }
}
