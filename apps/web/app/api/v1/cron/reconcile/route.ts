import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { timeBudget } from '@/lib/jobs/budget'
import { getPaymentGateway } from '@/lib/payments'
import { reconcileCapturedPayments } from '@/lib/payments/materialize'
import { settleUnconfirmedPayouts } from '@/lib/payments/payout'
import { generateMissingInvoices, sweepMissingPayouts } from '@/lib/orders/transitions'

export const dynamic = 'force-dynamic'
// Audit M38 — a money cron: an explicit ceiling and a time budget inside it.
export const maxDuration = 300

/** Reconciliation (every 6 h): recover orders for captured payments whose
 *  webhook was dropped (idempotent; the dropped-webhook kill-test proves it),
 *  settle payouts whose transfer outcome was unknown (ADR 026), write the payout
 *  a completed order's side effects missed (audit M38), and generate invoices an
 *  order action could not. Money truth first; the sweepers stop at the budget.
 *  A payout that settles as failed, or is still unknown, marks the run degraded (M35). */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const budget = timeBudget(maxDuration)
  const admin = await createAdminClient()
  return runCronJob(admin, 'reconcile', async () => {
    const since = Math.floor(Date.now() / 1000) - 2 * 24 * 3600 // last 48h
    const captured = await reconcileCapturedPayments(getPaymentGateway(), since, admin)
    const payouts = await settleUnconfirmedPayouts(admin, getPaymentGateway())
    const missingPayouts = await sweepMissingPayouts(admin, budget)
    const invoices = await generateMissingInvoices(admin, budget)
    return { ...captured, unconfirmedPayouts: payouts, missingPayouts, missingInvoices: invoices }
  })
}
