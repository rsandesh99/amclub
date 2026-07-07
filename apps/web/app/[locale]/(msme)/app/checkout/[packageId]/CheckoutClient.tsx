'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import type { OrderAmounts } from '@amclub/shared'
import { formatINR } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void }
  }
}

export function CheckoutClient({
  packageId,
  title,
  providerName,
  deliveryDays,
  amounts,
  couponsEnabled = false,
}: {
  packageId: string
  title: string
  providerName: string
  deliveryDays: number
  amounts: OrderAmounts
  /** Coupons feature flag (default OFF). When false the input is hidden and the
   *  total never includes a coupon discount. */
  couponsEnabled?: boolean
}) {
  const t = useTranslations('checkout')
  const tc = useTranslations('coupons')
  const router = useRouter()
  const [coupon, setCoupon] = useState('')
  const [applied, setApplied] = useState<{ code: string; discountPaise: number } | null>(null)
  const [couponMsg, setCouponMsg] = useState('')
  const [couponBusy, setCouponBusy] = useState(false)
  const [gstOpen, setGstOpen] = useState(false)
  const [gstin, setGstin] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

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
    try {
      const res = await fetch('/api/v1/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId,
          idempotencyKey: crypto.randomUUID(),
          ...(coupon.trim() ? { couponCode: coupon.trim() } : {}),
          ...(gstin.trim() ? { gstInvoice: { gstin: gstin.trim() } } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(typeof data.error === 'string' ? data.error : t('failed'))

      if (data.simulated) {
        // Simulation: complete the captured-payment path server-side.
        const sim = await fetch('/api/v1/checkout/simulate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ checkoutSessionId: data.checkoutSessionId }),
        })
        const simData = await sim.json()
        if (!sim.ok) throw new Error(simData.error ?? t('failed'))
        router.push(`/app/orders/${simData.orderId}?first=1`)
        return
      }

      // Real Razorpay: open the checkout sheet. The WEBHOOK creates the order.
      await loadRazorpay()
      const rzp = new window.Razorpay!({
        key: data.keyId,
        order_id: data.razorpayOrderId,
        amount: data.amountPaise,
        currency: 'INR',
        name: 'AMClub',
        description: title,
        handler: () => {
          // Redirect is cosmetic; the order appears once the webhook fires.
          router.push('/app/orders?processing=1')
        },
        modal: {
          // Buyer closed the sheet without paying — say so instead of leaving
          // them staring at an unchanged page (B1). Nothing was charged.
          ondismiss: () => setError(t('payment_cancelled')),
        },
      })
      rzp.open()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('failed'))
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
            <span>{t('total')}</span>
            <span className="font-display text-primary">{formatINR(dispTotal)}</span>
          </div>
        </dl>
      </div>

      {/* Coupons are flag-gated (default OFF) — hidden until re-enabled. */}
      {couponsEnabled && (
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <Input
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
            <Input id="gstin" value={gstin} onChange={(e) => setGstin(e.target.value)} placeholder="29ABCDE1234F1Z5" />
          </div>
        )}
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <Button onClick={pay} loading={loading} className="w-full" size="lg">
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

function loadRazorpay(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve()
    const s = document.createElement('script')
    s.src = 'https://checkout.razorpay.com/v1/checkout.js'
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Failed to load Razorpay'))
    document.body.appendChild(s)
  })
}
