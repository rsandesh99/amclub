import 'server-only'
import { deriveAvailability, isActiveThisWeek, ORDER_IN_FLIGHT_STATUSES, type Availability, type PublicStatsView } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { publicStatsFor } from './public-stats'

export interface VerificationItem {
  kind: string
  /** 'api' = checked with the registry / vendor; 'manual' = checked by AMClub staff. */
  method: 'api' | 'manual'
  verifiedAt: string | null
}

export interface ProviderTrust {
  stats: PublicStatsView | null
  verification: VerificationItem[]
  activeThisWeek: boolean
  availability: Availability
  since: string | null
  yearsExperience: string | null
  /** The approved logo only (a pending upload never shows). */
  logoUrl: string | null
}

const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

/**
 * E3 — everything the trust panel shows for one provider, server-side with the
 * service role and projected to buyer-safe facts: verification kind + method +
 * date (never the value), a boolean for activity (never the timestamp), the
 * derived availability, gated stats. Reads of 0049 columns are separate and
 * error-tolerant, so a database without that migration degrades to "unknown".
 */
export async function getProviderTrust(providerId: string): Promise<ProviderTrust> {
  const empty: ProviderTrust = { stats: null, verification: [], activeThisWeek: false, availability: null, since: null, yearsExperience: null, logoUrl: null }
  if (!process.env['SUPABASE_SERVICE_ROLE_KEY']) return empty
  try {
    const admin = await createAdminClient()
    const [{ data: p }, { data: v }, statsMap, { data: active }] = await Promise.all([
      admin.from('provider_profiles').select('user_id, created_at, years_experience, capacity_paused, logo_url, udyam_verified').eq('id', providerId).maybeSingle(),
      admin.from('provider_verifications').select('kind, status, verified_at, updated_at').eq('provider_id', providerId).in('status', ['manually_approved', 'api_verified']),
      publicStatsFor(admin, [providerId]),
      admin.from('orders').select('due_at').eq('provider_id', providerId).in('status', [...ORDER_IN_FLIGHT_STATUSES]),
    ])
    if (!p) return empty
    const [{ data: extra }, { data: user }] = await Promise.all([
      admin.from('provider_profiles').select('next_available_on, capacity_slots').eq('id', providerId).maybeSingle(),
      admin.from('users').select('last_seen_at').eq('id', p.user_id as string).maybeSingle(),
    ])
    const seen = new Set<string>()
    const verification: VerificationItem[] = []
    for (const r of v ?? []) {
      if (seen.has(r.kind as string)) continue
      seen.add(r.kind as string)
      verification.push({ kind: r.kind as string, method: r.status === 'api_verified' ? 'api' : 'manual', verifiedAt: (r.verified_at as string | null) ?? (r.updated_at as string | null) ?? null })
    }
    if (p.udyam_verified && !seen.has('udyam')) verification.push({ kind: 'udyam', method: 'api', verifiedAt: null })
    const dues = (active ?? []).map((o) => o.due_at as string | null).filter((d): d is string => !!d).sort()
    const x = (extra ?? null) as { next_available_on?: string | null; capacity_slots?: number | null } | null
    return {
      stats: statsMap.get(providerId) ?? null,
      verification,
      activeThisWeek: isActiveThisWeek((user?.last_seen_at as string | null) ?? null),
      availability: deriveAvailability({
        capacityPaused: !!p.capacity_paused,
        nextAvailableOn: x?.next_available_on ?? null,
        capacitySlots: Number(x?.capacity_slots ?? 5),
        activeOrders: (active ?? []).length,
        earliestDueAt: dues[0] ?? null,
        today: istToday(),
      }),
      since: (p.created_at as string | null) ?? null,
      yearsExperience: (p.years_experience as string | null) ?? null,
      logoUrl: (p.logo_url as string | null) ?? null,
    }
  } catch (e) {
    console.error('[getProviderTrust]', e)
    return empty
  }
}
