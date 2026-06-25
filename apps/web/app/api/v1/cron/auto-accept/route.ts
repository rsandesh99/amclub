import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { autoAcceptOrder } from '@/lib/orders/transitions'

export const dynamic = 'force-dynamic'

/** Delivered orders past their auto_accept_at (72h) → completed (+ payout + invoices). */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  const now = new Date().toISOString()

  const { data: due } = await admin
    .from('orders')
    .select('*')
    .eq('status', 'delivered')
    .lte('auto_accept_at', now)
    .limit(200)

  let completed = 0
  for (const order of due ?? []) {
    if (await autoAcceptOrder(admin, order)) completed++
  }
  return NextResponse.json({ checked: due?.length ?? 0, completed })
}
