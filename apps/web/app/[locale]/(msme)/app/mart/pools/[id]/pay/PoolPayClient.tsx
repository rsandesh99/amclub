'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { formatINR, formatINRExact } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { SheetCard, EmeraldCard, GoldNumeral } from '@/components/mart/primitives'
import { istDateTime } from '@/components/mart/PoolProgress'

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void }
  }
}

interface Checkout {
  checkoutSessionId: string
  razorpayOrderId: string
  amountPaise: number
  keyId: string
  simulated?: boolean
  amounts: { taxablePaise: number; gstPaise: number; totalPaise: number; afterItcPaise: number }
  lineItems: { name: string; qty: number; unit: string; tier_unit_price_paise: number; line_taxable_paise: number }[]
  sellerName: string
  deliveryDays: number
  payBy: string | null
}

/**
 * The member's pool order — server-computed summary (the session is created
 * on load so the numbers are exactly what will be charged), then the same
 * simulate / Razorpay flow as goods checkout. Replays hit the same session.
 */
export function PoolPayClient({ poolId, title, unit }: { poolId: string; title: string; unit: string }) {
  const t = useTranslations('mart')
  const router = useRouter()
  const [co, setCo] = useState<Checkout | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const errKey = (code: string) => {
    const k = `pool_err_${code}`
    return t.has(k as 'pool_err_pool_closed') ? t(k as 'pool_err_pool_closed') : t('failed')
  }

  useEffect(() => {
    fetch(`/api/v1/mart/pools/${poolId}/checkout`, { method: 'POST' })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}))
        if (r.status === 409 && d.orderId) { router.replace(`/app/orders/${d.orderId}` as '/app'); return }
        if (!r.ok) { setError(typeof d.error === 'string' ? errKey(d.error) : t('failed')); return }
        setCo(d as Checkout)
      })
      .catch(() => setError(t('failed')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolId])

  async function pay() {
    if (!co) return
    setLoading(true); setError('')
    try {
      if (co.simulated) {
        const sim = await fetch('/api/v1/checkout/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkoutSessionId: co.checkoutSessionId }) })
        const d = await sim.json()
        if (!sim.ok) throw new Error(d.error ?? t('failed'))
        router.push(`/app/orders/${d.orderId}?first=1` as '/app')
        return
      }
      await loadRazorpay()
      const rzp = new window.Razorpay!({
        key: co.keyId, order_id: co.razorpayOrderId, amount: co.amountPaise, currency: 'INR', name: 'AMClub', description: title,
        handler: () => router.push('/app/orders?processing=1' as '/app'),
        modal: { ondismiss: () => setError(t('payment_cancelled')) },
      })
      rzp.open()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('failed'))
    } finally { setLoading(false) }
  }

  if (error && !co) return <p className="text-body text-stamp" role="alert">{error}</p>
  if (!co) return <div className="mart-skeleton h-40 w-full" aria-hidden />
  const li = co.lineItems[0]
  return (
    <div className="space-y-4">
      <SheetCard>
        <p className="text-xs text-foreground-secondary">{t('seller_label')}</p>
        <h2 className="font-semibold text-emerald-ink">{co.sellerName}</h2>
        {li && <p className="mt-2 text-body text-emerald-ink">{t('pool_pay_line', { qty: li.qty, unit: li.unit || unit, price: formatINRExact(li.tier_unit_price_paise) })} · {title}</p>}
        {co.payBy && <p className="mt-1 text-meta text-foreground-secondary">{t('pool_pay_by', { date: istDateTime(co.payBy) })}</p>}
      </SheetCard>
      <EmeraldCard>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between"><dt className="text-ivory/80">{t('subtotal')}</dt><dd className="tabular-nums">{formatINR(co.amounts.taxablePaise)}</dd></div>
          <div className="flex justify-between"><dt className="text-ivory/80">{t('gst')}</dt><dd className="tabular-nums">{formatINR(co.amounts.gstPaise)}</dd></div>
          <div className="flex items-baseline justify-between border-t border-ivory/20 pt-2">
            <dt className="font-semibold">{t('you_pay')}</dt>
            <dd><GoldNumeral className="text-3xl" countUpPaise={co.amounts.totalPaise} /></dd>
          </div>
          <div className="flex justify-between text-xs"><dt className="text-ivory/80">{t('after_itc')}</dt><dd className="tabular-nums">{formatINR(co.amounts.afterItcPaise)}</dd></div>
        </dl>
      </EmeraldCard>
      {error && <p className="text-sm text-stamp" role="alert">{error}</p>}
      <Button onClick={pay} loading={loading} className="w-full bg-gold-metal text-emerald-ink" size="lg">{t('pay', { amount: formatINR(co.amounts.totalPaise) })}</Button>
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
