import { ProductCard } from './ProductCard'
import { LoadMore } from './LoadMore'
import type { ProductSummary } from '@/lib/mart/queries'

/**
 * Catalogue grid. SERVER component: the first page of cards is plain HTML —
 * no card is serialised into the RSC payload twice and no hydration work runs
 * for it (the previous client grid cost ~180 ms of main-thread time on a
 * mid-range Android just to re-mount 24 cards it already had). Only the
 * "show more" control below is a client island; it appends page 2+ from the
 * edge-cached /api/v1/mart/products into its own grid that continues this one.
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
  return (
    <>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {initial.map((p, i) => (
          <li key={p.id}>
            <ProductCard product={p} priority={i < 3} />
          </li>
        ))}
      </ul>
      {nextOffset !== null && <LoadMore total={total} shown={initial.length} nextOffset={nextOffset} query={query} />}
    </>
  )
}
