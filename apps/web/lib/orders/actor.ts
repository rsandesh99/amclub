import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'
import type { Actor } from './transitions'

/**
 * An order-party identity plus the reason a buyer identity is missing.
 * `msmeSuspended` is true when the user HAS a buyer profile that an admin
 * suspended (msme_profiles.deleted_at set) — callers that want to say so can
 * answer 403 `account_suspended` (see lib/auth/suspension.ts).
 */
export type ResolvedActor = Actor & { msmeSuspended: boolean; providerSuspended: boolean }

/**
 * Resolve the acting user's order-party identities (msme/provider profile ids).
 *
 * P0-8: a SUSPENDED buyer profile (admin "suspend" sets msme_profiles.deleted_at)
 * resolves as NO buyer identity — msmeId is null — so every route that gates
 * on actor.msmeId (order transitions, RFQ create / compare / decline / quality,
 * attachments, nudges, disputes, messages) refuses the buyer exactly as it
 * refuses a user without a profile. The provider identity is independent:
 * suspending a user's buyer side does not touch their provider side. Admin
 * views never go through this (they read with the service role directly).
 *
 * Audit M13: the same holds for a SUSPENDED provider (status 'suspended', or
 * soft-deleted): providerId is null, so they cannot quote, accept, deliver,
 * message, or read matched requests and orders until an admin reactivates them.
 * Payouts are held separately (schedulePayout's provider_suspended reason).
 */
export async function resolveActor(
  admin: Awaited<ReturnType<typeof createAdminClient>>,
  userId: string,
): Promise<ResolvedActor> {
  const [{ data: user }, { data: msme }, { data: provider }] = await Promise.all([
    admin.from('users').select('roles').eq('id', userId).maybeSingle(),
    admin.from('msme_profiles').select('id, deleted_at').eq('user_id', userId).maybeSingle(),
    admin.from('provider_profiles').select('id, status, deleted_at').eq('user_id', userId).maybeSingle(),
  ])
  const msmeSuspended = Boolean(msme?.deleted_at)
  const providerSuspended = Boolean(provider && (provider.status === 'suspended' || provider.deleted_at))
  return {
    userId,
    msmeId: msme && !msmeSuspended ? msme.id : null,
    providerId: provider && !providerSuspended ? provider.id : null,
    roles: user?.roles ?? [],
    msmeSuspended,
    providerSuspended,
  }
}
