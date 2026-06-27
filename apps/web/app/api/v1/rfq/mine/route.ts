import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { listMyRfqs } from '@/lib/rfq/queries'

/** Buyer's RFQs (mobile parity for /app/rfq). Cookie or Bearer. */
export async function GET() {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json({ rfqs: await listMyRfqs(userId) })
}
