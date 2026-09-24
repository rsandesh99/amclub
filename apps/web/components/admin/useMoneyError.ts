'use client'

import { useTranslations } from 'next-intl'
import { formatINR } from '@/lib/format'

// ADR-014 — money-path refusals from the dispute resolve route and the admin
// order actions carry a stable code plus the paise amounts behind it.
const MONEY_ERROR_CODES = [
  'provider_already_paid',
  'payout_in_flight',
  'refund_exists',
  'refund_mismatch',
  'no_payment',
  'resolution_in_progress',
  'resolution_conflict',
  'refund_over_total',
  // ADR 026 — the payout release rule, order compare-and-set and durable refunds.
  'payout_held_use_release',
  'payout_not_failed',
  'payout_changed',
  'order_not_releasable',
  'order_changed',
  'refund_failed',
  'not_refund_owed',
] as const
type MoneyErrorCode = (typeof MONEY_ERROR_CODES)[number]

/** Returns a translator for an error response body: the admin_ops message for a
 *  known money code, or null so the caller falls back to its existing handling. */
export function useMoneyError() {
  const t = useTranslations('admin_ops')
  return (body: unknown): string | null => {
    const b = (body ?? {}) as Record<string, unknown>
    const code = b['error']
    if (typeof code !== 'string' || !(MONEY_ERROR_CODES as readonly string[]).includes(code)) return null
    const inr = (p: unknown) => formatINR(Number(p ?? 0))
    const started = b['startedResolution']
    const resolution = started === 'refund_full' || started === 'refund_partial' || started === 'release' ? t(started) : ''
    return t(`money_err_${code as MoneyErrorCode}`, {
      existing: inr(b['existingPaise']),
      settlement: inr(b['settlementPaise']),
      refund: inr(b['refundPaise']),
      total: inr(b['totalPaise']),
      resolution,
    })
  }
}
