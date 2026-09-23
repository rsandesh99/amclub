import 'server-only'
import { NextResponse } from 'next/server'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * MSME (buyer) suspension — USER_EXPECTATIONS_AUDIT P0-8.
 *
 * Admin "suspend" (api/v1/admin/msmes/[id]) sets msme_profiles.deleted_at.
 * resolveActor (lib/orders/actor.ts) and getMsmeProfile (lib/auth/session.ts)
 * already treat a suspended profile as NO buyer identity, so write/act paths
 * built on them fail closed. These helpers are for the places that look the
 * profile up themselves, or that want to tell the user WHY (403
 * `account_suspended` instead of "complete your profile").
 */
export const ACCOUNT_SUSPENDED = 'account_suspended' as const

/** True when the user has a buyer profile and it is suspended. Service-role read. */
export async function getMsmeSuspension(admin: Admin, userId: string): Promise<boolean> {
  const { data } = await admin.from('msme_profiles').select('deleted_at').eq('user_id', userId).maybeSingle()
  return Boolean(data?.deleted_at)
}

/** The one 403 body for a suspended buyer. */
export function accountSuspendedResponse(): NextResponse {
  return NextResponse.json({ error: ACCOUNT_SUSPENDED }, { status: 403 })
}
