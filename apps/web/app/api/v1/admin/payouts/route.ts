import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { PAYOUT_STATUSES } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'

/**
 * Phase 8 §7 (unmet P7 claim) — payout monitor queue. Ops sees every payout by
 * state (scheduled/processing/paid/failed/held) with order + provider context
 * instead of digging through individual order pages.
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const status = request.nextUrl.searchParams.get('status')
  const admin = await createAdminClient()

  let q = admin
    .from('payouts')
    .select(
      'id, amount_paise, status, scheduled_for, razorpay_transfer_id, paid_at, created_at, updated_at, ' +
        'order:orders(id, order_number, title, status), provider:provider_profiles(id, display_name, slug, status)',
    )
    .order('created_at', { ascending: false })
    .limit(200)
  if (status && (PAYOUT_STATUSES as readonly string[]).includes(status)) {
    q = q.eq('status', status)
  }
  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Queue health at a glance: counts per state (unfiltered).
  const { data: all } = await admin.from('payouts').select('status')
  const counts: Record<string, number> = {}
  for (const s of PAYOUT_STATUSES) counts[s] = 0
  for (const row of all ?? []) counts[row.status] = (counts[row.status] ?? 0) + 1

  return NextResponse.json({ payouts: data ?? [], counts })
}
