import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { autoCancelOrder, staleOrdersForAutoCancel, autoAcceptOrder, redriveCancellationRefunds, generateMissingInvoices, sweepMissingPayouts } from '@/lib/orders/transitions'
import { timeBudget } from '@/lib/jobs/budget'
import { getPaymentGateway } from '@/lib/payments'
import { runPayouts, settleUnconfirmedPayouts } from '@/lib/payments/payout'
import { reconcileCapturedPayments } from '@/lib/payments/materialize'
import { sweepCaptureExceptions } from '@/lib/payments/capture-exceptions'

export const dynamic = 'force-dynamic'
// Audit M38 — every job below moves money; one ceiling, one time budget across them.
export const maxDuration = 300

/**
 * Runs all four time-based jobs in sequence. This was the single registered cron
 * under the Vercel Hobby plan (≤2 crons, daily-only). On Pro the jobs are split
 * back into independent schedules (see vercel.json + ADR 001), so this route is
 * NO LONGER scheduled — it's kept as a guarded "run everything once" endpoint for
 * ops/manual backfills. Idempotent throughout. §ADR 001.
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const budget = timeBudget(maxDuration)
  const admin = await createAdminClient()
  const now = new Date().toISOString()

  // 1. Auto-cancel orders placed >24h ago (→ refund 100%).
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const stale = await staleOrdersForAutoCancel(admin, cutoff)
  let cancelled = 0
  for (const o of stale) {
    if (budget.spent()) break
    if (await autoCancelOrder(admin, o)) cancelled++
  }

  // 2. Auto-accept delivered orders past their 72h window (→ payout + invoices).
  const { data: due } = await admin.from('orders').select('*').eq('status', 'delivered').lte('auto_accept_at', now).order('auto_accept_at', { ascending: true }).limit(100)
  let completed = 0
  for (const o of due ?? []) {
    if (budget.spent()) break
    if (await autoAcceptOrder(admin, o)) completed++
  }

  // 3. Payout batch (T+2 due).
  const payouts = await runPayouts(admin, getPaymentGateway())

  // 4. Reconcile dropped webhooks (last 48h).
  const recon = await reconcileCapturedPayments(getPaymentGateway(), Math.floor(Date.now() / 1000) - 2 * 24 * 3600, admin)

  // 5. ADR 026 sweepers: failed cancellation refunds, unconfirmed payouts, missing invoices;
  //    audit M38: completed orders whose payout row was never written.
  const refunds = await redriveCancellationRefunds(admin, budget)
  const unconfirmed = await settleUnconfirmedPayouts(admin, getPaymentGateway())
  const missingPayouts = await sweepMissingPayouts(admin, budget)
  const invoices = await generateMissingInvoices(admin, budget)
  // ADR 027 — captures that created no order are refunded in full.
  const captures = await sweepCaptureExceptions(admin, getPaymentGateway())

  return NextResponse.json({ cancelled, completed, payouts: payouts.processed, reconciled: recon.recovered, refundsRedriven: refunds.refunded, unconfirmedPayouts: unconfirmed, payoutsSwept: missingPayouts.scheduled, stalledResolutions: missingPayouts.stalledResolutions, invoicesGenerated: invoices.generated, captureRefunds: captures.refunded })
}
