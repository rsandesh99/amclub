import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireToolScope } from '@/lib/agent/scope'
import { getRfqForBuyer, getRfqForProvider } from '@/lib/rfq/queries'

/** RFQ detail (mobile). Returns the buyer view if the caller owns the RFQ,
 *  else the provider view if they're matched. Cookie or Bearer. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // S2.2 — the Munshi detail read (extract_requirements with rfq_id); a no-op for sessions and full-persona tokens.
  const scope = await requireToolScope(['extract_requirements', 'support_lookup'])
  if (scope) return scope
  const { id } = await params

  const buyer = await getRfqForBuyer(userId, id)
  if (buyer) return NextResponse.json({ role: 'buyer', rfq: buyer })

  const provider = await getRfqForProvider(userId, id)
  if (provider) return NextResponse.json({ role: 'provider', rfq: provider })

  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}
