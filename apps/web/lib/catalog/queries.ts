/**
 * Server-side catalog data layer. Public reads go through the cookie-less anon
 * client (RLS-enforced, ISR-friendly). Verification badges are the one
 * exception: provider_verifications is owner/admin-only under RLS, so badges
 * are read with the admin client server-side, projecting ONLY kind + status
 * (never the underlying value — no GSTIN/PAN/bank leak). §2.5 rule 1.
 */
import 'server-only'
import { createPublicClient, createAdminClient } from '@/lib/supabase/server'
import type {
  CatalogResult,
  CategoryRow,
  PackageDetail,
  ProviderDetail,
  ReviewRow,
  SearchFilters,
  SearchResponse,
  VerificationBadge,
  I18nText,
} from './types'

// ─── Row mappers ──────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
function mapSearchRow(r: any): CatalogResult {
  return {
    packageId: r.package_id,
    packageSlug: r.package_slug,
    titleI18n: r.title_i18n,
    pricePaise: Number(r.price_paise),
    discountBps: r.discount_bps,
    memberExtraDiscountBps: r.member_extra_discount_bps,
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
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ─── Search ───────────────────────────────────────────────────────────────────

export async function searchPackages(filters: SearchFilters): Promise<SearchResponse> {
  const supabase = createPublicClient()
  const limit = Math.min(filters.limit ?? 20, 48)
  const offset = filters.offset ?? 0

  const { data, error } = await supabase.rpc('search_packages', {
    p_query: filters.query ?? null,
    p_category_slug: filters.categorySlug ?? null,
    p_state: filters.state ?? null,
    p_min_price: filters.minPrice ?? null,
    p_max_price: filters.maxPrice ?? null,
    p_min_rating: filters.minRating ?? null,
    p_language: filters.language ?? null,
    p_verified_only: filters.verifiedOnly ?? false,
    p_sort: filters.sort ?? 'rating',
    p_limit: limit,
    p_offset: offset,
  })

  if (error) {
    console.error('[searchPackages]', error)
    return { results: [], total: 0, nextOffset: null }
  }

  const rows = (data ?? []) as Record<string, unknown>[]
  const total = rows.length > 0 ? Number(rows[0]!['total_count']) : 0
  const results = rows.map(mapSearchRow)
  const nextOffset = offset + results.length < total ? offset + limit : null
  return { results, total, nextOffset }
}

// ─── Categories ─────────────────────────────────────────────────────────────��─

export async function getCategories(): Promise<CategoryRow[]> {
  const supabase = createPublicClient()
  const { data, error } = await supabase
    .from('categories')
    .select('id, slug, name_i18n, description_i18n, icon, sort_order')
    .eq('is_active', true)
    .is('parent_id', null)
    .order('sort_order', { ascending: true })

  if (error) {
    console.error('[getCategories]', error)
    return []
  }
  return (data ?? []).map((c) => ({
    id: c.id,
    slug: c.slug,
    nameI18n: c.name_i18n as I18nText,
    descriptionI18n: (c.description_i18n as I18nText) ?? null,
    icon: c.icon,
    sortOrder: c.sort_order,
  }))
}

export async function getCategoryBySlug(slug: string): Promise<CategoryRow | null> {
  const supabase = createPublicClient()
  const { data } = await supabase
    .from('categories')
    .select('id, slug, name_i18n, description_i18n, icon, sort_order')
    .eq('slug', slug)
    .eq('is_active', true)
    .maybeSingle()
  if (!data) return null
  return {
    id: data.id,
    slug: data.slug,
    nameI18n: data.name_i18n as I18nText,
    descriptionI18n: (data.description_i18n as I18nText) ?? null,
    icon: data.icon,
    sortOrder: data.sort_order,
  }
}

// ─── Providers ──────────────────────────────────────────────────────────────��─

async function getProviderBadges(providerId: string): Promise<VerificationBadge[]> {
  // Admin client, server-only, projecting kind+status ONLY. Never select `value`.
  // Badges are non-critical trust signals — never let a fetch failure crash a
  // public page.
  if (!process.env['SUPABASE_SERVICE_ROLE_KEY']) return []
  try {
    const admin = await createAdminClient()
    const { data } = await admin
      .from('provider_verifications')
      .select('kind, status')
      .eq('provider_id', providerId)
      .in('status', ['manually_approved', 'api_verified'])
    const badges = (data ?? []).map((v) => ({ kind: v.kind, status: v.status }))
    // S0.4 — "Udyam verified" is a profile fact set only by a real (non-stub)
    // /kyc/verify-udyam result, not a provider_verifications row.
    const { data: prof } = await admin.from('provider_profiles').select('udyam_verified').eq('id', providerId).maybeSingle()
    if (prof?.udyam_verified) badges.push({ kind: 'udyam', status: 'api_verified' })
    return badges
  } catch (e) {
    console.error('[getProviderBadges]', e)
    return []
  }
}

export async function getProviderBySlug(slug: string): Promise<ProviderDetail | null> {
  const supabase = createPublicClient()
  // Explicit safe columns only — never gstin/pan even though the active-row
  // policy would permit them.
  const { data: p } = await supabase
    .from('provider_profiles')
    .select(
      'id, display_name, slug, about, logo_url, state, city, languages, avg_rating, review_count, completed_orders, median_response_minutes, top_rated, created_at',
    )
    .eq('slug', slug)
    .eq('status', 'active')
    .is('deleted_at', null)
    .maybeSingle()

  if (!p) return null

  const { data: cats } = await supabase
    .from('provider_categories')
    .select('category:categories(slug, name_i18n)')
    .eq('provider_id', p.id)

  const badges = await getProviderBadges(p.id)

  return {
    id: p.id,
    displayName: p.display_name,
    slug: p.slug,
    about: p.about,
    logoUrl: p.logo_url,
    state: p.state,
    city: p.city,
    languages: p.languages ?? [],
    avgRating: Number(p.avg_rating ?? 0),
    reviewCount: p.review_count ?? 0,
    completedOrders: p.completed_orders ?? 0,
    medianResponseMinutes: p.median_response_minutes,
    topRated: p.top_rated ?? false,
    createdAt: p.created_at,
    /* eslint-disable @typescript-eslint/no-explicit-any */
    categories: (cats ?? []).map((c: any) => ({
      slug: c.category?.slug,
      nameI18n: c.category?.name_i18n,
    })).filter((c: any) => c.slug),
    /* eslint-enable @typescript-eslint/no-explicit-any */
    badges,
  }
}

/** Top-rated active providers for the landing strip. avg_rating is text → sort in app. */
export async function getTopRatedProviders(limit = 8): Promise<ProviderDetail[]> {
  const supabase = createPublicClient()
  const { data } = await supabase
    .from('provider_profiles')
    .select(
      'id, display_name, slug, about, logo_url, state, city, languages, avg_rating, review_count, completed_orders, median_response_minutes, top_rated, created_at',
    )
    .eq('status', 'active')
    .is('deleted_at', null)
    .limit(50)

  const sorted = (data ?? [])
    .map((p) => ({ p, r: Number(p.avg_rating ?? 0) }))
    .sort((a, b) => b.r - a.r)
    .slice(0, limit)

  // Badges in parallel
  return Promise.all(
    sorted.map(async ({ p }) => ({
      id: p.id,
      displayName: p.display_name,
      slug: p.slug,
      about: p.about,
      logoUrl: p.logo_url,
      state: p.state,
      city: p.city,
      languages: p.languages ?? [],
      avgRating: Number(p.avg_rating ?? 0),
      reviewCount: p.review_count ?? 0,
      completedOrders: p.completed_orders ?? 0,
      medianResponseMinutes: p.median_response_minutes,
      topRated: p.top_rated ?? false,
      createdAt: p.created_at,
      categories: [],
      badges: await getProviderBadges(p.id),
    })),
  )
}

// ─── Packages ───────────────────────────────────────────────────────────────��─

export interface ProviderPackage {
  slug: string
  titleI18n: I18nText
  pricePaise: number
  discountBps: number
  memberExtraDiscountBps: number
  deliveryDays: number
  revisionCount: number
  categorySlug: string
}

export async function getPackagesForProvider(providerId: string): Promise<ProviderPackage[]> {
  const supabase = createPublicClient()
  const { data } = await supabase
    .from('packages')
    .select(
      'slug, title_i18n, price_paise, discount_bps, member_extra_discount_bps, delivery_days, revision_count, category:categories(slug)',
    )
    .eq('provider_id', providerId)
    .eq('status', 'active')
    .is('deleted_at', null)
    .order('price_paise', { ascending: true })

  /* eslint-disable @typescript-eslint/no-explicit-any */
  return (data ?? []).map((pk: any) => ({
    slug: pk.slug,
    titleI18n: pk.title_i18n,
    pricePaise: Number(pk.price_paise),
    discountBps: pk.discount_bps,
    memberExtraDiscountBps: pk.member_extra_discount_bps,
    deliveryDays: pk.delivery_days,
    revisionCount: pk.revision_count,
    categorySlug: pk.category?.slug ?? '',
  }))
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

export async function getPackageDetail(
  providerSlug: string,
  packageSlug: string,
): Promise<{ provider: ProviderDetail; pkg: PackageDetail } | null> {
  const provider = await getProviderBySlug(providerSlug)
  if (!provider) return null

  const supabase = createPublicClient()
  const { data: pk } = await supabase
    .from('packages')
    .select(
      'id, slug, title_i18n, scope_included, scope_excluded, deliverables, requirements_template, price_paise, discount_bps, member_extra_discount_bps, delivery_days, revision_count, faqs, category:categories(slug, name_i18n)',
    )
    .eq('provider_id', provider.id)
    .eq('slug', packageSlug)
    .eq('status', 'active')
    .is('deleted_at', null)
    .maybeSingle()

  if (!pk) return null

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const cat = pk.category as any
  const pkg: PackageDetail = {
    id: pk.id,
    slug: pk.slug,
    titleI18n: pk.title_i18n as I18nText,
    scopeIncluded: (pk.scope_included as string[]) ?? [],
    scopeExcluded: (pk.scope_excluded as string[]) ?? [],
    deliverables: (pk.deliverables as string[]) ?? [],
    requirementsTemplate: pk.requirements_template,
    pricePaise: Number(pk.price_paise),
    discountBps: pk.discount_bps,
    memberExtraDiscountBps: pk.member_extra_discount_bps,
    deliveryDays: pk.delivery_days,
    revisionCount: pk.revision_count,
    faqs: (pk.faqs as { q: string; a: string }[]) ?? [],
    categorySlug: cat?.slug ?? '',
    categoryNameI18n: cat?.name_i18n ?? { en: '' },
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return { provider, pkg }
}

// ─── Reviews ────────────────────────────────────────────────────────────────��─

export async function getReviews(
  providerId: string,
  limit = 10,
  offset = 0,
): Promise<{ reviews: ReviewRow[]; total: number }> {
  const supabase = createPublicClient()
  const { data, count } = await supabase
    .from('reviews')
    .select('id, rating, text, provider_reply, created_at', { count: 'exact' })
    .eq('provider_id', providerId)
    .eq('status', 'published')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  const reviews: ReviewRow[] = (data ?? []).map((r) => ({
    id: r.id,
    rating: r.rating,
    body: r.text,
    authorName: null, // msme identity intentionally not exposed publicly
    providerReply: r.provider_reply,
    createdAt: r.created_at,
  }))
  return { reviews, total: count ?? 0 }
}

/** All active provider + category slugs — for the XML sitemap. */
export async function getAllPublicSlugs(): Promise<{
  providers: string[]
  packages: { providerSlug: string; packageSlug: string }[]
}> {
  const supabase = createPublicClient()
  const { data: provs } = await supabase
    .from('provider_profiles')
    .select('id, slug')
    .eq('status', 'active')
    .is('deleted_at', null)

  const providerSlugById = new Map((provs ?? []).map((p) => [p.id, p.slug]))

  const { data: pkgs } = await supabase
    .from('packages')
    .select('slug, provider_id')
    .eq('status', 'active')
    .is('deleted_at', null)

  const packages = (pkgs ?? [])
    .map((pk) => {
      const providerSlug = providerSlugById.get(pk.provider_id)
      return providerSlug ? { providerSlug, packageSlug: pk.slug } : null
    })
    .filter((x): x is { providerSlug: string; packageSlug: string } => x !== null)

  return { providers: (provs ?? []).map((p) => p.slug), packages }
}
