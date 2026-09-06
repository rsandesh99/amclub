'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link, useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { formatINR, formatINRExact } from '@/lib/format'
import { useCart, groupBySeller } from '@/lib/mart/cart-store'
import { SheetCard, EmeraldCard, GoldNumeral, LatheSpinner } from '@/components/mart/primitives'

interface Preview {
  sellerName: string
  amounts: { taxablePaise: number; gstPaise: number; totalPaise: number; afterItcPaise: number }
  lineItems: { product_id: string; line_taxable_paise: number; tier_unit_price_paise: number; tier_min_qty: number }[]
}

const ERR_KEYS: Record<string, string> = {
  product_unavailable: 'item_unavailable',
  below_min_qty: 'below_min_qty',
  category_blocked: 'category_blocked',
  multiple_sellers: 'multiple_sellers',
  no_tier: 'below_min_qty',
}

/** Cart grouped by seller; totals are fetched from the server per seller group. */
export function CartClient() {
  const t = useTranslations('mart')
  const router = useRouter()
  const lines = useCart((s) => s.lines)
  const setQty = useCart((s) => s.setQty)
  const remove = useCart((s) => s.remove)
  const [hydrated, setHydrated] = useState(false)
  const [previews, setPreviews] = useState<Record<string, Preview | { error: string }>>({})
  const [loading, setLoading] = useState(false)
  useEffect(() => setHydrated(true), [])

  const groups = groupBySeller(lines)
  const key = JSON.stringify(lines.map((l) => [l.productId, l.qty]))
  useEffect(() => {
    if (!hydrated || lines.length === 0) return
    let cancelled = false
    setLoading(true)
    Promise.all(
      groups.map(async (g) => {
        const res = await fetch('/api/v1/mart/cart/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: g.lines.map((l) => ({ product_id: l.productId, qty: l.qty })) }),
        })
        const d = await res.json().catch(() => ({}))
        return [g.sellerId, res.ok ? (d as Preview) : { error: ERR_KEYS[d?.error?.code] ?? 'preview_failed' }] as const
      }),
    )
      .then((entries) => { if (!cancelled) setPreviews(Object.fromEntries(entries)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, hydrated])

  if (!hydrated) return <div className="flex justify-center py-16"><LatheSpinner /></div>

  if (lines.length === 0) {
    return (
      <div className="mx-auto max-w-lg px-4 py-10">
        <div className="jaali-ivory rounded-[10px] border border-brass/40 px-6 py-16 text-center">
          <h1 className="text-lg font-semibold text-emerald-ink">{t('cart_empty_title')}</h1>
          <p className="mt-1 text-sm text-foreground-secondary">{t('cart_empty_body')}</p>
          <Link href={'/mart' as '/services'}><Button className="mt-5 bg-emerald hover:bg-emerald-ink">{t('browse_cta')}</Button></Link>
        </div>
      </div>
    )
  }

  return (
    <div className="mart-enter mx-auto max-w-lg space-y-5 px-4 py-6">
      <h1 className="font-display text-2xl font-bold text-emerald-ink">{t('cart_title')}</h1>
      {groups.length > 1 && <p className="text-xs text-foreground-secondary">{t('one_seller_note')}</p>}
      {groups.map((g) => {
        const pv = previews[g.sellerId]
        const err = pv && 'error' in pv ? pv.error : null
        const ok = pv && !('error' in pv) ? pv : null
        return (
          <section key={g.sellerId} className="space-y-3">
            <SheetCard>
              <p className="text-xs text-foreground-secondary">{t('seller_label')}</p>
              <h2 className="font-semibold text-emerald-ink">{g.sellerName}</h2>
              <ul className="mt-3 divide-y divide-brass/20">
                {g.lines.map((l) => {
                  const li = ok?.lineItems.find((x) => x.product_id === l.productId)
                  return (
                    <li key={l.productId} className="flex items-center gap-3 py-3">
                      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-[6px] bg-emerald-ink/5">
                        {l.imageUrl && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={l.imageUrl} alt="" className="h-full w-full object-cover" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-emerald-ink">{l.name}</p>
                        {li && (
                          <p className="text-xs text-foreground-secondary tabular-nums">
                            {formatINRExact(li.tier_unit_price_paise)} {t('per_unit', { unit: l.unit })} · {t('line_total')} {formatINRExact(li.line_taxable_paise)}
                          </p>
                        )}
                      </div>
                      <input
                        type="number"
                        min={l.minOrderQty}
                        value={l.qty}
                        onChange={(e) => setQty(l.productId, Math.max(l.minOrderQty, Number(e.target.value) || l.minOrderQty))}
                        className="field-control w-20 text-center tabular-nums"
                        aria-label={t('qty')}
                      />
                      <button type="button" onClick={() => remove(l.productId)} className="text-xs text-stamp underline underline-offset-2">{t('remove')}</button>
                    </li>
                  )
                })}
              </ul>
            </SheetCard>
            {err && <p className="text-sm text-stamp">{t(err as 'preview_failed')}</p>}
            {ok && (
              <EmeraldCard>
                <dl className="space-y-1 text-sm">
                  <div className="flex justify-between"><dt className="text-ivory/80">{t('subtotal')}</dt><dd className="tabular-nums">{formatINR(ok.amounts.taxablePaise)}</dd></div>
                  <div className="flex justify-between"><dt className="text-ivory/80">{t('gst')}</dt><dd className="tabular-nums">{formatINR(ok.amounts.gstPaise)}</dd></div>
                  <div className="flex items-baseline justify-between border-t border-ivory/20 pt-2">
                    <dt className="font-semibold">{t('total')}</dt>
                    <dd><GoldNumeral className="text-3xl">{formatINR(ok.amounts.totalPaise)}</GoldNumeral></dd>
                  </div>
                  <div className="flex justify-between text-xs"><dt className="text-ivory/80">{t('after_itc')}</dt><dd className="tabular-nums">{formatINR(ok.amounts.afterItcPaise)}</dd></div>
                </dl>
                <Button
                  size="lg"
                  className="mt-4 w-full bg-gold-metal text-emerald-ink hover:opacity-95"
                  loading={loading}
                  onClick={() => router.push(`/app/mart/checkout?seller=${g.sellerId}` as '/app')}
                >
                  {t('checkout_cta')}
                </Button>
              </EmeraldCard>
            )}
          </section>
        )
      })}
    </div>
  )
}
