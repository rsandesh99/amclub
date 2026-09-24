import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { timeBudget } from '@/lib/jobs/budget'
import { getPaymentGateway } from '@/lib/payments'
import { runPayouts } from '@/lib/payments/payout'

export const dynamic = 'force-dynamic'
// Audit M38 — the cron that moves money: an explicit ceiling and a time budget inside it.
export const maxDuration = 300

/**
 * Daily payout batch (T+2 due). `?all=true` processes all scheduled (test).
 *
 * Audit M38: the due payouts are taken oldest first, 200 at a time, and each goes
 * through the ONE payout path (runPayouts for its order: the claim, the release
 * rule, the confirmed transfer) until the time budget is spent. A payout never
 * reached stays `scheduled` for the next run; one claimed when the function was
 * cut off stays `processing` and the reconcile cron settles it (ADR 026).
 * A failed, held or unconfirmed payout marks the run degraded (M35).
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const budget = timeBudget(maxDuration)
  const admin = await createAdminClient()
  const gateway = getPaymentGateway()
  const allScheduled = request.nextUrl.searchParams.get('all') === 'true'
  return runCronJob(admin, 'payouts', async () => {
    let due = admin.from('payouts').select('order_id').eq('status', 'scheduled')
    if (!allScheduled) due = due.lte('scheduled_for', new Date().toISOString().slice(0, 10))
    const { data: rows, error } = await due.order('scheduled_for', { ascending: true }).limit(200)
    if (error) throw new Error(`due payouts lookup: ${error.message}`)
    const orderIds = [...new Set((rows ?? []).map((r) => r.order_id as string))]

    const result = { processed: 0, transferIds: [] as string[], simulated: false, held: 0, unconfirmed: 0, failed: 0, due: orderIds.length, deferred: 0, unavailable: false }
    for (let i = 0; i < orderIds.length; i++) {
      if (budget.spent()) { result.deferred = orderIds.length - i; break }
      try {
        const r = await runPayouts(admin, gateway, { orderId: orderIds[i]! })
        result.processed += r.processed
        result.transferIds.push(...r.transferIds)
        result.held += r.held
        result.unconfirmed += r.unconfirmed
        result.failed += r.failed
        result.simulated = result.simulated || r.simulated
        if (r.unavailable) { result.unavailable = true; break }
      } catch (e) {
        // One payout's failure never stops the batch; runPayouts records its own state.
        result.failed += 1
        console.error('[cron/payouts]', orderIds[i], e instanceof Error ? e.message : e)
      }
    }
    return result
  })
}
