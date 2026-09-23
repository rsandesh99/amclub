import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { isOnFor } from '@/lib/experiments'
import { listBuyAgainShelf } from '@/lib/home/buy-again'

/**
 * GET /api/v1/me/buy-again (PRD Experience v3 E9, FR-9.3) — the home's "Buy
 * again" shelf for web and mobile: up to 4 of the caller's finished package
 * orders, newest first, each resolved exactly like /orders/[id]/buy-again.
 * Read-only. 404 unless the `home` experience is on for the caller.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isOnFor('home', userId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const delegated = await requireNotDelegated('me/buy-again')
  if (delegated) return delegated
  return NextResponse.json({ items: await listBuyAgainShelf(userId) }, { headers: { 'Cache-Control': 'private, no-store' } })
}
