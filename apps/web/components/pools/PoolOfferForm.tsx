'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { POOL_MAX_TIERS } from '@amclub/shared'
import { Link, useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SegmentedControl } from '@/components/ui-v3/SegmentedControl'
import { formatINRExact } from '@/lib/format'
import type { PoolProviderView } from '@/lib/pools/types'

interface TierDraft { min: string; rupees: string }

/**
 * S3.4 (ADR 024) — the provider's ONE group offer: 1–3 volume tiers (one business on its own, then higher counts at
 * lower prices), days, scope, GST and validity. The server re-checks every rule (shared poolTierProblems) and renders
 * the buyer's all-in figures; this form only collects what the provider states. Sealed: no other offer is shown.
 */
export function PoolOfferForm({ view, labels }: {
  view: PoolProviderView
  labels: { service: string; state: string; closesAt: string | null; minValidUntil: string }
}) {
  const t = useTranslations('pools')
  const router = useRouter()
  const [tiers, setTiers] = useState<TierDraft[]>([{ min: '1', rupees: '' }])
  const [days, setDays] = useState('')
  const [scope, setScope] = useState('')
  const [gst, setGst] = useState<'extra' | 'included' | null>(null)
  const [validUntil, setValidUntil] = useState(labels.minValidUntil)
  const [advance, setAdvance] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const open = view.status === 'open'

  const setTier = (i: number, patch: Partial<TierDraft>) => setTiers((ts) => ts.map((x, j) => (j === i ? { ...x, ...patch } : x)))

  async function submit() {
    setError('')
    const parsed = tiers.map((x) => ({ min_members: Number(x.min), price_paise: Math.round(Number(x.rupees) * 100) }))
    if (!gst || !days || scope.trim().length < 20 || !validUntil || parsed.some((x) => !Number.isInteger(x.min_members) || !(x.price_paise > 0))) {
      setError(t('err_fields'))
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/v1/pools/${view.id}/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tiers: parsed,
          delivery_days: Number(days),
          scope: scope.trim(),
          ...(message.trim() ? { message: message.trim() } : {}),
          gst_included: gst === 'included',
          valid_until: validUntil,
          ...(advance ? { advance_percent: Number(advance) } : {}),
        }),
      })
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: unknown }
        setError(d.error === 'tiers_incoherent' ? t('err_tiers') : d.error === 'validity_too_short' ? t('err_validity') : d.error === 'offer_exists' ? t('err_exists') : d.error === 'not_eligible' ? t('err_not_eligible') : typeof d.error === 'object' ? t('err_fields') : t('err'))
        return
      }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function withdraw() {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/v1/pools/${view.id}/offer`, { method: 'DELETE' })
      if (!res.ok) { setError(t('err')); return }
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5" data-testid="pool-provider" data-pool-status={view.status}>
      <header>
        <h1 className="font-display text-2xl font-bold">{t('page_title', { service: labels.service })}</h1>
        <p className="mt-1 text-sm text-foreground-secondary">{t('page_subtitle', { n: view.joinedCount, state: labels.state })} · {t(`status_${view.status}`)}</p>
        {open && labels.closesAt && <p className="mt-1 text-sm">{t('closes_at', { when: labels.closesAt })}</p>}
        <p className="mt-2 text-sm">{t('offer_intro', { n: view.joinedCount, m: view.matchedRfqIds.length })}</p>
        <div className="mt-1 flex flex-wrap gap-3">
          {view.matchedRfqIds.map((id, i) => (
            <Link key={id} href={`/partner/rfqs/${id}`} className="text-sm font-medium text-primary underline-offset-2 hover:underline">{t('request_link', { i: i + 1 })}</Link>
          ))}
        </div>
      </header>

      {view.mine ? (
        <section className="rounded-card border border-border bg-surface p-5" data-testid="pool-my-offer" data-offer-status={view.mine.status}>
          <h2 className="font-display text-lg font-semibold">{t('offer_title')}</h2>
          {view.mine.status === 'withdrawn' ? (
            <p className="mt-1 text-sm text-foreground-secondary">{t('withdrawn')}</p>
          ) : view.mine.achievedCount !== null ? (
            <p className="mt-1 text-sm" data-testid="pool-result">{t('result', { n: view.mine.achievedCount, price: view.mine.achievedPricePaise ? formatINRExact(view.mine.achievedPricePaise) : '' })}</p>
          ) : (
            <p className="mt-1 text-sm">{t('sent')}</p>
          )}
          <p className="mt-3 text-sm font-medium">{t('your_tiers')}</p>
          <ul className="mt-1 space-y-1">
            {view.mine.tiers.map((tier) => (
              <li key={tier.minMembers} className="flex justify-between gap-2 text-sm">
                <span className="text-foreground-secondary">{tier.minMembers === 1 ? t('tier_one') : t('tier_many', { n: tier.minMembers })}</span>
                <span className="tabular-nums">{view.mine!.gstIncluded ? t('tier_included', { total: formatINRExact(tier.totalPaise) }) : t('tier_extra', { price: formatINRExact(tier.pricePaise), gst: formatINRExact(tier.gstPaise), total: formatINRExact(tier.totalPaise) })}</span>
              </li>
            ))}
          </ul>
          {open && view.mine.status === 'active' && (
            <Button className="mt-4" size="sm" variant="ghost" onClick={withdraw} loading={busy}>{t('withdraw')}</Button>
          )}
        </section>
      ) : open ? (
        <section className="space-y-4 rounded-card border border-border bg-surface p-5" aria-labelledby="pool-offer-form-title">
          <h2 id="pool-offer-form-title" className="font-display text-lg font-semibold">{t('offer_title')}</h2>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{t('tiers_label')}</legend>
            {tiers.map((tier, i) => (
              <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`pool-tier-min-${i}`}>{i === 0 ? t('tier_min_one') : t('tier_min_label')}</Label>
                  <Input id={`pool-tier-min-${i}`} type="number" inputMode="numeric" min={i === 0 ? 1 : 2} max={view.maxMembers} value={tier.min} disabled={i === 0} onChange={(e) => setTier(i, { min: e.target.value })} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`pool-tier-price-${i}`}>{t('tier_price_label')}</Label>
                  <Input id={`pool-tier-price-${i}`} type="number" inputMode="numeric" min={1} value={tier.rupees} onChange={(e) => setTier(i, { rupees: e.target.value })} />
                </div>
                {i > 0 && <Button size="sm" variant="ghost" onClick={() => setTiers((ts) => ts.filter((_, j) => j !== i))}>{t('remove_tier')}</Button>}
              </div>
            ))}
            {tiers.length < POOL_MAX_TIERS && (
              <Button size="sm" variant="outline" onClick={() => setTiers((ts) => [...ts, { min: '', rupees: '' }])}>{t('add_tier')}</Button>
            )}
          </fieldset>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pool-days">{t('days_label')}</Label>
              <Input id="pool-days" type="number" inputMode="numeric" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pool-valid">{t('valid_label')}</Label>
              <Input id="pool-valid" type="date" min={labels.minValidUntil} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pool-scope">{t('scope_label')}</Label>
            <Textarea id="pool-scope" rows={4} value={scope} placeholder={t('scope_placeholder')} onChange={(e) => setScope(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium" id="pool-gst-label">{t('gst_label')}</span>
            <SegmentedControl<'extra' | 'included'> size="sm" ariaLabelledBy="pool-gst-label" value={gst} onChange={(v) => setGst(v)} options={[{ value: 'extra', label: t('gst_extra') }, { value: 'included', label: t('gst_included') }]} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pool-advance">{t('advance_label')}</Label>
              <Input id="pool-advance" type="number" inputMode="numeric" min={0} max={100} value={advance} onChange={(e) => setAdvance(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pool-message">{t('message_label')}</Label>
            <Textarea id="pool-message" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} />
          </div>
          <p className="rounded-button bg-sunken px-3 py-2 text-xs text-foreground-secondary">{t('authorise')}</p>
          <Button onClick={submit} loading={busy} data-testid="pool-offer-submit">{t('submit')}</Button>
        </section>
      ) : (
        <p className="text-sm text-foreground-secondary">{t('ended_note')}</p>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  )
}
