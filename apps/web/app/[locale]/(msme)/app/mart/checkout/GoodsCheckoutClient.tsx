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
import type { DeliveryDefaults } from '@/lib/mart/delivery-defaults'

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void }
  }
}

interface Preview {
  sellerName: string
  deliveryDays: number
  amounts: { taxablePaise: number; gstPaise: number; totalPaise: number; afterItcPaise: number }
  lineItems: { product_id: string; name: string; qty: number; unit: string; tier_unit_price_paise: number; line_taxable_paise: number; line_gst_paise: number }[]
  returnWindowHours: number
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
 * Goods checkout — delivery form + server-computed summary + pay. Mirrors the
 * services CheckoutClient flow (simulate in test mode; the WEBHOOK creates the
 * order with real keys). No motion while money is uncertain (FRONTEND.md §3.2).
 */
export function GoodsCheckoutClient({ sellerId, states, defaults }: { sellerId: string | null; states: { value: string; label: string }[]; defaults: DeliveryDefaults | null }) {
  const t = useTranslations('mart')
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
    city: defaults?.city ?? '', state: defaults?.state || 'AP', pincode: defaults?.pincode ?? '', pickup: defaults?.pickup ?? false,
  })
  const [gstin, setGstin] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }))

  useEffect(() => {
    if (!hydrated || !group) return
    fetch('/api/v1/mart/cart/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: group.lines.map((l) => ({ product_id: l.productId, qty: l.qty })) }),
    })
      .then(async (r) => { const d = await r.json(); if (!r.ok) { setPreviewErr(ERR_KEYS[d?.error?.code] ?? 'preview_failed'); return } setPreview(d as Preview) })
      .catch(() => setPreviewErr('preview_failed'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, group?.sellerId, JSON.stringify(group?.lines.map((l) => [l.productId, l.qty]) ?? [])])

  if (!hydrated) return null
  if (!group) {
    return <p className="text-sm text-foreground-secondary">{t('cart_empty_title')}</p>
  }

  async function pay() {
    setLoading(true); setError('')
    try {
      const res = await fetch('/api/v1/mart/checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: group!.lines.map((l) => ({ product_id: l.productId, qty: l.qty })),
          delivery: form,
          idempotencyKey: crypto.randomUUID(),
          ...(gstin.trim() ? { gstInvoice: { gstin: gstin.trim() } } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        const code = data?.error?.code as string | undefined
        throw new Error(code && ERR_KEYS[code] ? t(ERR_KEYS[code] as 'item_unavailable') : typeof data.error === 'string' ? data.error : t('failed'))
      }
      const clearLines = () => group!.lines.forEach((l) => removeMany(l.productId))
      if (data.simulated) {
        const sim = await fetch('/api/v1/checkout/simulate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ checkoutSessionId: data.checkoutSessionId }),
        })
        const simData = await sim.json()
        if (!sim.ok) throw new Error(simData.error ?? t('failed'))
        clearLines()
        router.push(`/app/orders/${simData.orderId}?first=1` as '/app')
        return
      }
      await loadRazorpay()
      const rzp = new window.Razorpay!({
        key: data.keyId, order_id: data.razorpayOrderId, amount: data.amountPaise, currency: 'INR', name: 'AMClub',
        description: preview?.sellerName ?? 'AMC Mart',
        handler: () => { clearLines(); router.push('/app/orders?processing=1' as '/app') },
        modal: { ondismiss: () => setError(t('payment_cancelled')) },
      })
      rzp.open()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('failed'))
    } finally { setLoading(false) }
  }

  const formValid = form.contact_name.trim().length >= 2 && /^(?:\+91)?[6-9]\d{9}$/.test(form.contact_phone) && form.address.trim().length >= 5 && form.city.trim().length >= 2 && /^\d{6}$/.test(form.pincode)

  return (
    <div className="space-y-5">
      <SheetCard>
        <p className="text-xs text-foreground-secondary">{t('seller_label')}</p>
        <h2 className="font-semibold text-emerald-ink">{group.sellerName}</h2>
        {preview ? (
          <ul className="mt-3 divide-y divide-brass/20 text-sm">
            {preview.lineItems.map((li) => (
              <li key={li.product_id} className="flex justify-between py-2">
                <span className="text-emerald-ink">{t('qty_unit', { qty: li.qty, unit: li.unit })} {li.name}</span>
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
        <div><Label htmlFor="cp">{t('contact_phone')}</Label><Input id="cp" inputMode="tel" value={form.contact_phone} onChange={(e) => set('contact_phone', e.target.value)} /></div>
        <div><Label htmlFor="ad">{t('address')}</Label><Input id="ad" value={form.address} onChange={(e) => set('address', e.target.value)} /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label htmlFor="ci">{t('city')}</Label><Input id="ci" value={form.city} onChange={(e) => set('city', e.target.value)} /></div>
          <div><Label htmlFor="pc">{t('pincode')}</Label><Input id="pc" inputMode="numeric" value={form.pincode} onChange={(e) => set('pincode', e.target.value)} /></div>
        </div>
        <div>
          <Label htmlFor="st">{t('state')}</Label>
          <Select id="st" value={form.state} onChange={(e) => set('state', e.target.value)}>
            {states.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </div>
        <label className="flex min-h-12 items-start gap-3 text-meta text-emerald-ink">
          <input type="checkbox" checked={form.pickup} onChange={(e) => set('pickup', e.target.checked)} className="mt-0.5 h-6 w-6 shrink-0 accent-emerald" />
          <span>{t('pickup')}<span className="block text-xs text-foreground-secondary">{t('pickup_hint')}</span></span>
        </label>
        <div>
          <Label htmlFor="gstin">{t('gstin')} ({t('gst_invoice')})</Label>
          <Input id="gstin" value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} placeholder="37AAPFU0939F1ZV" />
          {gstin.trim().length >= 15 && !isValidGstin(gstin.trim()) && <p className="text-xs text-warning">GSTIN checksum looks wrong</p>}
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
          <p className="mt-1 text-xs text-ivory/80">{t('return_window_note', { hours: preview.returnWindowHours })}</p>
        </EmeraldCard>
      )}

      {error && <p className="text-sm text-stamp" role="alert">{error}</p>}
      <Button onClick={pay} loading={loading} disabled={!preview || !formValid} className="w-full bg-gold-metal text-emerald-ink" size="lg">
        {t('pay', { amount: preview ? formatINR(preview.amounts.totalPaise) : '' })}
      </Button>
      <p className="text-center text-xs text-foreground-secondary">{t('secure_note')}</p>
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
