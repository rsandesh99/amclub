'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { ProductCard } from './ProductCard'
import { ProductCardSkeleton } from './skeletons'
import type { ProductSummary } from '@/lib/mart/queries'

/**
 * The only client JS on the catalogue grid: pages 2+ of the list. Renders
 * nothing but the button until the user asks for more; appended cards go
 * into a second grid with the same tracks and gap, so the eye sees one grid.
 */
export function LoadMore({
  total,
  shown,
  nextOffset,
  query,
}: {
  total: number
  shown: number
  nextOffset: number
  query: string
}) {
  const t = useTranslations('mart')
  const [items, setItems] = useState<ProductSummary[]>([])
  const [offset, setOffset] = useState<number | null>(nextOffset)
  const [busy, setBusy] = useState(false)

  async function more() {
    if (offset === null || busy) return
    setBusy(true)
    try {
      const res = await fetch(`/api/v1/mart/products?${query}${query ? '&' : ''}offset=${offset}&limit=24`)
      if (!res.ok) return
      const d = (await res.json()) as { products: ProductSummary[]; nextOffset: number | null }
      setItems((cur) => [...cur, ...d.products])
      setOffset(d.nextOffset)
    } finally {
      setBusy(false)
    }
  }

  const remaining = Math.max(0, total - shown - items.length)

  return (
    <>
      {(items.length > 0 || busy) && (
        <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-live="polite">
          {items.map((p) => (
            <li key={p.id}>
              <ProductCard product={p} />
            </li>
          ))}
          {busy &&
            Array.from({ length: 3 }, (_, i) => (
              <li key={`s${i}`}>
                <ProductCardSkeleton />
              </li>
            ))}
        </ul>
      )}
      {offset !== null && (
        <div className="mt-5 flex justify-center">
          <Button variant="outline" size="lg" onClick={more} loading={busy} className="border-emerald text-emerald">
            {t('load_more')} ({remaining})
          </Button>
        </div>
      )}
    </>
  )
}
