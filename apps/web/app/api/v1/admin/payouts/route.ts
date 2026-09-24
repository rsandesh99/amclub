import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { PAYOUT_STATUSES } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { bankFacts, payoutReadiness } from '@/lib/payments/readiness'
import { AGENT_ENABLED } from '@/lib/flags'
import { latestDossiersByOrder } from '@/lib/agent/dossiers'
import { isSimulatedPayment } from '@/lib/payments/simulation'

/** Statuses that are still waiting on us — aged oldest-first (Phase 3c). */
const OPEN = new Set(['held', 'scheduled', 'failed'])

interface PayoutRow {
  id: string
  amount_paise: number
  status: string
  scheduled_for: string | null
  razorpay_transfer_id: string | null
  paid_at: string | null
  created_at: string
  updated_at: string | null
  order_id: string
  provider_id: string
  order: { id: string; order_number: string; title: string; status: string } | null
  provider: { id: string; display_name: string; slug: string; status: string } | null
}

/**
 * Phase 8 §7 — payout monitor queue. Ops sees every payout by state
 * (scheduled/processing/paid/failed/held) with order + provider context.
 * Phase 3a/3c add, per row: the provider's payout readiness (so a held payout
 * that WILL fail on release is visible before the tap), days pending, and the
 * hold reasons from the payout_held order_event. Open statuses sort oldest first.
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdmin({ agentTool: 'recommend_payout_release' })
  if (gate.error) return gate.error

  const status = request.nextUrl.searchParams.get('status')
  const admin = await createAdminClient()

  let q = admin
    .from('payouts')
    .select(
      'id, amount_paise, status, scheduled_for, razorpay_transfer_id, paid_at, created_at, updated_at, order_id, provider_id, ' +
        'order:orders(id, order_number, title, status), provider:provider_profiles(id, display_name, slug, status)',
    )
    .limit(200)
  const openView = status ? OPEN.has(status) : false
  q = q.order('created_at', { ascending: openView })
  if (status && (PAYOUT_STATUSES as readonly string[]).includes(status)) {
    q = q.eq('status', status)
  }
  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  // supabase-js cannot infer a row type from a select string that embeds
  // relations — name the shape we actually read.
  const rows = (data ?? []) as unknown as PayoutRow[]

  // Readiness per provider (status only — never the account number).
  const providerIds = [...new Set(rows.map((r) => r.provider_id).filter(Boolean))]
  const { data: banks } = providerIds.length
    ? await admin.from('provider_bank_accounts').select('provider_id, penny_drop_verified, razorpay_route_account_id').in('provider_id', providerIds)
    : { data: [] as { provider_id: string; penny_drop_verified: boolean; razorpay_route_account_id: string | null }[] }
  const bankByProvider = new Map((banks ?? []).map((b) => [b.provider_id, b]))

  // Hold reasons: latest payout_held event per order (payload.reasons[]).
  const orderIds = rows.filter((r) => OPEN.has(r.status)).map((r) => r.order_id).filter(Boolean)
  const { data: heldEvents } = orderIds.length
    ? await admin.from('order_events').select('order_id, payload, created_at').eq('event', 'payout_held').in('order_id', orderIds).order('created_at', { ascending: false })
    : { data: [] as { order_id: string; payload: unknown; created_at: string }[] }
  const reasonsByOrder = new Map<string, string[]>()
  for (const e of heldEvents ?? []) {
    if (reasonsByOrder.has(e.order_id)) continue
    const reasons = (e.payload as { reasons?: string[] } | null)?.reasons ?? []
    reasonsByOrder.set(e.order_id, reasons)
  }

  // ADR 027 (audit M2) — which rows were paid for by a SIMULATED payment (pay_sim_ id /
  // webhook_payload.simulated): the monitor says so, and runPayouts never sends them
  // real money. Bundle children read their purchase's payment (not flagged here).
  const allOrderIds = [...new Set(rows.map((r) => r.order_id).filter(Boolean))]
  const { data: pays } = allOrderIds.length
    ? await admin.from('payments').select('order_id, razorpay_payment_id, simulated:webhook_payload->simulated').in('order_id', allOrderIds)
    : { data: [] as { order_id: string; razorpay_payment_id: string | null; simulated: unknown }[] }
  const simulatedOrders = new Set(((pays ?? []) as { order_id: string; razorpay_payment_id: string | null; simulated: unknown }[]).filter((p) => isSimulatedPayment(p)).map((p) => p.order_id))

  // S1.4 — latest payout dossier per order (agent surface: only when the flag is on).
  const dossiers = AGENT_ENABLED ? await latestDossiersByOrder(admin, rows.map((r) => r.order_id).filter(Boolean)) : new Map()

  const now = Date.now()
  const payouts = rows.map((r) => {
    const facts = bankFacts(bankByProvider.get(r.provider_id))
    const open = OPEN.has(r.status)
    return {
      ...r,
      ...(AGENT_ENABLED ? { dossier: dossiers.get(r.order_id) ?? null } : {}),
      readiness: payoutReadiness(facts),
      days_pending: open ? Math.floor((now - new Date(r.created_at).getTime()) / 86_400_000) : null,
      hold_reasons: open ? (reasonsByOrder.get(r.order_id) ?? []) : [],
      simulated: simulatedOrders.has(r.order_id),
    }
  })
  // Unfiltered view: open rows first, oldest first; settled rows after, newest first.
  if (!status) {
    payouts.sort((a, b) => {
      const ao = OPEN.has(a.status) ? 0 : 1
      const bo = OPEN.has(b.status) ? 0 : 1
      if (ao !== bo) return ao - bo
      const at = new Date(a.created_at).getTime()
      const bt = new Date(b.created_at).getTime()
      return ao === 0 ? at - bt : bt - at
    })
  }

  // Queue health at a glance: counts per state (unfiltered).
  const { data: all } = await admin.from('payouts').select('status')
  const counts: Record<string, number> = {}
  for (const s of PAYOUT_STATUSES) counts[s] = 0
  for (const row of all ?? []) counts[row.status] = (counts[row.status] ?? 0) + 1

  return NextResponse.json({ payouts, counts })
}
