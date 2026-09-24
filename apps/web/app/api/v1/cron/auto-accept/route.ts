import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { timeBudget } from '@/lib/jobs/budget'
import { autoAcceptOrder } from '@/lib/orders/transitions'

export const dynamic = 'force-dynamic'
// Audit M38 — a money cron (completes orders, schedules payouts): an explicit
// ceiling, and a time budget inside it so the run stops cleanly.
export const maxDuration = 300

/** Delivered orders past their auto_accept_at (72h) → completed (+ payout + invoices).
 *  Oldest first, 100 at a time, inside the time budget; the next hourly run takes
 *  the rest. A payout the side effects missed is swept by the reconcile cron. */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const budget = timeBudget(maxDuration)
  const admin = await createAdminClient()
  return runCronJob(admin, 'auto-accept', async () => {
    const now = new Date().toISOString()
    const { data: due, error } = await admin
      .from('orders')
      .select('*')
      .eq('status', 'delivered')
      .lte('auto_accept_at', now)
      .order('auto_accept_at', { ascending: true })
      .limit(100)
    if (error) throw new Error(`due orders lookup: ${error.message}`)

    let completed = 0
    let deferred = 0
    const rows = due ?? []
    for (let i = 0; i < rows.length; i++) {
      if (budget.spent()) { deferred = rows.length - i; break }
      if (await autoAcceptOrder(admin, rows[i])) completed++
    }
    return { checked: rows.length, completed, deferred }
  })
}
