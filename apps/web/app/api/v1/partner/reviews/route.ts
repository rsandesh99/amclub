import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'

/** GET — the signed-in provider's reviews (all statuses) for the reply console. */
export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = await createAdminClient()
  const { data: provider } = await admin.from('provider_profiles').select('id, avg_rating, review_count').eq('user_id', userId).maybeSingle()
  if (!provider) return NextResponse.json({ error: 'Provider profile required' }, { status: 403 })

  const { data } = await admin
    .from('reviews')
    .select('id, rating, text, provider_reply, status, created_at, order:orders(order_number, title)')
    .eq('provider_id', provider.id)
    .neq('status', 'removed')
    .order('created_at', { ascending: false })
    .limit(100)

  return NextResponse.json({
    reviews: data ?? [],
    avgRating: provider.avg_rating,
    reviewCount: provider.review_count,
  })
}
