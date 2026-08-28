import type { createAdminClient } from '@/lib/supabase/server'
import type { PaymentGateway } from './types'
import { notifyPayoutPaid } from '@/lib/notifications/events'
import { assertFeeHeadroom, FeeHeadroomError } from './fees'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * Process due provider payouts via Razorpay Route (or simulation). Idempotent:
 * only 'scheduled' payouts are claimed (CAS to 'processing'), so a re-run never
 * double-pays. Payout releases ONLY from completed/resolved states — enforced
 * upstream by schedulePayout (PAYOUT_RELEASE_STATUSES) and held rows are skipped.
 */
export async function runPayouts(
  admin: Admin,
  gateway: PaymentGateway,
  opts?: { allScheduled?: boolean; orderId?: string },
): Promise<{ processed: number; transferIds: string[]; simulated: boolean }> {
  const today = new Date().toISOString().slice(0, 10)
  let query = admin.from('payouts').select('*').eq('status', 'scheduled')
  // Single-order settlement (dispute resolution / manual retry) reuses this same
  // proven transfer path — never a parallel money path.
  if (opts?.orderId) query = query.eq('order_id', opts.orderId)
  else if (!opts?.allScheduled) query = query.lte('scheduled_for', today)
  const { data: due } = await query

  const transferIds: string[] = []
  let simulated = false
  for (const p of due ?? []) {
    // CAS claim: scheduled → processing (one worker wins).
    const { data: claimed } = await admin
      .from('payouts')
      .update({ status: 'processing', updated_at: new Date().toISOString() })
      .eq('id', p.id)
      .eq('status', 'scheduled')
      .select('id')
      .maybeSingle()
    if (!claimed) continue

    const { data: bank } = await admin
      .from('provider_bank_accounts')
      .select('razorpay_route_account_id')
      .eq('provider_id', p.provider_id)
      .maybeSingle()

    let transfer
    try {
      // ADR-004 / F2 guard: the transfer is ALWAYS the provider's full amount;
      // if Razorpay's fee would not fit inside the captured amount and inside
      // our commission, refuse loudly (payout → failed with the numbers) —
      // never shrink the provider's transfer to make room.
      const { data: ord } = await admin
        .from('orders')
        .select('total_paise, commission_paise')
        .eq('id', p.order_id)
        .maybeSingle()
      if (ord) {
        assertFeeHeadroom({
          transferPaise: Number(p.amount_paise),
          capturedPaise: Number(ord.total_paise),
          commissionPaise: Number(ord.commission_paise),
        })
      }
      transfer = await gateway.createTransfer({
        linkedAccountId: bank?.razorpay_route_account_id ?? null,
        amountPaise: p.amount_paise,
        notes: { order_id: p.order_id },
      })
    } catch (e) {
      // Transfer failed (e.g. no Route linked account, Route error). Mark the
      // payout 'failed' so it surfaces in /admin/payouts for retry — never
      // leave it stuck in 'processing' or pretend it was paid.
      console.error('[runPayouts] transfer failed for payout', p.id, e)
      await admin
        .from('payouts')
        .update({ status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', p.id)
        .eq('status', 'processing')
      await admin.from('order_events').insert({
        order_id: p.order_id,
        actor_id: null,
        event: 'payout_failed',
        payload: {
          payout_id: p.id,
          amount_paise: p.amount_paise,
          reason: e instanceof FeeHeadroomError ? 'fee_headroom' : e instanceof Error ? e.message.slice(0, 200) : 'transfer_failed',
          ...(e instanceof FeeHeadroomError ? { fee: e.detail } : {}),
        },
      })
      continue
    }
    if (transfer.simulated) simulated = true

    const paidAt = new Date().toISOString()
    await admin
      .from('payouts')
      .update({ status: 'paid', razorpay_transfer_id: transfer.razorpayTransferId, paid_at: paidAt })
      .eq('id', p.id)
    await admin.from('order_events').insert({
      order_id: p.order_id,
      actor_id: null,
      event: 'payout_paid',
      payload: {
        payout_id: p.id,
        amount_paise: p.amount_paise,
        razorpay_transfer_id: transfer.razorpayTransferId,
        simulated: Boolean(transfer.simulated),
      },
    })
    transferIds.push(transfer.razorpayTransferId)
    try { await notifyPayoutPaid(admin, p.provider_id, Number(p.amount_paise), p.order_id) } catch (e) { console.error('[notifyPayoutPaid]', e) }
  }
  return { processed: transferIds.length, transferIds, simulated }
}
