import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { preferencesPatchSchema } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { serverError } from '@/lib/api/errors'

/**
 * PATCH /api/v1/profile/preferences — the caller's own display preferences:
 * density (N33) and language (audit §5 item 10: the header switch and the
 * mobile toggle persist the choice so email, SMS and WhatsApp follow it).
 * Service-role write of whitelisted columns on the caller's own users row
 * (0042 keeps client writes on users revoked). Only the fields sent change.
 */
export const runtime = 'nodejs'

export async function PATCH(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('profile/preferences')
  if (delegated) return delegated
  const parsed = preferencesPatchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (parsed.data.uiDensity !== undefined) patch['ui_density'] = parsed.data.uiDensity
  if (parsed.data.preferredLocale !== undefined) patch['preferred_locale'] = parsed.data.preferredLocale
  const admin = await createAdminClient()
  const { error } = await admin.from('users').update(patch).eq('id', userId)
  if (error) return serverError('[profile/preferences PATCH]', error)
  return NextResponse.json({
    ...(parsed.data.uiDensity !== undefined ? { uiDensity: parsed.data.uiDensity } : {}),
    ...(parsed.data.preferredLocale !== undefined ? { preferredLocale: parsed.data.preferredLocale } : {}),
  })
}
