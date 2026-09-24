import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

// The service-role client (createAdminClient); the pools code types it as SupabaseClient.
type Admin = SupabaseClient

/**
 * Audit M22 (ADR 027) — no self-dealing. One person may hold a buyer profile and
 * a provider profile (both keyed by user_id), but may never be both sides of one
 * deal: buy from, quote to, act on both sides of, or review their own provider
 * profile. Refusals answer 409 with this code.
 */
export const SELF_DEALING = 'self_dealing' as const

/** The user who owns this provider profile (null when there is none). */
async function providerOwner(admin: Admin, providerId: string): Promise<string | null> {
  const { data } = await admin.from('provider_profiles').select('user_id').eq('id', providerId).maybeSingle()
  return (data?.user_id as string | undefined) ?? null
}

/** The user who owns this buyer (MSME) profile (null when there is none). */
async function msmeOwner(admin: Admin, msmeId: string): Promise<string | null> {
  const { data } = await admin.from('msme_profiles').select('user_id').eq('id', msmeId).maybeSingle()
  return (data?.user_id as string | undefined) ?? null
}

/** True when `userId` owns the provider profile (a checkout, a pool join). */
export async function isOwnProvider(admin: Admin, providerId: string, userId: string): Promise<boolean> {
  return (await providerOwner(admin, providerId)) === userId
}

/** True when the provider profile's owner is the buyer who posted the request (a quote, a group offer). */
export async function providerOwnsRequest(admin: Admin, providerId: string, rfqId: string): Promise<boolean> {
  const { data: rfq } = await admin.from('rfqs').select('msme_id').eq('id', rfqId).maybeSingle()
  if (!rfq?.msme_id) return false
  const [buyer, seller] = await Promise.all([msmeOwner(admin, rfq.msme_id as string), providerOwner(admin, providerId)])
  return buyer !== null && buyer === seller
}

/** True when one user owns both sides of the order (checked for the acting user). */
export async function isSelfDealtOrder(admin: Admin, order: { msme_id: string; provider_id: string }, userId: string): Promise<boolean> {
  const [buyer, seller] = await Promise.all([msmeOwner(admin, order.msme_id), providerOwner(admin, order.provider_id)])
  return buyer === userId && seller === userId
}
