'use client'

import { useTranslations } from 'next-intl'
import { ShieldCheck } from 'lucide-react'
import type { ProviderMoneyLine } from '@amclub/shared'
import { formatINRExact } from '@/lib/format'

function istDate(iso: string): string {
  return new Date(iso.length === 10 ? `${iso}T00:00:00+05:30` : iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' })
}

/**
 * PRD Experience v3 E8 FR-8.5 (N37) — the provider's money line from the
 * shared `providerMoneyLine` (server paise, the payout row's own date and
 * hold reasons). Never computes an amount.
 */
export function ProviderMoneyLineView({ line }: { line: ProviderMoneyLine | null }) {
  const t = useTranslations('orders_v3')
  const te = useTranslations('earnings')
  if (!line) return null
  const reason = (r: string) => (te.has(`hold_reason_${r}` as 'hold_reason_unknown') ? te(`hold_reason_${r}` as 'hold_reason_unknown') : te('hold_reason_unknown'))
  let text: string
  switch (line.kind) {
    case 'secured': text = t('money_secured', { amount: formatINRExact(line.amountPaise) }); break
    case 'scheduled': text = line.date ? t('money_scheduled', { date: istDate(line.date) }) : t('money_scheduled_soon'); break
    case 'processing': text = t('money_processing'); break
    case 'paid': text = line.date ? t('money_paid', { date: istDate(line.date) }) : t('money_paid_nodate'); break
    case 'held': text = t('money_held', { reasons: (line.reasons.length ? line.reasons : ['unknown']).map(reason).join(' · ') }); break
    case 'failed': text = t('money_failed'); break
  }
  const tone = line.kind === 'held' || line.kind === 'failed' ? 'text-warning' : 'text-success'
  return (
    <p className={`flex items-start gap-1.5 text-sm font-medium ${tone}`} data-testid="provider-money-line" data-kind={line.kind}>
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{text}</span>
    </p>
  )
}

/** The buyer's side: what they paid and where it sits (server paise; refunds keep their own card). */
export function BuyerMoneyLine({ totalPaise, active }: { totalPaise: number; active: boolean }) {
  const t = useTranslations('orders_v3')
  return (
    <p className="flex items-start gap-1.5 text-sm" data-testid="buyer-money-line">
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-trust" aria-hidden />
      <span>{active ? t('buyer_paid_held', { amount: formatINRExact(totalPaise) }) : t('buyer_paid', { amount: formatINRExact(totalPaise) })}</span>
    </p>
  )
}
