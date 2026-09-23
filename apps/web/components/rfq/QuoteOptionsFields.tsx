'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { QuoteOptionLabel, QuotePreview } from '@amclub/shared'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatINR } from '@/lib/format'
import { useAnalytics } from '@/components/providers/posthog'

export interface OptionDraft {
  price: string
  days: string
}
export type OptionDrafts = Record<QuoteOptionLabel, OptionDraft>
export const EMPTY_OPTION_DRAFTS: OptionDrafts = { express: { price: '', days: '' }, economy: { price: '', days: '' } }

/**
 * E12b / ADR 020 — "Offer faster or cheaper options" (off by default). The
 * quote's own price and days are Standard; Express must be faster and never
 * cheaper, Economy slower and never dearer (the server re-checks, 400
 * otherwise). Each filled row shows the buyer's all-in figure from the SAME
 * server preview the Standard price uses — nothing is computed here.
 */
export function QuoteOptionsFields({ rfqId, gst, on, onToggle, drafts, onChange }: {
  rfqId: string
  gst: '' | 'yes' | 'no'
  on: boolean
  onToggle: (on: boolean) => void
  drafts: OptionDrafts
  onChange: (label: QuoteOptionLabel, next: OptionDraft) => void
}) {
  const t3 = useTranslations('quote_v3')
  const analytics = useAnalytics()
  return (
    <div className="space-y-3 rounded-card border border-border p-3" data-testid="quote-options">
      <label className="flex items-start gap-2.5 text-sm">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        <span>
          <span className="block font-medium">{t3('options_toggle')}</span>
          <span className="block text-xs text-foreground-secondary">{t3('options_hint')}</span>
        </span>
      </label>
      {on && (['express', 'economy'] as const).map((label) => (
        <div key={label} className="grid grid-cols-2 gap-2" data-option={label}>
          <p className="col-span-2 text-sm font-semibold">{t3(`option_${label}`)} <span className="font-normal text-foreground-secondary">· {t3(`option_${label}_rule`)}</span></p>
          <div className="space-y-1">
            <Label htmlFor={`q-opt-${label}-price`}>{t3('option_price')}</Label>
            <Input
              id={`q-opt-${label}-price`}
              inputMode="numeric"
              value={drafts[label].price}
              onChange={(e) => onChange(label, { ...drafts[label], price: e.target.value.replace(/[^0-9]/g, '') })}
              onBlur={() => drafts[label].price && analytics.capture('quote_option_added', { device: 'web', label })}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`q-opt-${label}-days`}>{t3('option_days')}</Label>
            <Input id={`q-opt-${label}-days`} inputMode="numeric" value={drafts[label].days} onChange={(e) => onChange(label, { ...drafts[label], days: e.target.value.replace(/[^0-9]/g, '') })} />
          </div>
          <OptionPreview rfqId={rfqId} gst={gst} rupees={drafts[label].price} />
        </div>
      ))}
    </div>
  )
}

function OptionPreview({ rfqId, gst, rupees }: { rfqId: string; gst: '' | 'yes' | 'no'; rupees: string }) {
  const t3 = useTranslations('quote_v3')
  const [preview, setPreview] = useState<QuotePreview | null>(null)
  useEffect(() => {
    const n = Number(rupees)
    if (!(n > 0) || !gst) { setPreview(null); return }
    let live = true
    const timer = setTimeout(async () => {
      const res = await fetch(`/api/v1/rfq/${rfqId}/quote/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Unit conversion of the typed rupees only; the figure shown is the server's.
        body: JSON.stringify({ price_paise: Math.round(n * 100), gst_included: gst === 'yes' }),
      }).catch(() => null)
      const d = res?.ok ? ((await res.json().catch(() => null)) as QuotePreview | null) : null
      if (live) setPreview(d)
    }, 350)
    return () => { live = false; clearTimeout(timer) }
  }, [rfqId, gst, rupees])
  if (!preview) return null
  return <p className="col-span-2 text-xs tabular-nums text-foreground-secondary">{t3('option_buyer_sees', { total: formatINR(preview.totalPaise) })}</p>
}
