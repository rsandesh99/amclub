import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { preferencesPatchSchema } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { serverError } from '@/lib/api/errors'

/**
 * PATCH /api/v1/profile/preferences (N33) — the caller's own display density.
 * Service-role write of ONE whitelisted column on the caller's own users row
 * (0042 keeps client writes on users revoked).
 */
export const runtime = 'nodejs'

export async function PATCH(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('profile/preferences')
  if (delegated) return delegated
  const parsed = preferencesPatchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const admin = await createAdminClient()
  const { error } = await admin.from('users').update({ ui_density: parsed.data.uiDensity, updated_at: new Date().toISOString() }).eq('id', userId)
  if (error) return serverError('[profile/preferences PATCH]', error)
  return NextResponse.json({ uiDensity: parsed.data.uiDensity })
}
