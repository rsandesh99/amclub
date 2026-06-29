import type { createAdminClient } from '@/lib/supabase/server'
import type { PaymentGateway } from './types'
import { notifyPayoutPaid } from '@/lib/notifications/events'

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

    const transfer = await gateway.createTransfer({
      linkedAccountId: bank?.razorpay_route_account_id ?? null,
      amountPaise: p.amount_paise,
      notes: { order_id: p.order_id },
    })
    if (transfer.simulated) simulated = true

    await admin
      .from('payouts')
      .update({ status: 'paid', razorpay_transfer_id: transfer.razorpayTransferId, paid_at: new Date().toISOString() })
      .eq('id', p.id)
    transferIds.push(transfer.razorpayTransferId)
    try { await notifyPayoutPaid(admin, p.provider_id, Number(p.amount_paise), p.order_id) } catch (e) { console.error('[notifyPayoutPaid]', e) }
  }
  return { processed: transferIds.length, transferIds, simulated }
}
