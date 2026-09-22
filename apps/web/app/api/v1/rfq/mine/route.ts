import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireToolScope } from '@/lib/agent/scope'
import { listMyRfqs } from '@/lib/rfq/queries'

/** Buyer's RFQs (mobile parity for /app/rfq). Cookie or Bearer. */
export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // S2.3 — the Support agent's read; no-op for sessions.
  const scope = await requireToolScope('support_lookup')
  if (scope) return scope
  return NextResponse.json({ rfqs: await listMyRfqs(userId) })
}
