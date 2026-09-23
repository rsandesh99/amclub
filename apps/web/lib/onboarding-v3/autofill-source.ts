import 'server-only'
import { normalizeVendorState, stateFromGstin } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

export type FieldSource = 'gst' | 'typed'
export interface AutofillSource {
  legalName: FieldSource
  displayName: FieldSource
  state: FieldSource
  /** The GSTIN's own state code disagrees with the saved state or the registry's — flag, never a block. */
  stateFlag: { gstinState: string | null; savedState: string; registryState: string | null } | null
  registryLegalName: string | null
}

/**
 * E10 (FR-10.3) — for the admin verification queue: which fields match the
 * GST registry record the applicant verified (the latest successful
 * gstin_verifications row for that user + GSTIN) and whether the state checks
 * out against the GSTIN's first two digits.
 */
export async function autofillSources(
  admin: Admin,
  providers: { id: string; user_id: string; gstin: string | null; legal_name: string; display_name: string; state: string }[],
): Promise<Map<string, AutofillSource>> {
  const out = new Map<string, AutofillSource>()
  const withGstin = providers.filter((p) => p.gstin)
  if (withGstin.length === 0) return out
  const { data } = await admin
    .from('gstin_verifications')
    .select('user_id, gstin, result, created_at')
    .in('user_id', withGstin.map((p) => p.user_id))
    .eq('verified', true)
    .order('created_at', { ascending: false })
  const latest = new Map<string, { legalName?: string | null; tradeName?: string | null; state?: string | null }>()
  for (const r of data ?? []) {
    const k = `${r.user_id}|${r.gstin}`
    if (!latest.has(k)) latest.set(k, (r.result ?? {}) as { legalName?: string | null; tradeName?: string | null; state?: string | null })
  }
  for (const p of withGstin) {
    const rec = latest.get(`${p.user_id}|${p.gstin}`) ?? null
    const gstinState = stateFromGstin(p.gstin)
    const registryState = normalizeVendorState(rec?.state ?? null)
    const expectedState = registryState ?? gstinState
    const flagged = (!!gstinState && gstinState !== p.state) || (!!gstinState && !!registryState && gstinState !== registryState)
    out.set(p.id, {
      legalName: rec?.legalName && rec.legalName.trim() === p.legal_name.trim() ? 'gst' : 'typed',
      displayName: rec?.tradeName && rec.tradeName.trim() === p.display_name.trim() ? 'gst' : 'typed',
      state: expectedState && expectedState === p.state ? 'gst' : 'typed',
      stateFlag: flagged ? { gstinState, savedState: p.state, registryState } : null,
      registryLegalName: rec?.legalName ?? null,
    })
  }
  return out
}
