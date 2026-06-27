import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { listMatchedRfqsForProvider } from '@/lib/rfq/queries'

/** RFQs matched to the provider (mobile parity for /partner/rfqs). Cookie or Bearer. */
export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ rfqs: await listMatchedRfqsForProvider(userId) })
}
