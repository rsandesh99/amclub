import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { getPaymentGateway } from '@/lib/payments'
import { runPayouts } from '@/lib/payments/payout'

export const dynamic = 'force-dynamic'

/** Daily payout batch (T+2 due). `?all=true` processes all scheduled (test).
 *  A failed, held or unconfirmed payout marks the run degraded (M35). */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  const allScheduled = request.nextUrl.searchParams.get('all') === 'true'
  return runCronJob(admin, 'payouts', () => runPayouts(admin, getPaymentGateway(), { allScheduled }))
}
