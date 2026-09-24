import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { MART_ENABLED } from '@/lib/flags'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { closeDuePools, settleOpenSettlements } from '@/lib/mart/pools'
import { measureGoodsPromiseBreaches } from '@/lib/mart/promises'
import { sendDueReorderReminders } from '@/lib/mart/reorder'

export const dynamic = 'force-dynamic'
// Audit M38 — the Mart cron settles pool payments into orders: an explicit ceiling.
export const maxDuration = 300

/**
 * AMC Mart hourly: close open pools past closes_at (met / unmet), then settle
 * closed_met pools (paid members → captured, lapsed → failed; → ordered /
 * fulfilled); then measure seller-promise breaches on recent goods orders
 * (E16 N41 — records only, never money); then send due reorder reminders
 * (E16 N44, each once). Inert while MART_ENABLED=false:
 * returns skipped, touches nothing (no heartbeat either; /admin expects none).
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (!MART_ENABLED) return NextResponse.json({ skipped: 'mart_disabled' })
  const admin = await createAdminClient()
  return runCronJob(admin, 'pool-close', async () => {
    const closed = await closeDuePools(admin)
    const settled = await settleOpenSettlements(admin)
    const promises = await measureGoodsPromiseBreaches(admin)
    const reminders = await sendDueReorderReminders(admin)
    return { ...closed, ...settled, promiseOrders: promises.orders, promiseBreaches: promises.breaches, reorderReminders: reminders.sent }
  })
}
