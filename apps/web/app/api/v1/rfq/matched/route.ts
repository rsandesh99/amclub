import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireToolScope } from '@/lib/agent/scope'
import { listMatchedRfqsForProvider } from '@/lib/rfq/queries'

/** RFQs matched to the provider (mobile parity for /partner/rfqs). Cookie or Bearer. */
export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // S2.2 — the Munshi read (extract_requirements); a no-op for sessions and full-persona tokens.
  const scope = await requireToolScope(['extract_requirements', 'support_lookup'])
  if (scope) return scope
  return NextResponse.json({ rfqs: await listMatchedRfqsForProvider(userId) })
}
