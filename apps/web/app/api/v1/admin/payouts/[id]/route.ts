import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { isValidPayoutTransition, type PayoutStatus } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'
import { getPaymentGateway } from '@/lib/payments'
import { runPayouts } from '@/lib/payments/payout'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { writeAudit } from '@/lib/audit/log'
import { getGoodsDossier } from '@/lib/mart/release'

const bodySchema = z.object({ action: z.literal('retry') })

/**
 * Phase 8 §7 — payout release/retry: failed|held → scheduled, validated against
 * the canonical PAYOUT_TRANSITIONS map (§2.5 rule 8) and audit-logged.
 * Since the founder-approval gate (PAYOUT_AUTO_RELEASE off ⇒ payouts are born
 * 'held'), this action IS the money-moving moment: after rescheduling, it runs
 * the transfer immediately for this order so "release" settles under the
 * admin's finger rather than waiting for the next daily cron.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const rl = await enforce(limiters.adminMutation, `admin:${gate.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const { id } = await params
  const admin = await createAdminClient()
  const { data: payout } = await admin.from('payouts').select('id, status, order_id, provider_id, amount_paise').eq('id', id).maybeSingle()
  if (!payout) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const from = payout.status as PayoutStatus
  if (!isValidPayoutTransition(from, 'scheduled')) {
    return NextResponse.json({ error: `illegal transition ${from} → scheduled` }, { status: 409 })
  }

  // AMC Mart — goods release gate (MART_DESIGN.md §4.3): a goods payout is
  // NEVER released while delivery evidence, receipt, the return window or an
  // open return still hold. Services orders (kind='service') skip this block.
  const { data: ord } = await admin.from('orders').select('*').eq('id', payout.order_id).maybeSingle()
  if (ord?.kind === 'goods') {
    const dossier = await getGoodsDossier(admin, ord)
    if (!dossier.gate.ok) {
      return NextResponse.json({ error: 'goods_release_gate', reasons: dossier.gate.reasons, dossier }, { status: 409 })
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
    payload: { payout_id: id, from_status: from, amount_paise: Number(payout.amount_paise) },
  })

  // Settle immediately (release = pay now). A transfer failure marks the
  // payout 'failed' inside runPayouts — visible in the monitor for retry.
  const run = await runPayouts(admin, getPaymentGateway(), { orderId: payout.order_id })
  const { data: after } = await admin.from('payouts').select('status').eq('id', id).maybeSingle()
  const finalStatus = after?.status ?? 'scheduled'

  await writeAudit(admin, request, {
    actorId: gate.userId,
    action: 'payout_release',
    entity: 'payouts',
    entityId: id,
    before: { status: from },
    after: { status: finalStatus, amount_paise: Number(payout.amount_paise), simulated: run.simulated },
  })

  return NextResponse.json({ ok: finalStatus === 'paid', status: finalStatus })
}
