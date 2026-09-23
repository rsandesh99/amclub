import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { getMyObligations, isObligationsOn } from '@/lib/licences'

/**
 * Experience v3 E9b (FR-9.5 "What do I need?") — a routing checklist, not
 * advice: the caller's business facts (to confirm) and the CA-reviewed
 * obligation_rules that match them, each with its source and review stamp,
 * the category that provides it, and whether the buyer already holds it.
 * No model. 404 while `obligations_enabled` is off.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isObligationsOn())) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const delegated = await requireNotDelegated('me/obligations')
  if (delegated) return delegated
  const view = await getMyObligations(supabase, userId)
  if (!view) return NextResponse.json({ error: 'profile_incomplete', code: 'profile_incomplete' }, { status: 403 })
  return NextResponse.json(view, { headers: { 'Cache-Control': 'private, no-store' } })
}
