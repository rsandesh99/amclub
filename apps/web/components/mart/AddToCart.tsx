'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { useCart } from '@/lib/mart/cart-store'
import { GoldStamp } from './primitives'

/** Sticky add-to-cart (thumb zone, 48dp). Qty only — prices are never client-side. */
export function AddToCart({
  productId,
  name,
  unit,
  sellerId,
  sellerName,
  minOrderQty,
  imageUrl,
}: {
  productId: string
  name: string
  unit: string
  sellerId: string
  sellerName: string
  minOrderQty: number
  imageUrl: string | null
}) {
  const t = useTranslations('mart')
  const add = useCart((s) => s.add)
  const count = useCart((s) => s.lines.reduce((n, l) => n + l.qty, 0))
  const [qty, setQty] = useState(minOrderQty)
  const [added, setAdded] = useState(false)

  function onAdd() {
    add({ productId, name, unit, sellerId, sellerName, minOrderQty, imageUrl }, qty)
    setAdded(true)
    setTimeout(() => setAdded(false), 1600)
  }

  return (
    <div className="sticky bottom-0 z-20 -mx-4 border-t border-brass/40 bg-ivory/95 px-4 py-3 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-emerald-ink">
          <span className="sr-only">{t('qty')}</span>
          <button type="button" aria-label="−" onClick={() => setQty((q) => Math.max(minOrderQty, q - 1))} className="h-11 w-11 rounded-button border border-brass/60 text-lg">−</button>
          <input
            type="number"
            min={minOrderQty}
            value={qty}
            onChange={(e) => setQty(Math.max(minOrderQty, Math.floor(Number(e.target.value) || minOrderQty)))}
            className="field-control w-20 text-center tabular-nums"
            aria-label={t('qty')}
          />
          <button type="button" aria-label="+" onClick={() => setQty((q) => q + 1)} className="h-11 w-11 rounded-button border border-brass/60 text-lg">+</button>
          <span className="text-xs text-foreground-secondary">{unit}</span>
        </label>
        <Button onClick={onAdd} size="lg" className="flex-1 bg-emerald hover:bg-emerald-ink">
          {added ? (
            <span className="inline-flex items-center gap-2">
              <GoldStamp className="h-6 w-6 text-xs">✓</GoldStamp> {t('added')}
            </span>
          ) : (
            t('add_to_cart')
          )}
        </Button>
        {count > 0 && (
          <Link href={'/app/mart/cart' as '/app'} className="text-sm font-semibold text-emerald underline underline-offset-2">
            {t('view_cart')} ({count})
          </Link>
        )}
      </div>
    </div>
  )
}
