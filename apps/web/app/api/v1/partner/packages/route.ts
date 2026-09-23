import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getSessionUser } from '@/lib/auth/session'
import { packageSchema, isSpecializationOf } from '@amclub/shared'
import { toPackageRow, slugify } from '@/lib/partner/packageRow'
import { revalidateCatalog } from '@/lib/catalog/revalidate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { isOnFor } from '@/lib/experiments'
import { pickLocale } from '@amclub/shared'

/**
 * GET /api/v1/partner/packages (PRD Experience v3 E13, flag `mobile`) — the
 * provider's own listings for the mobile Listings tab: status, list price and
 * discount as stored (server paise; no client math), category. Web renders
 * the same rows server-side on /partner/listings. 404 while the flag is off.
 */
export async function GET(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isOnFor('mobile', userId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const locale = request.nextUrl.searchParams.get('locale') ?? 'en'
  const { data } = await admin
    .from('packages')
    .select('id, slug, title_i18n, price_paise, discount_bps, status, delivery_days, category:categories(slug, name_i18n), provider:provider_profiles!inner(slug)')
    .eq('provider_id', actor.providerId)
    .neq('status', 'removed')
    .order('created_at', { ascending: false })
    .limit(200)
  const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? v[0] ?? null : v ?? null)
  const listings = (data ?? []).map((p) => {
    const cat = one(p.category as { slug: string; name_i18n: { en: string; hi?: string; te?: string } } | { slug: string; name_i18n: { en: string; hi?: string; te?: string } }[] | null)
    const prov = one(p.provider as { slug: string } | { slug: string }[] | null)
    return {
      id: p.id as string,
      slug: p.slug as string,
      providerSlug: prov?.slug ?? null,
      title: pickLocale(p.title_i18n as { en: string; hi?: string; te?: string }, locale),
      status: p.status as string,
      pricePaise: Number(p.price_paise),
      discountBps: Number(p.discount_bps ?? 0),
      deliveryDays: (p.delivery_days as number | null) ?? null,
      categorySlug: cat?.slug ?? null,
      categoryName: cat ? pickLocale(cat.name_i18n, locale) : null,
    }
  })
  return NextResponse.json({ listings }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!user.roles.includes('provider')) {
    return NextResponse.json({ error: 'Provider role required' }, { status: 403 })
  }

  const json = await request.json().catch(() => null)
  const parsed = packageSchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }
  const d = parsed.data
  // Experience v3 E2 — a service must belong to the package's category.
  if (d.service_slug && !isSpecializationOf(d.category_slug, d.service_slug)) {
    return NextResponse.json({ error: 'invalid_service' }, { status: 422 })
  }

  // RLS session client — the provider crud-own policy enforces ownership.
  const supabase = await createClient()

  const { data: provider } = await supabase
    .from('provider_profiles')
    .select('id, slug')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!provider) {
    return NextResponse.json({ error: 'No provider profile' }, { status: 404 })
  }

  const { data: category } = await supabase
    .from('categories')
    .select('id')
    .eq('slug', d.category_slug)
    .maybeSingle()
  if (!category) {
    return NextResponse.json({ error: 'Invalid category' }, { status: 422 })
  }

  const slug = `${slugify(d.title)}-${Math.random().toString(36).slice(2, 7)}`

  const { data: pkg, error } = await supabase
    .from('packages')
    .insert({
      provider_id: provider.id,
      slug,
      ...toPackageRow(d, category.id),
    })
    .select('id, slug')
    .single()

  if (error || !pkg) {
    console.error('[partner/packages POST]', error)
    return NextResponse.json({ error: error?.message ?? 'Create failed' }, { status: 500 })
  }

  // Make the new listing appear on public ISR pages within seconds.
  if (d.status === 'active') {
    revalidateCatalog({ categorySlug: d.category_slug, providerSlug: provider.slug })
  }

  return NextResponse.json({ id: pkg.id, slug: pkg.slug, status: d.status })
}
