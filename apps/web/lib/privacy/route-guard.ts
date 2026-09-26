import 'server-only'
import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/admin'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import type { Admin } from './common'

/**
 * The guard every /api/v1/admin/whatsapp/* and /api/v1/admin/privacy/* route runs first: an admin / ops session
 * (requireAdmin refuses delegated agent tokens — none of these is an agent tool), and for a mutation also
 * requireNotDelegated and the admin mutation limiter. Reads and writes then run on the service role.
 */

export const NO_STORE = { 'Cache-Control': 'private, no-store' } as const

export type Guarded = { userId: string; admin: Admin; error?: undefined } | { error: NextResponse; userId?: undefined; admin?: undefined }

export async function adminRead(): Promise<Guarded> {
  const auth = await requireAdmin()
  if (auth.error) return { error: auth.error }
  return { userId: auth.userId, admin: await createAdminClient() }
}

export async function adminMutation(route: string): Promise<Guarded> {
  const auth = await requireAdmin()
  if (auth.error) return { error: auth.error }
  const delegated = await requireNotDelegated(route)
  if (delegated) return { error: delegated }
  const rl = await enforce(limiters.adminMutation, `admin:${auth.userId}`)
  if (!rl.ok) return { error: tooManyRequests(rl.retryAfter) }
  return { userId: auth.userId, admin: await createAdminClient() }
}

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

export const notReadyResponse = () => NextResponse.json({ error: 'not_ready' }, { status: 409, headers: NO_STORE })
