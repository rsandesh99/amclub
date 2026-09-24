'use client'

import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import { BUYER_LEGAL_DOCS, addonSelectionKey, gstPercent, isValidGstin, type PriceDisplay } from '@amclub/shared'
import { useRouter } from '@/i18n/navigation'
import { formatINRExact } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ConsentCheckbox } from '@/components/auth/ConsentCheckbox'
import { RefundLine } from '@/components/packages-v3/BuyBox'
import { useAnalytics } from '@/components/providers/posthog'
import { readSearchAttribution } from '@/components/search-v3/SearchAttributionCapture'
import { acceptLegalDocs } from '@/lib/legal/client'
import { CHECKOUT_ERROR_KEYS, checkoutErrorKey, isCheckoutExpired, newIdempotencyKey, payCheckout, startCheckout } from '@/lib/payments/razorpay-client'

// Loaded only when needed: the sign-in panel (guests) and the success moment (after paying).
const AuthPanel = dynamic(() => import('@/components/auth/AuthPanel').then((m) => m.AuthPanel), { ssr: false })
const PaisaMoment = dynamic(() => import('@/components/mart/PaisaMoment').then((m) => m.PaisaMoment), { ssr: false })

export type CheckoutMode = 'guest' | 'profile' | 'pay'

/** E12c — one milestone of a plan as checkout lists it (the server's exact split). */
export interface CheckoutPlanLine {
  label: string
  dueOffsetDays: number
  totalPaise: number
}

/** E12a — one chosen add-on as checkout lists it (the price is the server's). */
export interface CheckoutAddonLine {
  id: string
  label: string
  pricePaise: number
}

/**
 * Experience v3 E5 — checkout. Every figure is a server `display` (N16): the
 * package's, or the coupon route's when a coupon is applied. The client only
 * chooses which to show.
 *
 *  - guest (FR-5.1, N1): phone → OTP → name + business + consent, on this page
 *  - profile: signed in without a buyer profile — the last step inline
 *  - pay: breakdown, ITC line (checksum-valid GSTIN), what happens next,
 *    refund line, sticky Pay, then the Paisa Moment (≤ 900 ms) → the order
 */
export function CheckoutV3({
  mode,
  locale,
  packageId,
  title,
  providerName,
  deliveryDays,
  display,
  itcGstinMasked,
  profileGstin,
  providerPaused,
  couponsEnabled,
  nextSteps,
  addonIds = [],
  addonLines = [],
  addonsDropped = false,
  planLines = [],
}: {
  mode: CheckoutMode
  locale: string
  packageId: string
  title: string
  providerName: string
  deliveryDays: number
  display: PriceDisplay
  /** "36AA…Z5" when the buyer's profile GSTIN is checksum-valid, else null. */
  itcGstinMasked: string | null
  profileGstin: string | null
  providerPaused: boolean
  couponsEnabled: boolean
  nextSteps: string[]
  /** E12a / ADR 019 — the add-ons this checkout charges (validated and priced on the server). */
  addonIds?: string[]
  addonLines?: CheckoutAddonLine[]
  /** A chosen add-on is no longer offered, so it was left out. */
  addonsDropped?: boolean
  /** E12c / ADR 021 — the plan's milestones (one payment now, one order per milestone). */
  planLines?: CheckoutPlanLine[]
}) {
  const t = useTranslations('checkout')
  const tv = useTranslations('checkout_v3')
  const tc = useTranslations('coupons')
  const tAuth = useTranslations('auth')
  const router = useRouter()
  const analytics = useAnalytics()

  // Consent given before the OTP survives the refresh that follows sign-in
  // (the layout swaps from the public header to the app shell).
  const [consented, setConsentedState] = useState(false)
  useEffect(() => {
    try {
      if (sessionStorage.getItem('amc_checkout_consent') === '1') setConsentedState(true)
    } catch { /* private mode */ }
  }, [])
  const setConsented = (v: boolean) => {
    setConsentedState(v)
    try { sessionStorage.setItem('amc_checkout_consent', v ? '1' : '0') } catch { /* private mode */ }
  }
  const [fullName, setFullName] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [coupon, setCoupon] = useState('')
  const [applied, setApplied] = useState<{ code: string; discountPaise: number; display: PriceDisplay } | null>(null)
  const [couponMsg, setCouponMsg] = useState('')
  const [couponBusy, setCouponBusy] = useState(false)
  const prefillGstin = profileGstin && isValidGstin(profileGstin.trim().toUpperCase()) ? profileGstin.trim().toUpperCase() : ''
  const [gstOpen, setGstOpen] = useState(false)
  const [gstin, setGstin] = useState(prefillGstin)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [paid, setPaid] = useState<{ href: string } | null>(null)
  const authStarted = useRef(false)
  const intent = useRef<{ sig: string; key: string } | null>(null)
  const keyFor = (sig: string) => {
    if (!intent.current || intent.current.sig !== sig) intent.current = { sig, key: newIdempotencyKey() }
    return intent.current.key
  }

  const shown = applied?.display ?? display
  const itcOn = mode === 'pay' && !!itcGstinMasked

  useEffect(() => {
    analytics.capture('checkout_viewed', { device: 'web', logged_in: mode !== 'guest' })
  }, [analytics, mode])
  useEffect(() => {
    if (itcOn) analytics.capture('checkout_itc_shown', { device: 'web' })
  }, [analytics, itcOn])

  async function applyCoupon() {
    const code = coupon.trim()
    if (!code) return
    setCouponBusy(true)
    setCouponMsg('')
    try {
      const res = await fetch('/api/v1/coupons/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, packageId, ...(addonIds.length ? { addonIds } : {}) }) })
      const d = (await res.json()) as { ok?: boolean; discountPaise?: number; code?: string; error?: string; display?: PriceDisplay }
      if (d.ok && d.discountPaise && d.discountPaise > 0 && d.display) setApplied({ code: d.code ?? code.toUpperCase(), discountPaise: d.discountPaise, display: d.display })
      else {
        setApplied(null)
        setCouponMsg(tc((d.error ?? 'coupon_not_found') as 'coupon_not_found'))
      }
    } catch {
      setCouponMsg(tc('coupon_not_found'))
    } finally {
      setCouponBusy(false)
    }
  }

  async function saveProfile() {
    if (!consented) return setError(tAuth('consent_required'))
    if (fullName.trim().length < 2 || businessName.trim().length < 2) return setError(tv('err_details'))
    setLoading(true)
    setError('')
    try {
      // The same two writes as the signup wizard: acceptance rows first (the
      // profile endpoint is gated on them), then the buyer profile.
      const legal = await acceptLegalDocs([...BUYER_LEGAL_DOCS], locale)
      if (!legal.ok) throw new Error(tv('err_save'))
      const res = await fetch('/api/v1/profile/msme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName: fullName.trim(), businessName: businessName.trim(), preferredLocale: locale }),
      })
      if (!res.ok) throw new Error(tv('err_save'))
      analytics.capture('checkout_inline_auth_completed', { device: 'web', new_profile: true })
      router.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : tv('err_save'))
    } finally {
      setLoading(false)
    }
  }

  async function pay() {
    setLoading(true)
    setError('')
    const couponCode = applied ? applied.code : ''
    const gst = gstin.trim().toUpperCase()
    analytics.capture('payment_initiated', { device: 'web', coupon: !!couponCode, gst_invoice: !!gst })
    if (addonIds.length) analytics.capture('checkout_addons', { device: 'web', count: addonIds.length })
    const attribution = readSearchAttribution(packageId)
    try {
      const data = await startCheckout('/api/v1/checkout', {
        packageId,
        // The key covers the add-on selection too: a different selection is a different session.
        idempotencyKey: keyFor(`${couponCode}|${gst}|${addonSelectionKey(addonIds)}`),
        ...(addonIds.length ? { addonIds } : {}),
        ...(couponCode ? { couponCode } : {}),
        ...(gst ? { gstInvoice: { gstin: gst } } : {}),
        // E15 F5 — the search that led here (never part of the charge).
        ...(attribution ? { attribution } : {}),
      })
      await payCheckout(data, {
        description: title,
        onPaid: (o) => setPaid({ href: o.kind === 'order' ? `/app/orders/${o.orderId}?first=1` : '/app/orders?processing=1' }),
        onDismiss: () => setError(t('payment_cancelled')),
      })
    } catch (e: unknown) {
      // ADR 027 — an expired session is never resumed: the next tap starts a fresh one.
      if (isCheckoutExpired(e)) intent.current = null
      setError(t(checkoutErrorKey(e, CHECKOUT_ERROR_KEYS, 'failed') as 'failed'))
    } finally {
      setLoading(false)
    }
  }

  const row = (label: string, value: string, strong = false) => (
    <div className={strong ? 'flex items-center justify-between border-t border-separator pt-2 text-base font-bold' : 'flex items-center justify-between'}>
      <dt className={strong ? '' : 'text-foreground-secondary'}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )

  return (
    <div className="space-y-5 pb-28 lg:pb-0" data-testid="checkout-v3" data-mode={mode}>
      {paid && <PaisaMoment kind="paid" amountPaise={shown.totalPaise} totalMs={900} onDone={() => router.push(paid.href as '/app/orders')} />}

      <section className="rounded-card border border-border bg-surface p-5 shadow-card">
        <h2 className="font-medium">{title}</h2>
        <p className="text-sm text-foreground-secondary">{providerName} · {t('delivery_days', { days: deliveryDays })}</p>
        {addonsDropped && <p className="mt-2 text-xs font-medium text-warning" role="status" data-testid="addons-dropped">{tv('addons_dropped')}</p>}
        <dl className="mt-4 space-y-2 border-t border-separator pt-4 text-sm" data-testid="checkout-breakdown">
          {row(t('price'), formatINRExact(shown.listPaise))}
          {addonLines.map((a) => (
            <div key={a.id} className="flex items-center justify-between pl-3 text-xs text-foreground-secondary" data-testid="checkout-addon">
              <dt>{tv('addon_included', { label: a.label })}</dt>
              <dd className="tabular-nums">{formatINRExact(a.pricePaise)}</dd>
            </div>
          ))}
          {display.discountPaise > 0 && row(t('discount'), '− ' + formatINRExact(display.discountPaise))}
          {applied && row(`${tc('applied')} (${applied.code})`, '− ' + formatINRExact(applied.discountPaise))}
          {row(t('taxable'), formatINRExact(shown.taxablePaise))}
          {row(tv('gst_line', { pct: gstPercent(shown.gstBps) }), formatINRExact(shown.gstPaise))}
          {row(t('total'), formatINRExact(shown.totalPaise), true)}
        </dl>
        {planLines.length > 0 && (
          <div className="mt-4 border-t border-separator pt-3 text-sm" data-testid="checkout-plan">
            <p className="font-medium">{tv('plan_title', { n: planLines.length })}</p>
            <ol className="mt-2 space-y-1">
              {planLines.map((l, i) => (
                <li key={i} className="flex justify-between gap-3 text-xs">
                  <span>{i + 1}. {l.label} · {tv('plan_by_day', { day: l.dueOffsetDays })}</span>
                  <span className="tabular-nums">{formatINRExact(l.totalPaise)}</span>
                </li>
              ))}
            </ol>
            <p className="mt-2 text-xs text-foreground-secondary">{tv('plan_note')}</p>
          </div>
        )}
        {itcOn && (
          <p className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-button bg-success/10 px-3 py-2 text-sm text-success" data-testid="checkout-itc">
            <span>{tv('itc_line', { amount: formatINRExact(shown.gstPaise), gstin: itcGstinMasked! })}</span>
            <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={() => setGstOpen(true)}>{tv('change')}</button>
          </p>
        )}
      </section>

      <section aria-labelledby="whats-next" className="rounded-card border border-border bg-surface p-5">
        <h2 id="whats-next" className="t-headline">{tv('next_title')}</h2>
        <ol className="mt-3 space-y-2 text-sm" data-testid="checkout-next">
          {nextSteps.map((line, i) => (
            <li key={i} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">{i + 1}</span>
              <span>{line}</span>
            </li>
          ))}
        </ol>
        <RefundLine className="mt-4" />
      </section>

      {mode === 'guest' && (
        <section
          className="rounded-card border border-primary/30 bg-surface p-5"
          data-testid="inline-auth"
          onFocusCapture={() => {
            if (authStarted.current) return
            authStarted.current = true
            analytics.capture('checkout_inline_auth_started', { device: 'web' })
          }}
        >
          <h2 className="t-headline">{tv('auth_title')}</h2>
          <p className="mb-4 mt-1 text-sm text-foreground-secondary">{tv('auth_body')}</p>
          <AuthPanel
            onAuthenticated={() => router.refresh()}
            googleRedirectTo={`/app/checkout/${packageId}`}
            consent={{ checked: consented, onChange: setConsented }}
          />
        </section>
      )}

      {mode === 'profile' && (
        <section className="space-y-3 rounded-card border border-primary/30 bg-surface p-5" data-testid="inline-profile">
          <h2 className="t-headline">{tv('profile_title')}</h2>
          <div>
            <Label htmlFor="co-name">{tv('full_name')}</Label>
            <Input id="co-name" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={100} />
          </div>
          <div>
            <Label htmlFor="co-biz">{tv('business_name')}</Label>
            <Input id="co-biz" autoComplete="organization" value={businessName} onChange={(e) => setBusinessName(e.target.value)} maxLength={150} />
          </div>
          <ConsentCheckbox checked={consented} onChange={setConsented} id="checkout-consent" />
          <Button onClick={saveProfile} loading={loading} className="w-full">{tv('continue_to_pay')}</Button>
        </section>
      )}

      {mode === 'pay' && (
        <>
          {couponsEnabled && (
            <div className="space-y-1.5">
              <Label htmlFor="coupon">{t('coupon_label')}</Label>
              <div className="flex gap-2">
                <Input id="coupon" autoComplete="off" value={coupon} onChange={(e) => { setCoupon(e.target.value.toUpperCase()); setApplied(null); setCouponMsg('') }} placeholder={t('coupon')} />
                <Button variant="secondary" onClick={applyCoupon} loading={couponBusy} disabled={!coupon.trim()}>{tc('apply')}</Button>
              </div>
              {couponMsg && <p className="text-sm text-danger">{couponMsg}</p>}
            </div>
          )}
          <div className="rounded-card border border-border bg-surface p-4">
            <button type="button" onClick={() => setGstOpen((v) => !v)} aria-expanded={gstOpen} className="flex w-full items-center justify-between text-sm font-medium">
              {t('gst_invoice')} <span className="text-foreground-secondary">{gstOpen ? '−' : '+'}</span>
            </button>
            {gstOpen && (
              <div className="mt-3 space-y-1.5">
                <Label htmlFor="gstin">{t('gstin')}</Label>
                <Input id="gstin" value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase().replace(/\s/g, '').slice(0, 15))} maxLength={15} autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="27AAPFU0939F1ZV" />
                {gstin.trim().length >= 15 && !isValidGstin(gstin.trim()) && <p className="text-xs font-medium text-warning" role="status">{t('gstin_check_hint')}</p>}
              </div>
            )}
          </div>
          {providerPaused && <p className="text-sm font-medium text-warning" role="status">{t('err_provider_paused')}</p>}
        </>
      )}

      {error && <p className="text-sm text-danger" role="alert">{error}</p>}

      {mode === 'pay' && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface px-4 pt-3 lg:static lg:border-0 lg:bg-transparent lg:p-0" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
          <Button onClick={pay} loading={loading} disabled={providerPaused} className="w-full" size="lg" data-testid="checkout-pay">
            {t('pay', { amount: formatINRExact(shown.totalPaise) })}
          </Button>
          <p className="mt-2 text-center text-xs text-foreground-secondary">{t('secure_note')}</p>
        </div>
      )}
    </div>
  )
}
