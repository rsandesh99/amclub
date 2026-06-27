import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>
/* eslint-disable @typescript-eslint/no-explicit-any */

const SEVEN_DAYS = 7 * 24 * 3600 * 1000
const ONE_DAY = 24 * 3600 * 1000

/**
 * Basic review-bombing heuristic (A4 — "don't over-build"). A burst of 5-star
 * reviews for one provider from brand-new buyer accounts is suspicious; flag the
 * review (status → 'flagged') so it drops out of the public average + listing and
 * lands in the /admin/reviews queue for a human. Returns true if it flagged.
 */
export async function maybeFlagAnomalousReview(admin: Admin, review: any): Promise<boolean> {
  if (review.rating !== 5) return false

  // Reviewer account age — proxy via the MSME profile's owning user.
  const { data: msme } = await admin
    .from('msme_profiles')
    .select('user_id')
    .eq('id', review.msme_id)
    .maybeSingle()
  if (!msme?.user_id) return false
  const { data: u } = await admin.from('users').select('created_at').eq('id', msme.user_id).maybeSingle()
  const newAccount = u?.created_at ? Date.now() - new Date(u.created_at).getTime() < SEVEN_DAYS : false
  if (!newAccount) return false

  // Burst: ≥3 five-star reviews for this provider in the last 24h (incl. this one).
  const since = new Date(Date.now() - ONE_DAY).toISOString()
  const { count } = await admin
    .from('reviews')
    .select('id', { count: 'exact', head: true })
    .eq('provider_id', review.provider_id)
    .eq('rating', 5)
    .gte('created_at', since)
  if ((count ?? 0) < 3) return false

  await admin.from('reviews').update({ status: 'flagged', updated_at: new Date().toISOString() }).eq('id', review.id)
  await admin.from('audit_logs').insert({
    actor_id: null,
    action: 'review_auto_flagged',
    entity: 'reviews',
    entity_id: review.id,
    after: { reason: 'burst_5star_new_accounts', provider_id: review.provider_id },
  })
  return true
}
/* eslint-enable @typescript-eslint/no-explicit-any */
