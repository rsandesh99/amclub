import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { getPaymentGateway } from '@/lib/payments'
import { reconcileCapturedPayments } from '@/lib/payments/materialize'
import { settleUnconfirmedPayouts } from '@/lib/payments/payout'
import { generateMissingInvoices } from '@/lib/orders/transitions'

export const dynamic = 'force-dynamic'

/** Reconciliation (every 6 h): recover orders for captured payments whose
 *  webhook was dropped (idempotent; the dropped-webhook kill-test proves it),
 *  settle payouts whose transfer outcome was unknown, and generate invoices an
 *  order action could not (ADR 026). A payout that settles as failed, or is
 *  still unknown, marks the run degraded (M35). */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  return runCronJob(admin, 'reconcile', async () => {
    const since = Math.floor(Date.now() / 1000) - 2 * 24 * 3600 // last 48h
    const captured = await reconcileCapturedPayments(getPaymentGateway(), since, admin)
    const payouts = await settleUnconfirmedPayouts(admin, getPaymentGateway())
    const invoices = await generateMissingInvoices(admin)
    return { ...captured, unconfirmedPayouts: payouts, missingInvoices: invoices }
  })
}
