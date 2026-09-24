import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { timeBudget } from '@/lib/jobs/budget'
import { autoCancelOrder, redriveCancellationRefunds, staleOrdersForAutoCancel } from '@/lib/orders/transitions'
import { getPaymentGateway } from '@/lib/payments'
import { sweepCaptureExceptions } from '@/lib/payments/capture-exceptions'

export const dynamic = 'force-dynamic'
// Audit M38 — a money cron (refunds): an explicit ceiling and a time budget inside it.
export const maxDuration = 300

/** Orders in 'placed' for >24h → auto_cancelled → refunded (100%); then any
 *  cancellation refund that failed earlier is re-driven (ADR 026), and any
 *  capture that created no order (expired session / second capture) is
 *  refunded in full (ADR 027). All in bounded batches inside the time budget;
 *  the next hourly run takes the rest. A refund still failing marks the run
 *  degraded (M35). */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const budget = timeBudget(maxDuration)
  const admin = await createAdminClient()
  return runCronJob(admin, 'auto-cancel', async () => {
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const stale = await staleOrdersForAutoCancel(admin, cutoff)

    let cancelled = 0
    let deferred = 0
    for (let i = 0; i < stale.length; i++) {
      if (budget.spent()) { deferred = stale.length - i; break }
      if (await autoCancelOrder(admin, stale[i])) cancelled++
    }
    const refunds = await redriveCancellationRefunds(admin, budget)
    const captures = await sweepCaptureExceptions(admin, getPaymentGateway())
    return {
      checked: stale.length,
      cancelled,
      deferred,
      refundsRedriven: refunds.refunded,
      refundsStillFailing: refunds.failed,
      captureRefunds: captures.refunded,
      captureRefundsFailing: captures.failed,
      ...(refunds.unavailable || captures.unavailable ? { paymentsUnavailable: true } : {}),
    }
  })
}
