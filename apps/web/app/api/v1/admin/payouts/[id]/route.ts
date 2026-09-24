import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { isValidPayoutTransition, payoutReleaseBodySchema, PAYOUT_RELEASE_STATUSES, type OrderStatus, type PayoutStatus } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { requireNotDelegated } from '@/lib/agent/scope'
import { getPaymentGateway } from '@/lib/payments'
import { runPayouts } from '@/lib/payments/payout'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { writeAudit } from '@/lib/audit/log'
import { getGoodsDossier } from '@/lib/mart/release'
import { getServicesEvidence } from '@/lib/orders/evidence'
import { closeDossierApprove, getDossier, type DossierRow } from '@/lib/agent/dossiers'
import { paymentForOrder } from '@/lib/payments/order-payment'
import { moneyMovementBlock, PAYMENTS_UNAVAILABLE } from '@/lib/payments/simulation'

/**
 * Phase 8 §7 — payout release/retry: failed|held → scheduled, validated against
 * the canonical PAYOUT_TRANSITIONS map (§2.5 rule 8) and audit-logged.
 * Since the founder-approval gate (PAYOUT_AUTO_RELEASE off ⇒ payouts are born
 * 'held'), this action IS the money-moving moment: after rescheduling, it runs
 * the transfer immediately for this order so "release" settles under the
 * admin's finger rather than waiting for the next daily cron.
 *
 * S1.4: the body may carry `dossier_id` (+ `note`). When present and matching
 * this payout, the founder's tap ALSO closes the payout dossier as 'approve'
 * (one ai_decisions row, feature payout_dossier). Without it, behaviour is
 * unchanged. No agent tool wraps this route: any delegated token is refused
 * (requireNotDelegated) — the runtime can never release money.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error
  const delegated = await requireNotDelegated('POST /admin/payouts/[id]')
  if (delegated) return delegated

  const rl = await enforce(limiters.adminMutation, `admin:${gate.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const parsed = payoutReleaseBodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const { id } = await params
  const admin = await createAdminClient()
  const { data: payout } = await admin.from('payouts').select('id, status, order_id, provider_id, amount_paise').eq('id', id).maybeSingle()
  if (!payout) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // S1.4 — validate the dossier BEFORE anything moves: it must belong to this
  // payout and be undecided (a decision is written once → 409 on a second tap).
  let dossier: DossierRow | null = null
  if (parsed.data.dossier_id) {
    dossier = await getDossier(admin, parsed.data.dossier_id)
    if (!dossier || (dossier.payout_id && dossier.payout_id !== id) || dossier.order_id !== payout.order_id) {
      return NextResponse.json({ error: 'dossier_mismatch' }, { status: 422 })
    }
    if (dossier.decision) return NextResponse.json({ error: 'dossier_already_decided', decision: dossier.decision }, { status: 409 })
  }

  const from = payout.status as PayoutStatus
  if (!isValidPayoutTransition(from, 'scheduled')) {
    return NextResponse.json({ error: `illegal transition ${from} → scheduled` }, { status: 409 })
  }

  // ADR 026 (audit M19) — only an order in a release status may pay out; an
  // open dispute (order 'disputed') always blocks. runPayouts re-checks this.
  const { data: ord } = await admin.from('orders').select('*').eq('id', payout.order_id).maybeSingle()
  if (!ord || !PAYOUT_RELEASE_STATUSES.includes(ord.status as OrderStatus)) {
    return NextResponse.json({ error: 'order_not_releasable', orderStatus: ord?.status ?? null }, { status: 409 })
  }

  // ADR 027 (audit M2) — no transfer through the simulation gateway on production
  // (503, the payout stays as it is), and no real transfer for an order whose
  // payment was simulated (409). runPayouts re-checks both.
  const gateway = getPaymentGateway()
  const payment = await paymentForOrder<{ id: string; razorpay_payment_id: string | null; simulated: unknown }>(admin, ord, 'id, razorpay_payment_id, simulated:webhook_payload->simulated')
  const blocked = moneyMovementBlock(gateway.isReal, payment)
  if (blocked) return NextResponse.json({ error: blocked }, { status: blocked === PAYMENTS_UNAVAILABLE ? 503 : 409 })

  // AMC Mart — goods release gate (MART_DESIGN.md §4.3): a goods payout is
  // NEVER released while delivery evidence, receipt, the return window or an
  // open return still hold. Services orders (kind='service') skip this block.
  if (ord?.kind === 'goods') {
    const goods = await getGoodsDossier(admin, ord)
    if (!goods.gate.ok) {
      return NextResponse.json({ error: 'goods_release_gate', reasons: goods.gate.reasons, dossier: goods }, { status: 409 })
    }
  } else if (ord) {
    // Services evidence gate (S0.3): only enforced for orders placed on/after
    // the evidence_required_from cutover (inert otherwise).
    const ev = await getServicesEvidence(admin, ord)
    if (ev.enforced && !ev.gate.ok) {
      return NextResponse.json({ error: 'services_release_gate', reasons: ev.gate.reasons, milestones: ev.milestones }, { status: 409 })
    }
  }

  const { error } = await admin
    .from('payouts')
    .update({ status: 'scheduled', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', from) // optimistic guard against concurrent state change
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await admin.from('order_events').insert({
    order_id: payout.order_id,
    actor_id: gate.userId,
    event: 'payout_released',
    payload: { payout_id: id, from_status: from, amount_paise: Number(payout.amount_paise), ...(dossier ? { dossier_id: dossier.id } : {}) },
  })

  // S1.4 — the founder's tap closes the dossier as approve (recorded once).
  let dossierDecisionId: string | null = null
  if (dossier) {
    const r = await closeDossierApprove(admin, dossier, gate.userId, parsed.data.note ?? null)
    if (r.ok) dossierDecisionId = r.decisionId
    else console.error('[payout release] dossier close failed', r.error, dossier.id)
  }

  // Settle immediately (release = pay now). A transfer failure marks the
  // payout 'failed' inside runPayouts — visible in the monitor for retry.
  const run = await runPayouts(admin, gateway, { orderId: payout.order_id })
  const { data: after } = await admin.from('payouts').select('status').eq('id', id).maybeSingle()
  const finalStatus = after?.status ?? 'scheduled'

  await writeAudit(admin, request, {
    actorId: gate.userId,
    action: 'payout_release',
    entity: 'payouts',
    entityId: id,
    before: { status: from },
    after: {
      status: finalStatus,
      amount_paise: Number(payout.amount_paise),
      simulated: run.simulated,
      ...(dossier ? { dossier_id: dossier.id, dossier_decision_id: dossierDecisionId, recommendation: dossier.recommendation } : {}),
    },
  })

  return NextResponse.json({
    ok: finalStatus === 'paid',
    status: finalStatus,
    ...(dossier ? { dossier_id: dossier.id, dossier_decision: 'approve', dossier_decision_id: dossierDecisionId } : {}),
  })
}
