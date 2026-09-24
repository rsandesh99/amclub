import 'server-only'
import type { KycReferences } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * Audit M12 / ADR 028 — what a KYC vendor record is compared with: the
 * claimant's OWN identity as the platform already holds it, never what the
 * request says.
 *
 *   - GST-locked names: the registry legal and trade name from the latest real
 *     (vendor, non-stub) verified `gstin_verifications` row for THIS user and
 *     the profile's GSTIN, plus that GSTIN (and the PAN inside it).
 *   - An admin-approved provider (status active) adds its reviewed legal name
 *     and the GSTIN / PAN values of its approved `provider_verifications` rows.
 *
 * The shared `kycOwnership` makes the decision; this only gathers the facts.
 */

const APPROVED_VERIFICATION = ['manually_approved', 'api_verified']

const clean = (s: unknown): string | null => (typeof s === 'string' && s.trim() !== '' ? s.trim() : null)

async function gstLocked(admin: Admin, userId: string, gstin: string | null): Promise<{ names: string[]; gstins: string[] }> {
  const g = (gstin ?? '').replace(/\s+/g, '').toUpperCase()
  if (!g) return { names: [], gstins: [] }
  const { data } = await admin
    .from('gstin_verifications')
    .select('result, created_at')
    .eq('user_id', userId)
    .eq('gstin', g)
    .eq('verified', true)
    .eq('stub', false)
    .eq('provider', 'surepass')
    .order('created_at', { ascending: false })
    .limit(5)
  for (const row of data ?? []) {
    const r = (row.result ?? {}) as { legalName?: unknown; tradeName?: unknown }
    const names = [clean(r.legalName), clean(r.tradeName)].filter((n): n is string => !!n)
    if (names.length) return { names, gstins: [g] }
  }
  return { names: [], gstins: [] }
}

/** The GSTIN of this user's latest real verified GSTIN lookup (verify-bank before a profile exists). */
async function latestVerifiedGstin(admin: Admin, userId: string): Promise<string | null> {
  const { data } = await admin
    .from('gstin_verifications')
    .select('gstin')
    .eq('user_id', userId)
    .eq('verified', true)
    .eq('stub', false)
    .eq('provider', 'surepass')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return clean((data as { gstin?: unknown } | null)?.gstin)
}

export interface KycReferenceArgs {
  userId: string
  target: 'msme' | 'provider'
  /** The GSTIN to lock names from; defaults to the profile's. */
  gstin?: string | null
  /** No GSTIN known (no profile yet, nothing sent): fall back to the user's latest real verified GSTIN. */
  fallbackToLatestGstin?: boolean
}

export async function kycReferences(admin: Admin, args: KycReferenceArgs): Promise<KycReferences & { gstin: string | null }> {
  const names: string[] = []
  const pans: string[] = []
  const gstins: string[] = []
  let gstin = clean(args.gstin)

  if (args.target === 'msme') {
    if (!gstin) {
      const { data } = await admin.from('msme_profiles').select('gstin').eq('user_id', args.userId).maybeSingle()
      gstin = clean((data as { gstin?: unknown } | null)?.gstin)
    }
  } else {
    const { data } = await admin.from('provider_profiles').select('id, gstin, pan, legal_name, status, deleted_at').eq('user_id', args.userId).maybeSingle()
    const p = data as { id: string; gstin: string | null; pan: string | null; legal_name: string | null; status: string; deleted_at: string | null } | null
    if (!gstin) gstin = clean(p?.gstin)
    if (p && p.status === 'active' && !p.deleted_at) {
      const legal = clean(p.legal_name)
      if (legal) names.push(legal)
      const { data: ver } = await admin.from('provider_verifications').select('kind, value, status').eq('provider_id', p.id).in('kind', ['gstin', 'pan']).in('status', APPROVED_VERIFICATION)
      for (const v of (ver ?? []) as { kind: string; value: string | null }[]) {
        const value = clean(v.value)
        if (!value) continue
        if (v.kind === 'gstin') gstins.push(value)
        else pans.push(value)
      }
    }
  }
  if (!gstin && args.fallbackToLatestGstin) gstin = await latestVerifiedGstin(admin, args.userId)

  const locked = await gstLocked(admin, args.userId, gstin)
  return { names: [...locked.names, ...names], pans, gstins: [...locked.gstins, ...gstins], gstin }
}
