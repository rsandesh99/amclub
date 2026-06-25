import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { getPaymentGateway } from '@/lib/payments'
import { reconcileCapturedPayments } from '@/lib/payments/materialize'

export const dynamic = 'force-dynamic'

/** Daily reconciliation: recover orders for captured payments whose webhook was
 *  dropped. Idempotent (proven by the dropped-webhook kill-test). */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const since = Math.floor(Date.now() / 1000) - 2 * 24 * 3600 // last 48h
  const result = await reconcileCapturedPayments(getPaymentGateway(), since)
  return NextResponse.json(result)
}
