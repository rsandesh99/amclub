'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { isValidGstin, type OrderAmounts } from '@amclub/shared'
import { formatINR } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CHECKOUT_ERROR_KEYS, checkoutErrorKey, newIdempotencyKey, payCheckout, startCheckout } from '@/lib/payments/razorpay-client'
import { readSearchAttribution } from '@/components/search-v3/SearchAttributionCapture'

export function CheckoutClient({
  packageId,
  title,
  providerName,
  deliveryDays,
  amounts,
  couponsEnabled = false,
  profileGstin = null,
  providerPaused = false,
}: {
  packageId: string
  title: string
  providerName: string
  deliveryDays: number
  amounts: OrderAmounts
  /** Coupons feature flag (default OFF). When false the input is hidden and the
   *  total never includes a coupon discount. */
  couponsEnabled?: boolean
  /** The buyer's MSME profile GSTIN (prefill; the buyer may bill another). */
  profileGstin?: string | null
  /** provider_profiles.capacity_paused — the server refuses too (provider_paused). */
  providerPaused?: boolean
}) {
  const t = useTranslations('checkout')
  const tc = useTranslations('coupons')
  const router = useRouter()
  const [coupon, setCoupon] = useState('')
  const [applied, setApplied] = useState<{ code: string; discountPaise: number } | null>(null)
  const [couponMsg, setCouponMsg] = useState('')
  const [couponBusy, setCouponBusy] = useState(false)
  // Only a checksum-valid profile GSTIN is prefilled (a stale one would be refused).
  const prefillGstin = profileGstin && isValidGstin(profileGstin.trim().toUpperCase()) ? profileGstin.trim().toUpperCase() : ''
  const [gstOpen, setGstOpen] = useState(!!prefillGstin)
  const [gstin, setGstin] = useState(prefillGstin)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // One idempotency key per checkout INTENT for this page load: a retry or a
  // double tap resumes the same session (P0-5); changing what is being paid
  // for (coupon / GSTIN) starts a new intent, so a frozen session never
  // carries stale inputs.
  const intent = useRef<{ sig: string; key: string } | null>(null)
  function keyFor(sig: string): string {
    if (!intent.current || intent.current.sig !== sig) intent.current = { sig, key: newIdempotencyKey() }
    return intent.current.key
  }

  // Live total preview when a coupon is applied. The coupon reduces the pre-GST
  // base; the server re-evaluates + freezes the authoritative amount at checkout.
  const gstRate = amounts.taxablePaise > 0 ? amounts.gstPaise / amounts.taxablePaise : 0
  const couponDiscount = applied?.discountPaise ?? 0
  const dispTaxable = amounts.taxablePaise - couponDiscount
  const dispGst = Math.round(dispTaxable * gstRate)
  const dispTotal = dispTaxable + dispGst

  async function applyCoupon() {
    const code = coupon.trim()
    if (!code) return
    setCouponBusy(true); setCouponMsg('')
    try {
      const res = await fetch('/api/v1/coupons/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, packageId }),
      })
      const d = await res.json()
      if (d.ok && d.discountPaise > 0) {
        setApplied({ code: d.code ?? code.toUpperCase(), discountPaise: d.discountPaise })
        setCouponMsg('')
      } else {
        setApplied(null)
        setCouponMsg(tc(d.error ?? 'coupon_not_found'))
      }
    } catch {
      setCouponMsg(tc('coupon_not_found'))
    } finally { setCouponBusy(false) }
  }

  async function pay() {
    setLoading(true)
    setError('')
    const couponCode = coupon.trim()
    const gst = gstin.trim().toUpperCase()
    const attribution = readSearchAttribution(packageId)
    try {
      const data = await startCheckout('/api/v1/checkout', {
        packageId,
        idempotencyKey: keyFor(`${couponCode}|${gst}`),
        ...(couponCode ? { couponCode } : {}),
        ...(gst ? { gstInvoice: { gstin: gst } } : {}),
        // E15 F5 — the search that led here (never part of the charge).
        ...(attribution ? { attribution } : {}),
      })
      // Simulation completes the captured-payment path server-side; real keys
      // open the Razorpay sheet and the WEBHOOK creates the order.
      await payCheckout(data, {
        description: title,
        onPaid: (o) => router.push(o.kind === 'order' ? `/app/orders/${o.orderId}?first=1` : '/app/orders?processing=1'),
        // Buyer closed the sheet without paying — say so instead of leaving
        // them staring at an unchanged page (B1). Nothing was charged.
        onDismiss: () => setError(t('payment_cancelled')),
      })
    } catch (e: unknown) {
      setError(t(checkoutErrorKey(e, CHECKOUT_ERROR_KEYS, 'failed') as 'failed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="rounded-card border border-border bg-surface p-5 shadow-card">
        <h2 className="font-medium">{title}</h2>
        <p className="text-sm text-foreground-secondary">{providerName} · {t('delivery_days', { days: deliveryDays })}</p>
        <dl className="mt-4 space-y-2 border-t border-border pt-4 text-sm">
          <Row label={t('price')} value={formatINR(amounts.pricePaise)} />
          {amounts.discountPaise > 0 && <Row label={t('discount')} value={'− ' + formatINR(amounts.discountPaise)} />}
          {couponDiscount > 0 && <Row label={`${tc('applied')} (${applied!.code})`} value={'− ' + formatINR(couponDiscount)} />}
          <Row label={t('taxable')} value={formatINR(dispTaxable)} />
          <Row label={t('gst')} value={formatINR(dispGst)} />
          <div className="flex items-center justify-between border-t border-border pt-2 text-base font-bold">
            <dt>{t('total')}</dt>
            <dd className="font-display text-primary">{formatINR(dispTotal)}</dd>
          </div>
        </dl>
      </div>

      {/* Coupons are flag-gated (default OFF) — hidden until re-enabled. */}
      {couponsEnabled && (
        <div className="space-y-1.5">
          <Label htmlFor="coupon">{t('coupon_label')}</Label>
          <div className="flex gap-2">
            <Input
              id="coupon"
              autoComplete="off"
              value={coupon}
              onChange={(e) => { setCoupon(e.target.value.toUpperCase()); setApplied(null); setCouponMsg('') }}
              placeholder={t('coupon')}
            />
            <Button variant="secondary" onClick={applyCoupon} loading={couponBusy} disabled={!coupon.trim()}>{tc('apply')}</Button>
          </div>
          {applied && <p className="text-sm text-success">{tc('applied_msg', { amount: formatINR(applied.discountPaise) })}</p>}
          {couponMsg && <p className="text-sm text-danger">{couponMsg}</p>}
        </div>
      )}

      <div className="rounded-card border border-border bg-surface p-4">
        <button type="button" onClick={() => setGstOpen((v) => !v)} className="flex w-full items-center justify-between text-sm font-medium">
          {t('gst_invoice')} <span className="text-foreground-secondary">{gstOpen ? '−' : '+'}</span>
        </button>
        {gstOpen && (
          <div className="mt-3 space-y-1.5">
            <Label htmlFor="gstin">{t('gstin')}</Label>
            <Input
              id="gstin"
              value={gstin}
              onChange={(e) => setGstin(e.target.value.toUpperCase().replace(/\s/g, '').slice(0, 15))}
              maxLength={15}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              placeholder="27AAPFU0939F1ZV"
            />
            {prefillGstin && gstin === prefillGstin && (
              <p className="text-xs text-foreground-secondary">{t('gstin_prefilled')}</p>
            )}
            {/* Checksum hint only — the server stays the authority (§7 audit M8).
                Shown once 15 chars are typed so we never nag mid-entry. */}
            {gstin.trim().length >= 15 && !isValidGstin(gstin.trim()) && (
              <p className="text-xs font-medium text-warning" role="status">{t('gstin_check_hint')}</p>
            )}
          </div>
        )}
      </div>

      {providerPaused && <p className="text-sm font-medium text-warning" role="status">{t('err_provider_paused')}</p>}
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}

      <Button onClick={pay} loading={loading} disabled={providerPaused} className="w-full" size="lg">
        {t('pay', { amount: formatINR(dispTotal) })}
      </Button>
      <p className="text-center text-xs text-foreground-secondary">{t('secure_note')}</p>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-foreground-secondary">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}
