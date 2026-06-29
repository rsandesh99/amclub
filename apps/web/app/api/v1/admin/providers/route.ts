import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'

/** GET — provider list/search/filter (status, state, category slug, q, minRating). */
export async function GET(request: NextRequest) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const sp = new URL(request.url).searchParams
  const status = sp.get('status')
  const state = sp.get('state')
  const q = sp.get('q')?.trim()
  const categorySlug = sp.get('category')
  const minRating = sp.get('minRating')

  const admin = await createAdminClient()

  // Optional category filter → provider ids in that category.
  let providerIdFilter: string[] | null = null
  if (categorySlug) {
    const { data: cat } = await admin.from('categories').select('id').eq('slug', categorySlug).maybeSingle()
    if (cat) {
      const { data: pcs } = await admin.from('provider_categories').select('provider_id').eq('category_id', cat.id)
      providerIdFilter = (pcs ?? []).map((p) => p.provider_id)
      if (providerIdFilter.length === 0) return NextResponse.json({ providers: [] })
    }
  }

  let query = admin
    .from('provider_profiles')
    .select('id, display_name, legal_name, slug, state, city, status, avg_rating, review_count, completed_orders, capacity_paused, created_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(200)
  if (status) query = query.eq('status', status)
  if (state) query = query.eq('state', state)
  if (q) query = query.or(`display_name.ilike.%${q}%,legal_name.ilike.%${q}%,slug.ilike.%${q}%`)
  if (minRating) query = query.gte('avg_rating', minRating)
  if (providerIdFilter) query = query.in('id', providerIdFilter)

  const { data } = await query
  return NextResponse.json({ providers: data ?? [] })
}
