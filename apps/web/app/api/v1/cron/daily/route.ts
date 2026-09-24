import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { autoCancelOrder, staleOrdersForAutoCancel, autoAcceptOrder } from '@/lib/orders/transitions'
import { getPaymentGateway } from '@/lib/payments'
import { runPayouts } from '@/lib/payments/payout'
import { reconcileCapturedPayments } from '@/lib/payments/materialize'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Runs all four time-based jobs in sequence. This was the single registered cron
 * under the Vercel Hobby plan (≤2 crons, daily-only). On Pro the jobs are split
 * back into independent schedules (see vercel.json + ADR 001), so this route is
 * NO LONGER scheduled — it's kept as a guarded "run everything once" endpoint for
 * ops/manual backfills. Idempotent throughout. §ADR 001.
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  const now = new Date().toISOString()

  // 1. Auto-cancel orders placed >24h ago (→ refund 100%).
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const stale = await staleOrdersForAutoCancel(admin, cutoff)
  let cancelled = 0
  for (const o of stale) if (await autoCancelOrder(admin, o)) cancelled++

  // 2. Auto-accept delivered orders past their 72h window (→ payout + invoices).
  const { data: due } = await admin.from('orders').select('*').eq('status', 'delivered').lte('auto_accept_at', now).limit(200)
  let completed = 0
  for (const o of due ?? []) if (await autoAcceptOrder(admin, o)) completed++

  // 3. Payout batch (T+2 due).
  const payouts = await runPayouts(admin, getPaymentGateway())

  // 4. Reconcile dropped webhooks (last 48h).
  const recon = await reconcileCapturedPayments(getPaymentGateway(), Math.floor(Date.now() / 1000) - 2 * 24 * 3600, admin)

  return NextResponse.json({ cancelled, completed, payouts: payouts.processed, reconciled: recon.recovered })
}
