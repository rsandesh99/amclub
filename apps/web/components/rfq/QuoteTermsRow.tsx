'use client'

import { useLocale, useTranslations } from 'next-intl'
import type { QuoteTerms } from '@/lib/rfq/queries'

/**
 * Phase 4c — the four optional commercial terms on a quote. A NULL term is
 * rendered as a neutral "not stated — ask before deciding" hint, never a
 * blank: that hint is the comparability nudge (and the precursor to future
 * AI flags). No computed comparisons, no price math here.
 */
export function QuoteTermsRow({ terms, compact = false }: { terms: QuoteTerms; compact?: boolean }) {
  const t = useTranslations('rfq')
  const locale = useLocale()
  const yesNo = (v: boolean) => (v ? t('term_yes') : t('term_no'))
  const date = (iso: string) =>
    new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`))

  const items: { key: string; label: string; value: string | null }[] = [
    { key: 'gst', label: t('term_gst'), value: terms.gstIncluded == null ? null : yesNo(terms.gstIncluded) },
    { key: 'transport', label: t('term_transport'), value: terms.transportIncluded == null ? null : yesNo(terms.transportIncluded) },
    { key: 'valid', label: t('term_valid_until'), value: terms.validUntil ? date(terms.validUntil) : null },
    { key: 'advance', label: t('term_advance'), value: terms.advancePercent == null ? null : t('term_advance_value', { pct: terms.advancePercent }) },
  ]

  return (
    <dl className={`grid gap-x-4 gap-y-1 ${compact ? 'grid-cols-2 text-xs' : 'grid-cols-2 text-sm sm:grid-cols-4'}`}>
      {items.map((i) => (
        <div key={i.key} className="min-w-0">
          <dt className="text-[11px] uppercase tracking-wide text-foreground-secondary">{i.label}</dt>
          <dd className={i.value == null ? 'italic text-foreground-secondary' : 'font-medium text-foreground'} title={i.value == null ? t('term_not_stated_hint') : undefined}>
            {i.value ?? t('term_not_stated')}
          </dd>
        </div>
      ))}
    </dl>
  )
}
