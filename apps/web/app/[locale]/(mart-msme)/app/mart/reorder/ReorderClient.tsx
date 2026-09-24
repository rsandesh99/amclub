'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link, useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { formatINRExact } from '@/lib/format'
import { useCart } from '@/lib/mart/cart-store'
import { useAnalytics } from '@/components/providers/posthog'
import { SheetCard } from '@/components/mart/primitives'
import type { ReorderItem } from '@/lib/mart/reorder'

const istDate = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })

/** E16 N44 — renders the server's reorder list; the only money shown is server paise. */
export function ReorderClient({ items }: { items: ReorderItem[] }) {
  const t = useTranslations('mart')
  const router = useRouter()
  const analytics = useAnalytics()
  const add = useCart((s) => s.add)
  const [reminders, setReminders] = useState<Record<string, ReorderItem['reminder']>>(Object.fromEntries(items.map((i) => [i.productId, i.reminder])))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  if (items.length === 0) {
    return (
      <div className="jaali-ivory rounded-[10px] border border-dashed border-brass/60 px-6 py-12 text-center" data-testid="reorder-empty">
        <p className="text-sm text-foreground-secondary">{t('reorder_empty')}</p>
        <Link href={'/mart' as '/services'} className="mt-3 inline-flex min-h-11 items-center rounded-button bg-emerald px-4 text-meta font-semibold text-ivory">{t('reorder_browse')}</Link>
      </div>
    )
  }

  async function toggle(item: ReorderItem, on: boolean) {
    setBusy(item.productId); setError('')
    try {
      const res = await fetch('/api/v1/mart/reorder/reminders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: item.productId, on }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error()
      setReminders((r) => ({ ...r, [item.productId]: d.reminder }))
      analytics.capture('mart_reorder_reminder_set', { on, interval_days: item.intervalDays })
    } catch { setError(t('reorder_reminder_failed')) } finally { setBusy(null) }
  }

  function reorder(item: ReorderItem) {
    if (!item.cart) return
    analytics.capture('mart_reorder_clicked', { price_changed: item.priceChanged })
    add({ productId: item.productId, name: item.name, unit: item.unit, sellerId: item.cart.sellerId, sellerName: item.cart.sellerName, minOrderQty: item.cart.minOrderQty, imageUrl: item.cart.imageUrl }, item.cart.qty)
    router.push('/app/mart/cart' as '/app')
  }

  return (
    <ul className="space-y-3" data-testid="reorder-list">
      {error && <li><p className="text-sm text-danger" role="alert">{error}</p></li>}
      {items.map((i) => {
        const r = reminders[i.productId]
        return (
          <li key={i.productId} data-product={i.productId}>
            <SheetCard className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-semibold text-emerald-ink">{i.name}</h2>
                <p className="text-xs text-foreground-secondary">{t('reorder_last', { qty: i.lastQty, unit: i.unit, date: istDate(i.lastOrderedAt), orders: i.orders })}</p>
              </div>
              <dl className="grid grid-cols-2 gap-2 text-meta">
                <div><dt className="text-xs text-foreground-secondary">{t('reorder_then')}</dt><dd className="tabular-nums">{formatINRExact(i.then.unit_price_paise)} {t('per_unit', { unit: i.unit })}</dd></div>
                <div>
                  <dt className="text-xs text-foreground-secondary">{t('reorder_today')}</dt>
                  <dd className={`tabular-nums ${i.priceChanged ? 'font-semibold text-ink' : ''}`} data-testid={i.priceChanged ? 'price-changed' : undefined}>
                    {i.today ? `${formatINRExact(i.today.unit_price_paise)} ${t('per_unit', { unit: i.unit })}` : t('reorder_unavailable')}
                    {i.priceChanged && <span className="ml-1 text-xs font-normal text-warning">· {t('reorder_price_changed')}</span>}
                  </dd>
                </div>
              </dl>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" className="bg-emerald hover:bg-emerald-ink" disabled={!i.cart} onClick={() => reorder(i)}>{t('reorder_cta', { qty: i.cart?.qty ?? i.lastQty })}</Button>
                <Button size="sm" variant="outline" loading={busy === i.productId} onClick={() => void toggle(i, !r?.active)} aria-pressed={!!r?.active}>
                  {r?.active ? t('reorder_reminder_on', { days: r.intervalDays, date: istDate(r.nextAt) }) : t('reorder_reminder_off', { days: i.intervalDays })}
                </Button>
              </div>
            </SheetCard>
          </li>
        )
      })}
    </ul>
  )
}
