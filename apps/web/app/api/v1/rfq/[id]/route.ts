import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { getRfqForBuyer, getRfqForProvider } from '@/lib/rfq/queries'

/** RFQ detail (mobile). Returns the buyer view if the caller owns the RFQ,
 *  else the provider view if they're matched. Cookie or Bearer. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const buyer = await getRfqForBuyer(userId, id)
  if (buyer) return NextResponse.json({ role: 'buyer', rfq: buyer })

  const provider = await getRfqForProvider(userId, id)
  if (provider) return NextResponse.json({ role: 'provider', rfq: provider })

  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}
