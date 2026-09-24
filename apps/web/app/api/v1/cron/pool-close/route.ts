import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { MART_ENABLED } from '@/lib/flags'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { recordHeartbeat } from '@/lib/jobs/heartbeat'
import { closeDuePools, settleOpenSettlements } from '@/lib/mart/pools'
import { measureGoodsPromiseBreaches } from '@/lib/mart/promises'
import { sendDueReorderReminders } from '@/lib/mart/reorder'

export const dynamic = 'force-dynamic'

/**
 * AMC Mart hourly: close open pools past closes_at (met / unmet), then settle
 * closed_met pools (paid members → captured, lapsed → failed; → ordered /
 * fulfilled); then measure seller-promise breaches on recent goods orders
 * (E16 N41 — records only, never money); then send due reorder reminders
 * (E16 N44, each once). Inert while MART_ENABLED=false:
 * returns skipped, touches nothing.
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (!MART_ENABLED) return NextResponse.json({ skipped: 'mart_disabled' })
  const admin = await createAdminClient()
  const closed = await closeDuePools(admin)
  const settled = await settleOpenSettlements(admin)
  const promises = await measureGoodsPromiseBreaches(admin)
  const reminders = await sendDueReorderReminders(admin)
  const result = { ...closed, ...settled, promiseOrders: promises.orders, promiseBreaches: promises.breaches, reorderReminders: reminders.sent }
  await recordHeartbeat(admin, 'pool-close', result)
  return NextResponse.json(result)
}
