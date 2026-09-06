import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

export type GoodsActivationState =
  | 'active'          // sells_goods = true
  | 'ready'           // eligible: active provider + verified GSTIN, not yet activated
  | 'gstin_unverified' // GSTIN on file but no non-stub verified record for it
  | 'no_gstin'        // no GSTIN on the profile
  | 'provider_inactive' // provider not yet approved (or suspended)

export interface GoodsActivation {
  state: GoodsActivationState
  sellsGoods: boolean
  providerStatus: string
  gstin: string | null
}

/**
 * The goods activation gate (MART_DESIGN.md §2, §4.1): a provider may sell
 * goods ONLY with a VERIFIED GSTIN — a server-set fact from gstin_verifications
 * (a real KYC result or an audited founder attestation; stub rows never
 * count), matching the GSTIN on the profile. readiness.ts (payout readiness)
 * is a separate, untouched definition — this gate is about tax identity.
 */
export async function getGoodsActivation(admin: Admin, providerId: string): Promise<GoodsActivation | null> {
  const { data: p } = await admin
    .from('provider_profiles')
    .select('id, user_id, status, gstin, sells_goods')
    .eq('id', providerId)
    .maybeSingle()
  if (!p) return null
  const base = { sellsGoods: !!p.sells_goods, providerStatus: p.status as string, gstin: (p.gstin as string | null) ?? null }
  if (p.sells_goods) return { state: 'active', ...base }
  if (p.status !== 'active') return { state: 'provider_inactive', ...base }
  if (!p.gstin) return { state: 'no_gstin', ...base }
  const verified = await hasVerifiedGstin(admin, p.user_id as string, p.gstin as string)
  return { state: verified ? 'ready' : 'gstin_unverified', ...base }
}

/** True when a non-stub, verified gstin_verifications row exists for this user + GSTIN. */
export async function hasVerifiedGstin(admin: Admin, userId: string, gstin: string): Promise<boolean> {
  const { data } = await admin
    .from('gstin_verifications')
    .select('id')
    .eq('user_id', userId)
    .eq('gstin', gstin)
    .eq('verified', true)
    .eq('stub', false)
    .limit(1)
  return (data?.length ?? 0) > 0
}

/** Flip sells_goods=true when the gate passes. Returns the resulting activation. */
export async function activateGoodsSelling(
  admin: Admin,
  providerId: string,
): Promise<{ ok: true; activation: GoodsActivation } | { ok: false; status: number; activation: GoodsActivation | null }> {
  const activation = await getGoodsActivation(admin, providerId)
  if (!activation) return { ok: false, status: 404, activation: null }
  if (activation.state === 'active') return { ok: true, activation }
  if (activation.state !== 'ready') return { ok: false, status: 409, activation }
  const { error } = await admin
    .from('provider_profiles')
    .update({ sells_goods: true, updated_at: new Date().toISOString() })
    .eq('id', providerId)
    .eq('sells_goods', false)
  if (error) return { ok: false, status: 500, activation }
  return { ok: true, activation: { ...activation, state: 'active', sellsGoods: true } }
}
