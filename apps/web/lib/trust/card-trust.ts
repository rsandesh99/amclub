import 'server-only'
import { headlineStat, isActiveThisWeek, type StatValue } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { publicStatsFor } from './public-stats'

export interface CardTrust {
  /** FR-3.1: the ONE measured stat (on-time, else repeat buyers), gated. */
  stat: { kind: 'on_time' | 'repeat_buyers'; value: StatValue } | null
  activeThisWeek: boolean
}

/** Trust facts for a page of result cards — two batched reads, buyer-safe projections only. */
export async function cardTrustFor(providerIds: string[]): Promise<Map<string, CardTrust>> {
  const out = new Map<string, CardTrust>()
  const ids = [...new Set(providerIds)]
  if (ids.length === 0 || !process.env['SUPABASE_SERVICE_ROLE_KEY']) return out
  try {
    const admin = await createAdminClient()
    const [stats, { data: provs }] = await Promise.all([
      publicStatsFor(admin, ids),
      admin.from('provider_profiles').select('id, user_id').in('id', ids),
    ])
    const userIds = (provs ?? []).map((p) => p.user_id as string)
    const { data: users } = userIds.length ? await admin.from('users').select('id, last_seen_at').in('id', userIds) : { data: [] }
    const seen = new Map((users ?? []).map((u) => [u.id as string, (u.last_seen_at as string | null) ?? null]))
    for (const p of provs ?? []) {
      out.set(p.id as string, {
        stat: headlineStat(stats.get(p.id as string) ?? null),
        activeThisWeek: isActiveThisWeek(seen.get(p.user_id as string) ?? null),
      })
    }
  } catch (e) {
    console.error('[cardTrustFor]', e)
  }
  return out
}
