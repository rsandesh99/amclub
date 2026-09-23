import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { bankFacts, payoutReadiness, READINESS_VALUES, type PayoutReadiness } from '@/lib/payments/readiness'

/** GET — provider list/search/filter (status, state, category slug, q, minRating, readiness). */
export async function GET(request: NextRequest) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const sp = new URL(request.url).searchParams
  const status = sp.get('status')
  const state = sp.get('state')
  const q = sp.get('q')?.trim()
  const categorySlug = sp.get('category')
  const minRating = sp.get('minRating')
  const readinessFilter = sp.get('readiness')

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
  if (q) {
    // PostgREST filter syntax: strip the characters that would let the search
    // text add or close filter clauses (`,` `(` `)` `:` `*` `%` `\\`).
    const safe = q.replace(/[,():*%\\]/g, ' ').trim()
    if (safe) query = query.or(`display_name.ilike.%${safe}%,legal_name.ilike.%${safe}%,slug.ilike.%${safe}%`)
  }
  if (minRating) query = query.gte('avg_rating', minRating)
  if (providerIdFilter) query = query.in('id', providerIdFilter)

  const { data } = await query
  const rows = data ?? []

  // Phase 3a — payout readiness per provider (status only; never the account number).
  const ids = rows.map((r) => r.id)
  const { data: banks } = ids.length
    ? await admin.from('provider_bank_accounts').select('provider_id, penny_drop_verified, razorpay_route_account_id').in('provider_id', ids)
    : { data: [] as { provider_id: string; penny_drop_verified: boolean; razorpay_route_account_id: string | null }[] }
  const bankByProvider = new Map((banks ?? []).map((b) => [b.provider_id, b]))

  let providers = rows.map((r) => {
    const facts = bankFacts(bankByProvider.get(r.id))
    return { ...r, readiness: payoutReadiness(facts) as PayoutReadiness, bank: facts }
  })
  if (readinessFilter && (READINESS_VALUES as readonly string[]).includes(readinessFilter)) {
    providers = providers.filter((p) => p.readiness === readinessFilter)
  } else if (readinessFilter === 'unready') {
    providers = providers.filter((p) => p.readiness !== 'ready')
  }

  return NextResponse.json({ providers })
}
