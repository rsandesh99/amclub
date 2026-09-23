'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { isValidGstin } from '@amclub/shared'
import { formatINR, formatINRExact } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { useCart, groupBySeller } from '@/lib/mart/cart-store'
import { SheetCard, EmeraldCard, GoldNumeral } from '@/components/mart/primitives'
import { LineFlags } from '@/components/mart/LineFlags'
import type { DeliveryDefaults } from '@/lib/mart/delivery-defaults'
import { CHECKOUT_ERROR_KEYS, CheckoutError, newIdempotencyKey, payCheckout, startCheckout } from '@/lib/payments/razorpay-client'

interface Preview {
  sellerName: string
  deliveryDays: number
  amounts: { taxablePaise: number; gstPaise: number; totalPaise: number; afterItcPaise: number }
  lineItems: { product_id: string; name: string; qty: number; unit: string; tier_unit_price_paise: number; line_taxable_paise: number; line_gst_paise: number }[]
  returnWindowHours: number
  /** E16 N43 — server flags per line. */
  nonReturnableProductIds?: string[]
  itcIneligibleProductIds?: string[]
}

export type { DeliveryDefaults } from '@/lib/mart/delivery-defaults'

function deliveryDate(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000)
  return d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' })
}

const ERR_KEYS: Record<string, string> = {
  product_unavailable: 'item_unavailable', below_min_qty: 'below_min_qty', category_blocked: 'category_blocked', multiple_sellers: 'multiple_sellers', no_tier: 'below_min_qty',
}

/**
 * Indian mobile → the last 10 digits: strips spaces/dashes and a +91 / 91 / 0
 * prefix (a pasted "+91 98765 43210" or "098765 43210" both become
 * "9876543210"). Returns the digits as typed when there is no prefix to strip.
 */
function normalizeIndianPhone(raw: string): string {
  let d = raw.replace(/\D/g, '')
  if (d.length > 10 && d.startsWith('91')) d = d.slice(2)
  if (d.length > 10 && d.startsWith('0')) d = d.replace(/^0+/, '')
  return d.length > 10 ? d.slice(-10) : d
}

/**
 * Goods checkout — delivery form + server-computed summary + pay. Mirrors the
 * services CheckoutClient flow (simulate in test mode; the WEBHOOK creates the
 * order with real keys). No motion while money is uncertain (FRONTEND.md §3.2).
 */
export function GoodsCheckoutClient({ sellerId, states, defaults }: { sellerId: string | null; states: { value: string; label: string }[]; defaults: DeliveryDefaults | null }) {
  const t = useTranslations('mart')
  const tc = useTranslations('checkout')
  const router = useRouter()
  const lines = useCart((s) => s.lines)
  const removeMany = useCart((s) => s.remove)
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  const group = useMemo(() => groupBySeller(lines).find((g) => (sellerId ? g.sellerId === sellerId : true)) ?? null, [lines, sellerId])

  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewErr, setPreviewErr] = useState('')
  const [form, setForm] = useState({
    contact_name: defaults?.contact_name ?? '', contact_phone: defaults?.contact_phone ?? '', address: defaults?.address ?? '',
    // No silent default state (it drove the wrong IGST/CGST split): use the
    // buyer's saved delivery/profile state only if it is a known code, else
    // the buyer must choose.
    city: defaults?.city ?? '', state: defaults?.state && states.some((s) => s.value === defaults.state) ? defaults.state : '', pincode: defaults?.pincode ?? '', pickup: defaults?.pickup ?? false,
  })
  const [gstin, setGstin] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }))

  // Server preview — re-fetched whenever the cart OR the delivery state
  // changes (the state decides the IGST vs CGST+SGST split), so what is shown
  // is always the server's answer for the current inputs. A stale response
  // from an earlier state is discarded.
  useEffect(() => {
    if (!hydrated || !group) return
    let cancelled = false
    setPreview(null)
    setPreviewErr('')
    fetch('/api/v1/mart/cart/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: group.lines.map((l) => ({ product_id: l.productId, qty: l.qty })), ...(form.state ? { state: form.state } : {}) }),
    })
      .then(async (r) => {
        const d = await r.json().catch(() => null)
        if (cancelled) return
        if (!r.ok) { setPreviewErr(ERR_KEYS[d?.error?.code] ?? 'preview_failed'); return }
        setPreview(d as Preview)
      })
      .catch(() => { if (!cancelled) setPreviewErr('preview_failed') })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, group?.sellerId, form.state, JSON.stringify(group?.lines.map((l) => [l.productId, l.qty]) ?? [])])

  if (!hydrated) return null
  if (!group) {
    return <p className="text-sm text-foreground-secondary">{t('cart_empty_title')}</p>
  }

  const phone10 = normalizeIndianPhone(form.contact_phone)
  const phoneValid = /^[6-9]\d{9}$/.test(phone10)
  const gstinTyped = gstin.trim()
  const gstinOk = gstinTyped.length === 0 || isValidGstin(gstinTyped)

  async function pay() {
    setLoading(true); setError('')
    try {
      // Mart checkout keeps a fresh key per tap: /api/v1/mart/checkout's resume
      // path does not yet report simulated/paid state (follow-up), and the
      // button is disabled while a request is in flight.
      const data = await startCheckout('/api/v1/mart/checkout', {
        items: group!.lines.map((l) => ({ product_id: l.productId, qty: l.qty })),
        delivery: { ...form, contact_phone: phone10 },
        idempotencyKey: newIdempotencyKey(),
        ...(gstinTyped ? { gstInvoice: { gstin: gstinTyped } } : {}),
      })
      const clearLines = () => group!.lines.forEach((l) => removeMany(l.productId))
      await payCheckout(data, {
        description: preview?.sellerName ?? group!.sellerName,
        onPaid: (o) => {
          clearLines()
          router.push((o.kind === 'order' ? `/app/orders/${o.orderId}?first=1` : '/app/orders?processing=1') as '/app')
        },
        onDismiss: () => setError(t('payment_cancelled')),
      })
    } catch (e: unknown) {
      const code = e instanceof CheckoutError ? e.code : 'failed'
      setError(ERR_KEYS[code] ? t(ERR_KEYS[code] as 'item_unavailable') : CHECKOUT_ERROR_KEYS[code] ? tc(CHECKOUT_ERROR_KEYS[code] as 'failed') : t('failed'))
    } finally { setLoading(false) }
  }

  const formValid = form.contact_name.trim().length >= 2 && phoneValid && form.address.trim().length >= 5 && form.city.trim().length >= 2 && /^\d{6}$/.test(form.pincode) && form.state !== '' && gstinOk
  // Say WHY Pay is disabled (first unmet requirement), instead of a dead button.
  const blockedReason: string | null = !preview
    ? (previewErr ? null : t('pay_blocked_preview'))
    : form.state === ''
      ? t('pay_blocked_state')
      : !phoneValid
        ? t('pay_blocked_phone')
        : !gstinOk
          ? t('pay_blocked_gstin')
          : !formValid
            ? t('pay_blocked_form')
            : null

  return (
    <div className="space-y-5">
      <SheetCard>
        <p className="text-xs text-foreground-secondary">{t('seller_label')}</p>
        <h2 className="font-semibold text-emerald-ink">{group.sellerName}</h2>
        {preview ? (
          <ul className="mt-3 divide-y divide-brass/20 text-sm">
            {preview.lineItems.map((li) => (
              <li key={li.product_id} className="flex justify-between py-2">
                <span className="text-emerald-ink">
                  {t('qty_unit', { qty: li.qty, unit: li.unit })} {li.name}
                  <LineFlags nonReturnable={!!preview.nonReturnableProductIds?.includes(li.product_id)} itcIneligible={!!preview.itcIneligibleProductIds?.includes(li.product_id)} />
                </span>
                <span className="tabular-nums">{formatINRExact(li.line_taxable_paise)}</span>
              </li>
            ))}
          </ul>
        ) : previewErr ? (
          <p className="mt-2 text-sm text-stamp">{t(previewErr as 'preview_failed')}</p>
        ) : null}
      </SheetCard>

      <SheetCard className="space-y-3">
        <h2 className="text-meta font-semibold text-emerald-ink">{t('delivery_title')}</h2>
        {defaults && <p className="text-xs text-foreground-secondary">{t('address_prefilled')}</p>}
        <div><Label htmlFor="cn">{t('contact_name')}</Label><Input id="cn" value={form.contact_name} onChange={(e) => set('contact_name', e.target.value)} /></div>
        <div><Label htmlFor="cp">{t('contact_phone')}</Label><Input id="cp" type="tel" inputMode="tel" autoComplete="tel-national" maxLength={16} value={form.contact_phone} onChange={(e) => set('contact_phone', e.target.value)} onBlur={() => { if (phoneValid) set('contact_phone', phone10) }} aria-invalid={form.contact_phone.trim() !== '' && !phoneValid} />
          {form.contact_phone.trim() !== '' && !phoneValid && <p className="mt-1 text-xs text-warning">{t('pay_blocked_phone')}</p>}</div>
        <div><Label htmlFor="ad">{t('address')}</Label><Input id="ad" value={form.address} onChange={(e) => set('address', e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label htmlFor="ci">{t('city')}</Label><Input id="ci" value={form.city} onChange={(e) => set('city', e.target.value)} /></div>
          <div><Label htmlFor="pc">{t('pincode')}</Label><Input id="pc" inputMode="numeric" value={form.pincode} onChange={(e) => set('pincode', e.target.value)} /></div>
        </div>
        <div>
          <Label htmlFor="st">{t('state')}</Label>
          <Select id="st" value={form.state} onChange={(e) => set('state', e.target.value)} required aria-invalid={form.state === ''}>
            <option value="" disabled>{t('state_placeholder')}</option>
            {states.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </div>
        <label className="flex min-h-12 items-start gap-3 text-meta text-emerald-ink">
          <input type="checkbox" checked={form.pickup} onChange={(e) => set('pickup', e.target.checked)} className="mt-0.5 h-6 w-6 shrink-0 accent-emerald" />
          <span>{t('pickup')}<span className="block text-xs text-foreground-secondary">{t('pickup_hint')}</span></span>
        </label>
        <div>
          <Label htmlFor="gstin">{t('gstin')} ({t('gst_invoice')})</Label>
          <Input id="gstin" value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase().replace(/\s/g, '').slice(0, 15))} maxLength={15} autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="37AAPFU0939F1ZV" />
          {gstinTyped.length >= 15 && !isValidGstin(gstinTyped) && <p className="text-xs text-warning">{t('gstin_check_hint')}</p>}
        </div>
      </SheetCard>

      {preview && (
        <EmeraldCard>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-ivory/80">{t('subtotal')}</dt><dd className="tabular-nums">{formatINR(preview.amounts.taxablePaise)}</dd></div>
            <div className="flex justify-between"><dt className="text-ivory/80">{t('gst')}</dt><dd className="tabular-nums">{formatINR(preview.amounts.gstPaise)}</dd></div>
            <div className="flex items-baseline justify-between border-t border-ivory/20 pt-2">
              <dt className="font-semibold">{t('you_pay')}</dt>
              <dd><GoldNumeral className="text-3xl" countUpPaise={preview.amounts.totalPaise} /></dd>
            </div>
            <div className="flex justify-between text-xs"><dt className="text-ivory/80">{t('after_itc')}</dt><dd className="tabular-nums">{formatINR(preview.amounts.afterItcPaise)}</dd></div>
          </dl>
          <p className="mt-3 text-meta font-medium text-ivory">{form.pickup ? t('pickup_label') : t('delivery_by', { date: deliveryDate(preview.deliveryDays) })}</p>
          <p className="mt-1 text-xs text-ivory/80">
            {/* E16 N43 — nothing returnable in this order: say so instead of a window. */}
            {preview.nonReturnableProductIds && preview.nonReturnableProductIds.length === preview.lineItems.length ? `${t('not_returnable')} · ${t('not_returnable_claims_only')}` : t('return_window_note', { hours: preview.returnWindowHours })}
          </p>
        </EmeraldCard>
      )}

      {error && <p className="text-sm text-stamp" role="alert">{error}</p>}
      {blockedReason && <p id="pay-blocked" className="text-center text-xs text-foreground-secondary" role="status">{blockedReason}</p>}
      <Button onClick={pay} loading={loading} disabled={!preview || !formValid} aria-describedby={blockedReason ? 'pay-blocked' : undefined} className="w-full bg-gold-metal text-emerald-ink" size="lg">
        {t('pay', { amount: preview ? formatINR(preview.amounts.totalPaise) : '' })}
      </Button>
      <p className="text-center text-xs text-foreground-secondary">{t('secure_note')}</p>
    </div>
  )
}
