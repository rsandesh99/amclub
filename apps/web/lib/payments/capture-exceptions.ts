import 'server-only'
import {
  CAPTURE_EXCEPTION_STATUS,
  REFUND_STATUS,
  isValidCaptureExceptionTransition,
  type CaptureExceptionReason,
  type CaptureExceptionStatus,
} from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { writeAudit } from '@/lib/audit/log'
import { createNotification } from '@/lib/notifications/create'
import { notifyText } from '@/lib/i18n/notify'
import { formatINRExact } from '@/lib/format'
import type { PaymentGateway } from './types'
import { moneyMovementBlock, paymentsAvailable } from './simulation'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * ADR 027 (audit M21 / M39) — a captured payment that created NO order.
 *
 * capture_payment() (migration 0078) records it instead of materialising an
 * order when the checkout session had expired (expires_at + the grace period)
 * or had already been paid by another payment. It is then refunded IN FULL,
 * automatically: the platform holds money it has no order for, so returning it
 * is always right, and waiting on an ops queue would leave a buyer charged for
 * nothing. The refund is the gateway's ordinary refund call, made safe the same
 * way processRefund is: the row is claimed first (compare-and-set, one refunder),
 * the gateway is asked for a refund carrying our receipt (`refund_key`) before a
 * new one is created, and a refund the gateway reports failed is never taken as
 * done. Webhooks (refund.processed / refund.failed) settle the row by refund id
 * or receipt. Simulated captures are refunded only by the simulation gateway.
 */

export interface CaptureExceptionRow {
  id: string
  razorpay_payment_id: string
  razorpay_order_id: string
  checkout_session_id: string | null
  order_id: string | null
  msme_id: string | null
  amount_paise: number
  reason: CaptureExceptionReason
  status: CaptureExceptionStatus
  refund_key: string
  razorpay_refund_id: string | null
  attempts: number
  simulated: boolean
  updated_at: string
}

/** A claim older than this belongs to a run that died; it may be taken over. */
const STALE_CLAIM_MS = 10 * 60 * 1000
/** Automatic attempts before the row is left to ops (the audit log names it). */
export const CAPTURE_REFUND_MAX_ATTEMPTS = 5

/** What capture_payment() returns (jsonb). */
export interface CaptureOutcome {
  outcome: 'materialized' | 'existing' | 'unknown_session' | CaptureExceptionReason
  order_id?: string | null
  exception_id?: string
  created?: boolean
}

export function isCaptureException(o: CaptureOutcome): o is CaptureOutcome & { outcome: CaptureExceptionReason; exception_id: string } {
  return (o.outcome === 'session_expired' || o.outcome === 'duplicate_capture') && typeof o.exception_id === 'string'
}

/** Once, when capture_payment() first records the exception: an ops-visible audit row and the buyer's notice. */
export async function announceCaptureException(admin: Admin, exceptionId: string): Promise<void> {
  const { data } = await admin.from('capture_exceptions').select('*').eq('id', exceptionId).maybeSingle()
  const row = data as CaptureExceptionRow | null
  if (!row) return
  const detail = {
    reason: row.reason,
    razorpay_payment_id: row.razorpay_payment_id,
    razorpay_order_id: row.razorpay_order_id,
    checkout_session_id: row.checkout_session_id,
    order_id: row.order_id,
    amount_paise: Number(row.amount_paise),
  }
  console.error('[capture] payment with no order — refunding in full', detail)
  await writeAudit(admin, null, { actorId: null, action: `capture_exception_${row.reason}`, entity: 'capture_exceptions', entityId: row.id, after: detail })
  if (!row.msme_id) return
  const { data: msme } = await admin.from('msme_profiles').select('user_id').eq('id', row.msme_id).maybeSingle()
  const userId = (msme as { user_id?: string } | null)?.user_id
  if (!userId) return
  const amount = formatINRExact(Number(row.amount_paise))
  let ref = ''
  if (row.order_id) {
    const { data: ord } = await admin.from('orders').select('order_number').eq('id', row.order_id).maybeSingle()
    ref = String((ord as { order_number?: string } | null)?.order_number ?? '')
  }
  await createNotification(admin, {
    userId,
    kind: 'payment_refunded_no_order',
    titleI18n: notifyText('capture_refund.title'),
    bodyI18n: row.reason === 'duplicate_capture' ? notifyText('capture_refund.body_duplicate', { amount, ref }) : notifyText('capture_refund.body_expired', { amount }),
    link: row.order_id ? `/app/orders/${row.order_id}` : '/app/orders',
    values: { amount, ref },
  })
}

/**
 * Refund one capture exception in full. Idempotent and safe to call from the
 * webhook, the sweeper and a replay at once: only the caller that wins the
 * claim talks to the gateway, and the gateway is asked for our receipt first.
 */
export async function refundCaptureException(
  admin: Admin,
  gateway: PaymentGateway,
  exceptionId: string,
): Promise<{ ok: boolean; status: string; error?: string }> {
  const { data } = await admin.from('capture_exceptions').select('*').eq('id', exceptionId).maybeSingle()
  const row = data as CaptureExceptionRow | null
  if (!row) return { ok: false, status: 'missing', error: 'not_found' }
  if (row.status === CAPTURE_EXCEPTION_STATUS.refunded) return { ok: true, status: row.status }

  // ADR 027 (M2): never through the simulation gateway on production, never a real refund of a simulated capture.
  const blocked = moneyMovementBlock(gateway.isReal, { razorpay_payment_id: row.razorpay_payment_id, simulated: row.simulated })
  if (blocked) return { ok: false, status: row.status, error: blocked }
  if (row.status === CAPTURE_EXCEPTION_STATUS.refunding && Date.now() - new Date(row.updated_at).getTime() < STALE_CLAIM_MS) {
    return { ok: false, status: row.status, error: 'in_progress' }
  }
  if (!isValidCaptureExceptionTransition(row.status, CAPTURE_EXCEPTION_STATUS.refunding)) return { ok: false, status: row.status, error: 'not_refundable' }

  // Claim: compare-and-set on the version read — exactly one refunder proceeds.
  const { data: claimed } = await admin
    .from('capture_exceptions')
    .update({ status: CAPTURE_EXCEPTION_STATUS.refunding, attempts: Number(row.attempts) + 1, updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('status', row.status)
    .eq('updated_at', row.updated_at)
    .select('id')
  if (!claimed?.length) return { ok: false, status: row.status, error: 'in_progress' }

  try {
    const prior = (await gateway.listRefunds(row.razorpay_payment_id)).find((r) => r.receipt === row.refund_key && r.status !== REFUND_STATUS.failed)
    const r =
      prior ??
      (await gateway.createRefund({
        razorpayPaymentId: row.razorpay_payment_id,
        amountPaise: Number(row.amount_paise),
        receipt: row.refund_key,
        notes: { capture_exception_id: row.id, reason: row.reason },
      }))
    if (r.status === REFUND_STATUS.failed) throw new Error('refund_failed_at_gateway')
    const nowIso = new Date().toISOString()
    await admin
      .from('capture_exceptions')
      .update({ status: CAPTURE_EXCEPTION_STATUS.refunded, razorpay_refund_id: r.razorpayRefundId, refunded_at: nowIso, last_error: null, updated_at: nowIso })
      .eq('id', row.id)
      .eq('status', CAPTURE_EXCEPTION_STATUS.refunding)
    return { ok: true, status: CAPTURE_EXCEPTION_STATUS.refunded }
  } catch (e) {
    // Unknown or refused: the next attempt asks the gateway for our receipt first, so an
    // ambiguous failure (a refund that did go through) is found, never repeated.
    const reason = e instanceof Error ? e.message.slice(0, 200) : 'refund_error'
    await admin
      .from('capture_exceptions')
      .update({ status: CAPTURE_EXCEPTION_STATUS.refund_failed, last_error: reason, updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', CAPTURE_EXCEPTION_STATUS.refunding)
    await writeAudit(admin, null, { actorId: null, action: 'capture_exception_refund_failed', entity: 'capture_exceptions', entityId: row.id, after: { reason, attempt: Number(row.attempts) + 1 } })
    return { ok: false, status: CAPTURE_EXCEPTION_STATUS.refund_failed, error: reason }
  }
}

/**
 * Sweeper (auto-cancel cron, hourly): refund every capture exception still owed
 * a refund and idle for 10 minutes (so it never races the webhook's own attempt),
 * up to CAPTURE_REFUND_MAX_ATTEMPTS each. Past that the audit log carries it for ops.
 */
export async function sweepCaptureExceptions(admin: Admin, gateway: PaymentGateway): Promise<{ checked: number; refunded: number; failed: number; unavailable?: true }> {
  if (!paymentsAvailable(gateway.isReal)) return { checked: 0, refunded: 0, failed: 0, unavailable: true }
  const idle = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
  const { data: rows } = await admin
    .from('capture_exceptions')
    .select('id')
    .in('status', [CAPTURE_EXCEPTION_STATUS.refund_pending, CAPTURE_EXCEPTION_STATUS.refund_failed, CAPTURE_EXCEPTION_STATUS.refunding])
    .lt('updated_at', idle)
    .lt('attempts', CAPTURE_REFUND_MAX_ATTEMPTS)
    .order('updated_at', { ascending: true })
    .limit(100)
  let refunded = 0
  let failed = 0
  for (const r of rows ?? []) {
    const out = await refundCaptureException(admin, gateway, r.id as string)
    if (out.ok) refunded++
    else if (out.status === CAPTURE_EXCEPTION_STATUS.refund_failed) failed++
  }
  return { checked: (rows ?? []).length, refunded, failed }
}
