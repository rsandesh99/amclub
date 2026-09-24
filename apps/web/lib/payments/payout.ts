import type { createAdminClient } from '@/lib/supabase/server'
import type { GatewayTransfer, PaymentGateway } from './types'
import { notifyPayoutPaid } from '@/lib/notifications/events'
import { assertFeeHeadroom, FeeHeadroomError } from './fees'
import { payoutRunBlockers } from './release-gate'
import { reportOpsError, reportOpsIssue } from '@/lib/observability'
import { paymentsAvailable } from './simulation'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * ADR 026 — a transfer error is a definite failure only when the gateway (or our
 * own pre-check) refused it: then nothing was sent and a retry is safe. Anything
 * else (network error, timeout, 5xx) may have created the transfer, so the
 * payout stays 'processing' as unconfirmed and is never retried blind.
 */
export function isDefiniteTransferFailure(e: unknown): boolean {
  if (e instanceof FeeHeadroomError) return true
  if (e instanceof Error && e.message.startsWith('route_account_missing')) return true
  const status = typeof e === 'object' && e !== null ? (e as { statusCode?: unknown }).statusCode : undefined
  return typeof status === 'number' && status >= 400 && status < 500
}

function describe(e: unknown): string {
  if (e instanceof FeeHeadroomError) return 'fee_headroom'
  if (e instanceof Error) return e.message.slice(0, 200)
  const gw = typeof e === 'object' && e !== null ? (e as { statusCode?: number; error?: { code?: string; description?: string } }) : null
  if (gw?.statusCode) return `gateway_${gw.statusCode}: ${(gw.error?.code ?? '')} ${(gw.error?.description ?? '')}`.trim().slice(0, 200)
  return 'transfer_failed'
}

/** Was this payout sent before (a failed or unconfirmed attempt)? Then ask the gateway first. */
async function attemptedBefore(admin: Admin, payout: any): Promise<boolean> {
  const { data } = await admin
    .from('order_events')
    .select('id')
    .eq('order_id', payout.order_id)
    .in('event', ['payout_failed', 'payout_unconfirmed'])
    .eq('payload->>payout_id', payout.id)
    .limit(1)
  return (data ?? []).length > 0
}

/** Look-back for findTransfer: from a day before the payout row was created. */
const lookbackUnix = (payout: any) => Math.floor(new Date(payout.created_at ?? Date.now()).getTime() / 1000) - 24 * 3600

/**
 * ADR 027 — transfers the gateway reported failed or reversed for this payout
 * (the webhook records them as `payout_failed` with `source: 'gateway'`). They
 * never settle the payout again: a retry sends a new transfer instead.
 */
export async function deadTransferIds(admin: Admin, payout: { id: string; order_id: string }): Promise<string[]> {
  const { data } = await admin
    .from('order_events')
    .select('payload')
    .eq('order_id', payout.order_id)
    .eq('event', 'payout_failed')
    .eq('payload->>payout_id', payout.id)
    .eq('payload->>source', 'gateway')
  return (data ?? []).map((e) => (e.payload as { razorpay_transfer_id?: string } | null)?.razorpay_transfer_id).filter((x): x is string => typeof x === 'string')
}

export async function markPaid(admin: Admin, payout: any, transfer: GatewayTransfer, recovered: boolean, extra?: Record<string, unknown>): Promise<boolean> {
  const { data: paid } = await admin
    .from('payouts')
    .update({ status: 'paid', razorpay_transfer_id: transfer.razorpayTransferId, paid_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', payout.id)
    .eq('status', 'processing')
    .select('id')
  if (!paid?.length) return false
  await admin.from('order_events').insert({
    order_id: payout.order_id,
    actor_id: null,
    event: 'payout_paid',
    payload: {
      payout_id: payout.id,
      amount_paise: payout.amount_paise,
      razorpay_transfer_id: transfer.razorpayTransferId,
      simulated: Boolean(transfer.simulated),
      ...(recovered ? { recovered: true } : {}),
      ...(extra ?? {}),
    },
  })
  try { await notifyPayoutPaid(admin, payout.provider_id, Number(payout.amount_paise), payout.order_id) } catch (e) { console.error('[notifyPayoutPaid]', e) }
  return true
}

/**
 * Process due provider payouts via Razorpay Route (or simulation). Idempotent:
 * only 'scheduled' payouts are claimed (CAS to 'processing'), so a re-run never
 * double-pays. ADR 026: every claimed payout passes the ONE release rule
 * (payoutRunBlockers) before money moves; a payout sent before is looked up at
 * the gateway first; an ambiguous transfer error stays 'processing' (unconfirmed).
 * ADR 027 (audit M2): with the simulation gateway on the production deployment
 * nothing is claimed at all (`unavailable`), so no payout is ever recorded as
 * paid by a transfer that moved no money; the rows stay 'scheduled'.
 */
export async function runPayouts(
  admin: Admin,
  gateway: PaymentGateway,
  opts?: { allScheduled?: boolean; orderId?: string },
): Promise<{ processed: number; transferIds: string[]; simulated: boolean; held: number; unconfirmed: number; failed: number; unavailable?: true }> {
  if (!paymentsAvailable(gateway.isReal)) {
    console.error('[runPayouts] payments unavailable (simulation gateway on production) — no payout claimed')
    return { processed: 0, transferIds: [], simulated: false, held: 0, unconfirmed: 0, failed: 0, unavailable: true }
  }
  const today = new Date().toISOString().slice(0, 10)
  let query = admin.from('payouts').select('*').eq('status', 'scheduled')
  // Single-order settlement (dispute resolution / manual retry) reuses this same
  // proven transfer path — never a parallel money path.
  if (opts?.orderId) query = query.eq('order_id', opts.orderId)
  else if (!opts?.allScheduled) query = query.lte('scheduled_for', today)
  const { data: due } = await query

  const transferIds: string[] = []
  let simulated = false
  let held = 0
  let unconfirmed = 0
  let failed = 0
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

    // ADR 026 — the one release rule, re-read at the moment money would move.
    const { data: ord } = await admin.from('orders').select('*').eq('id', p.order_id).maybeSingle()
    const blockers = await payoutRunBlockers(admin, ord, { payoutPaise: Number(p.amount_paise), gatewayIsReal: gateway.isReal })
    if (blockers.length > 0) {
      await admin.from('payouts').update({ status: 'held', updated_at: new Date().toISOString() }).eq('id', p.id).eq('status', 'processing')
      await admin.from('order_events').insert({
        order_id: p.order_id,
        actor_id: null,
        event: 'payout_held',
        payload: { payout_id: p.id, amount_paise: p.amount_paise, reasons: blockers, at: 'release' },
      })
      held++
      continue
    }

    // A payout sent before is asked about first: the earlier attempt may have
    // created the transfer even though it reported an error.
    let transfer: GatewayTransfer | null = null
    let recovered = false
    if (await attemptedBefore(admin, p)) {
      try {
        transfer = await gateway.findTransfer({ payoutId: p.id, sinceUnixSeconds: lookbackUnix(p), excludeTransferIds: await deadTransferIds(admin, p) })
        recovered = Boolean(transfer)
      } catch (e) {
        await admin.from('order_events').insert({
          order_id: p.order_id,
          actor_id: null,
          event: 'payout_unconfirmed',
          payload: { payout_id: p.id, amount_paise: p.amount_paise, reason: `lookup_failed: ${describe(e)}` },
        })
        unconfirmed++
        continue
      }
    }

    if (!transfer) {
      const { data: bank } = await admin
        .from('provider_bank_accounts')
        .select('razorpay_route_account_id')
        .eq('provider_id', p.provider_id)
        .maybeSingle()
      try {
        // ADR-004 / F2 guard: the transfer is ALWAYS the provider's full amount;
        // if Razorpay's fee would not fit inside the captured amount and inside
        // our commission, refuse loudly (payout → failed with the numbers) —
        // never shrink the provider's transfer to make room.
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
          notes: { order_id: p.order_id, payout_id: p.id },
        })
      } catch (e) {
        if (isDefiniteTransferFailure(e)) {
          // Refused: nothing was sent. 'failed' surfaces in /admin/payouts for retry.
          console.error('[runPayouts] transfer refused for payout', p.id, e)
          reportOpsError(e, 'payout_failed', { tags: { payout_id: p.id, order_id: p.order_id }, extra: { reason: describe(e) } })
          failed++
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
              reason: describe(e),
              ...(e instanceof FeeHeadroomError ? { fee: e.detail } : {}),
            },
          })
        } else {
          // Unknown outcome: the transfer may exist. Stay 'processing'; the
          // reconcile cron settles it from the gateway (settleUnconfirmedPayouts).
          console.error('[runPayouts] transfer outcome unknown for payout', p.id, e)
          await admin.from('order_events').insert({
            order_id: p.order_id,
            actor_id: null,
            event: 'payout_unconfirmed',
            payload: { payout_id: p.id, amount_paise: p.amount_paise, reason: describe(e) },
          })
          unconfirmed++
        }
        continue
      }
    }
    if (transfer.simulated) simulated = true
    if (await markPaid(admin, p, transfer, recovered)) transferIds.push(transfer.razorpayTransferId)
  }
  return { processed: transferIds.length, transferIds, simulated, held, unconfirmed, failed }
}

/**
 * ADR 026 — settle payouts left 'processing' (an unconfirmed transfer, or a run
 * that died mid-flight) once they are older than `olderThanMinutes`: 'paid' when
 * the gateway holds a transfer for the payout, 'failed' (retryable) when it
 * holds none. A lookup that cannot answer leaves the payout for the next run.
 */
export async function settleUnconfirmedPayouts(
  admin: Admin,
  gateway: PaymentGateway,
  olderThanMinutes = 30,
): Promise<{ paid: number; failed: number; unknown: number; unavailable?: true }> {
  // ADR 027 (audit M2): the simulation mock cannot answer for a real transfer
  // (its ledger is process-local), so on production without keys nothing is settled.
  if (!paymentsAvailable(gateway.isReal)) return { paid: 0, failed: 0, unknown: 0, unavailable: true }
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString()
  const { data: stuck } = await admin.from('payouts').select('*').eq('status', 'processing').lt('updated_at', cutoff).limit(200)
  let paid = 0
  let failed = 0
  let unknown = 0
  for (const p of stuck ?? []) {
    let transfer: GatewayTransfer | null
    try {
      transfer = await gateway.findTransfer({ payoutId: p.id, sinceUnixSeconds: lookbackUnix(p), excludeTransferIds: await deadTransferIds(admin, p) })
    } catch (e) {
      console.error('[settleUnconfirmedPayouts] lookup failed', p.id, describe(e))
      unknown++
      continue
    }
    if (transfer) {
      if (await markPaid(admin, p, transfer, true)) paid++
      continue
    }
    const { data: moved } = await admin
      .from('payouts')
      .update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('id', p.id)
      .eq('status', 'processing')
      .select('id')
    if (moved?.length) {
      await admin.from('order_events').insert({
        order_id: p.order_id,
        actor_id: null,
        event: 'payout_failed',
        payload: { payout_id: p.id, amount_paise: p.amount_paise, reason: 'unconfirmed_no_transfer' },
      })
      reportOpsIssue('payout failed: unconfirmed transfer not at the gateway', 'payout_failed', { level: 'error', tags: { payout_id: p.id, order_id: p.order_id } })
      failed++
    }
  }
  return { paid, failed, unknown }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
