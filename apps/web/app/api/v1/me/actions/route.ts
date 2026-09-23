import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { getMyActions } from '@/lib/me/actions'

/**
 * GET /api/v1/me/actions (N2, PRD Experience v3 FR-1.4) — the viewer's own
 * "needs your action" items and nav badge counts, per role. Web shell + mobile
 * tab bar + home lists. No parameters: everything is keyed to the session.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('me/actions')
  if (delegated) return delegated
  return NextResponse.json(await getMyActions(userId), { headers: { 'Cache-Control': 'private, no-store' } })
}
