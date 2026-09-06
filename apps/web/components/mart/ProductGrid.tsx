'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { ProductCard } from './ProductCard'
import { ProductCardSkeleton } from './skeletons'
import type { ProductSummary } from '@/lib/mart/queries'

/**
 * Server-rendered first page (props) + client "show more" against the
 * edge-cached /api/v1/mart/products. The initial HTML carries every card the
 * user sees first; JS only runs for page 2 onwards.
 */
export function ProductGrid({
  initial,
  total,
  nextOffset,
  query,
}: {
  initial: ProductSummary[]
  total: number
  nextOffset: number | null
  /** Query string (without offset) that produced `initial`. */
  query: string
}) {
  const t = useTranslations('mart')
  const [items, setItems] = useState(initial)
  const [offset, setOffset] = useState<number | null>(nextOffset)
  const [busy, setBusy] = useState(false)

  async function more() {
    if (offset === null) return
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

  return (
    <>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((p, i) => (
          <li key={p.id}>
            <ProductCard product={p} priority={i < 3} />
          </li>
        ))}
        {busy && Array.from({ length: 3 }, (_, i) => (
          <li key={`s${i}`}>
            <ProductCardSkeleton />
          </li>
        ))}
      </ul>
      {offset !== null && (
        <div className="mt-5 flex justify-center">
          <Button variant="outline" size="lg" onClick={more} loading={busy} className="border-emerald text-emerald">
            {t('load_more')} ({total - items.length})
          </Button>
        </div>
      )}
    </>
  )
}
