import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'
import { getAgentSetting } from '@/lib/agent/settings'
import { getKycClient } from '@/lib/kyc'
import { writeAudit } from '@/lib/audit/log'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

const BATCH = 200

/**
 * F4 — nightly GSTIN re-check (setting `gstin_recheck_enabled`, default off:
 * each check is a paid vendor call). A GSTIN the vendor reports inactive
 * (cancelled / suspended) is FLAGGED to ops as an audit row
 * (`gstin_inactive_flagged`), shown on /admin/verifications. It never
 * suspends a provider by itself. Stub mode (no vendor key) does nothing.
 */
export async function recheckGstins(admin: Admin): Promise<{ enabled: boolean; checked: number; flagged: number; errors: number }> {
  if ((await getAgentSetting(admin, 'gstin_recheck_enabled')) !== true) return { enabled: false, checked: 0, flagged: 0, errors: 0 }
  const kyc = getKycClient()
  const { data: rows } = await admin
    .from('provider_profiles')
    .select('id, gstin')
    .eq('status', 'active')
    .is('deleted_at', null)
    .not('gstin', 'is', null)
    .limit(BATCH)
  let checked = 0, flagged = 0, errors = 0
  for (const p of rows ?? []) {
    try {
      const r = await kyc.verifyGstin(p.gstin as string)
      if (r.stub) continue
      checked++
      if (r.verified && r.isActive === false) {
        flagged++
        await writeAudit(admin, null, { actorId: null, action: 'gstin_inactive_flagged', entity: 'provider_profiles', entityId: p.id as string, after: { checked_at: new Date().toISOString() } })
      }
      if (!r.verified && r.error) errors++
    } catch {
      errors++
    }
  }
  return { enabled: true, checked, flagged, errors }
}
