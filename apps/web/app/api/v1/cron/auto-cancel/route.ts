import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { autoCancelOrder, redriveCancellationRefunds, staleOrdersForAutoCancel } from '@/lib/orders/transitions'
import { getPaymentGateway } from '@/lib/payments'
import { sweepCaptureExceptions } from '@/lib/payments/capture-exceptions'

export const dynamic = 'force-dynamic'

/** Orders in 'placed' for >24h → auto_cancelled → refunded (100%); then any
 *  cancellation refund that failed earlier is re-driven (ADR 026), and any
 *  capture that created no order (expired session / second capture) is
 *  refunded in full (ADR 027). A refund still
 *  failing marks the run degraded (M35). */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  return runCronJob(admin, 'auto-cancel', async () => {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const stale = await staleOrdersForAutoCancel(admin, cutoff)

    let cancelled = 0
    for (const order of stale ?? []) {
      if (await autoCancelOrder(admin, order)) cancelled++
    }
    const refunds = await redriveCancellationRefunds(admin)
    const captures = await sweepCaptureExceptions(admin, getPaymentGateway())
    return {
      checked: stale.length,
      cancelled,
      refundsRedriven: refunds.refunded,
      refundsStillFailing: refunds.failed,
      captureRefunds: captures.refunded,
      captureRefundsFailing: captures.failed,
      ...(refunds.unavailable || captures.unavailable ? { paymentsUnavailable: true } : {}),
    }
  })
}
