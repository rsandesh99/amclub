import 'server-only'
import { createClient } from '@/lib/supabase/server'

export interface SavedProviderRow {
  id: string
  displayName: string
  slug: string
  avgRating: number
  reviewCount: number
}

/** E9 FR-9.4 — the buyer's saved providers, newest first (user-scoped client: RLS decides ownership). */
export async function listSavedProviders(userId: string, limit: number): Promise<SavedProviderRow[]> {
  const supabase = await createClient()
  const { data: msme } = await supabase.from('msme_profiles').select('id').eq('user_id', userId).maybeSingle()
  if (!msme) return []
  const { data } = await supabase
    .from('saved_providers')
    .select('provider:provider_profiles(id, display_name, slug, avg_rating, review_count)')
    .eq('msme_id', msme.id)
    .order('created_at', { ascending: false })
    .limit(limit)
  type P = { id: string; display_name: string; slug: string; avg_rating: number | null; review_count: number | null }
  return ((data ?? []) as unknown as { provider: P | P[] | null }[])
    .map((r) => (Array.isArray(r.provider) ? r.provider[0] : r.provider))
    .filter((p): p is P => !!p)
    .map((p) => ({ id: p.id, displayName: p.display_name, slug: p.slug, avgRating: Number(p.avg_rating ?? 0), reviewCount: Number(p.review_count ?? 0) }))
}
