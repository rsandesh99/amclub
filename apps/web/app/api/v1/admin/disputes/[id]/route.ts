import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { requireToolScope } from '@/lib/agent/scope'
import { AGENT_ENABLED } from '@/lib/flags'
import { listStatements, loadQuoteThread } from '@/lib/disputes/statements'
import { getLatestTriageForDispute, triageHistory } from '@/lib/agent/triages'
import { paymentForOrder, refundForOrder } from '@/lib/payments/order-payment'

/**
 * GET — full dispute detail: order, timeline, payment, payout, refund, documents,
 * (S1.7) both party statements, the pre-payment quote thread (masked) and the
 * latest triage (+ history). An ORDINARY admin read (requireAdmin, not an agent
 * surface); the scope check is a no-op for humans and refuses a delegated token
 * whose grant lacks summarize_dispute — the S1.4 evidence-route precedent.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin({ agentTool: 'summarize_dispute' })
  if (gate.error) return gate.error
  const scope = await requireToolScope('summarize_dispute')
  if (scope) return scope

  const { id } = await params
  const admin = await createAdminClient()
  const { data: dispute } = await admin.from('disputes').select('*').eq('id', id).maybeSingle()
  if (!dispute) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: order } = await admin.from('orders').select('*').eq('id', dispute.order_id).maybeSingle()
  const [{ data: events }, { data: payment }, { data: payout }, { data: docs }] = await Promise.all([
    admin.from('order_events').select('id, event, payload, created_at, actor_id').eq('order_id', dispute.order_id).order('created_at', { ascending: true }),
    order ? paymentForOrder<{ id: string; status: string; amount_paise: number; razorpay_payment_id: string | null }>(admin, order, 'id, status, amount_paise, razorpay_payment_id').then((data) => ({ data })) : Promise.resolve({ data: null }),
    admin.from('payouts').select('id, status, amount_paise, paid_at').eq('order_id', dispute.order_id).maybeSingle(),
    admin.from('order_documents').select('id, file_name, kind, created_at').eq('order_id', dispute.order_id),
  ])
  const refund = payment && order ? await refundForOrder(admin, order, payment.id, 'id, status, amount_paise, created_at') : null

  // S1.7 — statements (spine) + the quote thread always; the triage only while the agent surface exists.
  const [statements, thread, triage, history] = await Promise.all([
    listStatements(admin, id),
    order ? loadQuoteThread(admin, order as { source: string | null; quote_id: string | null; msme_id: string; provider_id: string }) : Promise.resolve([]),
    AGENT_ENABLED ? getLatestTriageForDispute(admin, id) : Promise.resolve(null),
    AGENT_ENABLED ? triageHistory(admin, id) : Promise.resolve([]),
  ])
  // Actor roles on events (the evidence payload's shape) so the triage can cite them.
  const { data: m } = order ? await admin.from('msme_profiles').select('user_id').eq('id', order.msme_id).maybeSingle() : { data: null }
  const { data: p } = order ? await admin.from('provider_profiles').select('user_id').eq('id', order.provider_id).maybeSingle() : { data: null }
  const roleOf = (actorId: string | null) => (actorId == null ? 'system' : actorId === (m as { user_id?: string } | null)?.user_id ? 'msme' : actorId === (p as { user_id?: string } | null)?.user_id ? 'provider' : 'admin')
  const eventsOut = (events ?? []).map((e) => ({ ...e, actor_role: roleOf((e as { actor_id?: string | null }).actor_id ?? null) }))

  return NextResponse.json({
    dispute, order, events: eventsOut, payment, payout, refund, documents: docs ?? [],
    statements, thread,
    ...(AGENT_ENABLED ? { triage, triage_history: history.map((h) => ({ id: h.id, created_at: h.created_at, recommendation: h.triage.recommendation, decision: h.decision })) } : {}),
  })
}
