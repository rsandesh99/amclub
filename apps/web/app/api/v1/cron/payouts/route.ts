import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { getPaymentGateway } from '@/lib/payments'
import { runPayouts } from '@/lib/payments/payout'

export const dynamic = 'force-dynamic'

/** Daily payout batch (T+2 due). `?all=true` processes all scheduled (test). */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  const allScheduled = request.nextUrl.searchParams.get('all') === 'true'
  const result = await runPayouts(admin, getPaymentGateway(), { allScheduled })
  return NextResponse.json(result)
}
