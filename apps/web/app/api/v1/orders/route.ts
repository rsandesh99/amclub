import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireToolScope } from '@/lib/agent/scope'
import { listMyOrders } from '@/lib/orders/queries'

/** List the authed user's orders. `?role=msme|provider` (default msme).
 *  Cookie (web) OR Bearer (mobile). Used by the mobile orders screen. */
export async function GET(request: NextRequest) {
  const { userId } = await getAuthedSupabase()
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // S2.3 — the Support agent's read (support_lookup) and the provider deadline read (list_deadlines); no-op for sessions.
  const scope = await requireToolScope(['support_lookup', 'list_deadlines'])
  if (scope) return scope
  const roleParam = request.nextUrl.searchParams.get('role')
  const role: 'msme' | 'provider' = roleParam === 'provider' ? 'provider' : 'msme'
  const orders = await listMyOrders(userId, role)
  return NextResponse.json({ orders })
}
