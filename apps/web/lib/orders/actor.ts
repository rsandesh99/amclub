import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'
import type { Actor } from './transitions'

/** Resolve the acting user's order-party identities (msme/provider profile ids). */
export async function resolveActor(
  admin: Awaited<ReturnType<typeof createAdminClient>>,
  userId: string,
): Promise<Actor> {
  const [{ data: user }, { data: msme }, { data: provider }] = await Promise.all([
    admin.from('users').select('roles').eq('id', userId).maybeSingle(),
    admin.from('msme_profiles').select('id').eq('user_id', userId).maybeSingle(),
    admin.from('provider_profiles').select('id').eq('user_id', userId).maybeSingle(),
  ])
  return {
    userId,
    msmeId: msme?.id ?? null,
    providerId: provider?.id ?? null,
    roles: user?.roles ?? [],
  }
}
