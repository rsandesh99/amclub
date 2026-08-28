'use client'

import { useTranslations } from 'next-intl'
import type { PayoutReadiness } from '@/lib/payments/readiness'

const TONE: Record<PayoutReadiness, string> = {
  ready: 'bg-success-soft text-success',
  missing_route: 'bg-warning-soft text-warning',
  bank_unverified: 'bg-warning-soft text-warning',
  not_ready: 'bg-danger-soft text-danger',
  no_bank: 'bg-danger-soft text-danger',
}

/** Payout-readiness chip (Phase 3a) — same labels on the list, detail and payouts views. */
export function ReadinessBadge({ readiness, className = '' }: { readiness: PayoutReadiness; className?: string }) {
  const t = useTranslations('admin_ops')
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE[readiness] ?? 'bg-muted text-foreground-secondary'} ${className}`}>
      {t(`readiness_${readiness}` as 'readiness_ready')}
    </span>
  )
}
