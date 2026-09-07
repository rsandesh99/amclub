import { cn } from '@/lib/utils'

/**
 * Mart skeletons (FRONTEND.md §3.1 #7, §5 "skeletons not spinners").
 * Server-renderable, zero JS: `.mart-skeleton` bones (ivory→gold-tint sweep,
 * static under reduced motion) laid out in the same `.sheet-card` shapes as
 * the real screens so the swap to content is a fade, not a jump.
 * No copy inside — skeletons are `aria-hidden` and language-neutral.
 */

function Bone({ className }: { className?: string }) {
  return <div className={cn('mart-skeleton', className)} />
}

/** Matches components/mart/ProductCard.tsx (80px thumb + 3 text lines + price row). */
export function ProductCardSkeleton() {
  return (
    <div className="sheet-card flex gap-3 p-3">
      <Bone className="h-20 w-20 shrink-0 rounded-[8px]" />
      <div className="min-w-0 flex-1 space-y-2 py-0.5">
        <Bone className="h-4 w-3/4" />
        <Bone className="h-3 w-1/2" />
        <div className="flex items-baseline gap-2 pt-1">
          <Bone className="h-3 w-8" />
          <Bone className="h-6 w-20" />
        </div>
        <Bone className="h-3 w-2/5" />
      </div>
    </div>
  )
}

/** Matches app/[locale]/(mart-public)/mart/page.tsx: jaali header + chips + card grid. */
export function CatalogueSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <div aria-hidden="true">
      <div className="jaali-ivory border-b border-brass/40">
        <div className="mx-auto max-w-6xl px-4 py-8">
          <Bone className="h-9 w-48" />
          <Bone className="mt-3 h-4 w-72 max-w-full" />
          <div className="mt-5 flex max-w-xl gap-2">
            <Bone className="h-11 flex-1 rounded-[10px]" />
            <Bone className="h-11 w-24 rounded-[10px]" />
          </div>
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="flex gap-2 overflow-hidden pb-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Bone key={i} className="h-9 w-24 shrink-0 rounded-chip" />
          ))}
        </div>
        <Bone className="mt-4 h-3 w-28" />
        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: cards }, (_, i) => (
            <li key={i}>
              <ProductCardSkeleton />
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

/** Matches app/[locale]/(mart-public)/mart/p/[id]/page.tsx: breadcrumb + sheet (images, title, tier table) + sticky add bar. */
export function ProductPageSkeleton() {
  return (
    <div className="mx-auto max-w-3xl px-4 pb-28 pt-6" aria-hidden="true">
      <Bone className="h-3 w-40" />
      <div className="sheet-card mt-3 p-0">
        <div className="flex gap-2 overflow-hidden p-3">
          <Bone className="h-56 w-56 shrink-0 rounded-[8px]" />
          <Bone className="h-56 w-56 shrink-0 rounded-[8px]" />
        </div>
        <div className="space-y-3 p-4">
          <Bone className="h-8 w-2/3" />
          <Bone className="h-3 w-1/3" />
          <div className="space-y-2 pt-3">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex justify-between gap-3">
                <Bone className="h-4 w-1/4" />
                <Bone className="h-4 w-1/5" />
                <Bone className="h-4 w-1/5" />
              </div>
            ))}
          </div>
          <Bone className="h-3 w-1/2" />
          <Bone className="h-16 w-full" />
        </div>
      </div>
      <div className="sticky bottom-0 z-20 -mx-4 mt-6 border-t border-brass/40 bg-ivory/95 px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <Bone className="h-11 w-11 rounded-button" />
          <Bone className="h-11 w-20 rounded-[10px]" />
          <Bone className="h-11 w-11 rounded-button" />
          <Bone className="h-11 flex-1 rounded-button" />
        </div>
      </div>
    </div>
  )
}

/**
 * Order workspace — shared by services AND goods orders (kind-neutral: card
 * shapes only). Matches the max-w-2xl column of both workspaces: summary sheet,
 * 2-col facts, timeline rows, action bar.
 */
export function OrderWorkspaceSkeleton() {
  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6" aria-hidden="true">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <Bone className="h-7 w-48" />
          <Bone className="h-3 w-32" />
        </div>
        <Bone className="h-6 w-24 rounded-chip" />
      </div>
      <div className="sheet-card p-4">
        <Bone className="h-5 w-2/3" />
        <Bone className="mt-2 h-3 w-1/3" />
        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-brass/20 pt-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="space-y-1.5">
              <Bone className="h-3 w-16" />
              <Bone className="h-4 w-24" />
            </div>
          ))}
        </div>
      </div>
      <div className="sheet-card p-4">
        <Bone className="h-4 w-28" />
        <div className="mt-4 space-y-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex gap-3">
              <Bone className="mt-1 h-4 w-4 shrink-0 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Bone className="h-4 w-1/2" />
                <Bone className="h-3 w-1/4" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="sheet-card p-4">
        <Bone className="h-11 w-full rounded-button" />
      </div>
    </div>
  )
}

/** Matches app/[locale]/(mart-provider)/partner/goods/page.tsx: header row + banner + listing rows. */
export function SellerCatalogueSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-8" aria-hidden="true">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-2">
          <Bone className="h-8 w-40" />
          <Bone className="h-3 w-56" />
        </div>
        <Bone className="h-10 w-32 shrink-0 rounded-button" />
      </div>
      <Bone className="h-14 w-full rounded-[10px]" />
      <ul className="space-y-3">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="sheet-card flex items-center justify-between gap-3 p-4">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <Bone className="h-14 w-14 shrink-0 rounded-[8px]" />
              <div className="flex-1 space-y-2">
                <Bone className="h-4 w-1/2" />
                <Bone className="h-3 w-1/3" />
              </div>
            </div>
            <Bone className="h-6 w-20 rounded-chip" />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Matches CartClient: title + seller sheet with line rows + emerald totals card + sticky bar. */
export function CartSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="mx-auto max-w-lg space-y-5 px-4 py-6" aria-hidden="true">
      <Bone className="h-8 w-32" />
      <div className="sheet-card p-4">
        <Bone className="h-3 w-16" />
        <Bone className="mt-2 h-5 w-40" />
        <ul className="mt-3 divide-y divide-brass/20">
          {Array.from({ length: rows }, (_, i) => (
            <li key={i} className="flex items-center gap-3 py-3">
              <Bone className="h-12 w-12 shrink-0 rounded-[6px]" />
              <div className="min-w-0 flex-1 space-y-2">
                <Bone className="h-4 w-3/4" />
                <Bone className="h-3 w-1/2" />
              </div>
              <Bone className="h-11 w-20 rounded-[10px]" />
            </li>
          ))}
        </ul>
      </div>
      <div className="emerald-card p-5">
        <div className="space-y-2">
          <Bone className="h-4 w-full opacity-60" />
          <Bone className="h-4 w-full opacity-60" />
          <Bone className="mt-3 h-9 w-1/2 opacity-60" />
        </div>
      </div>
      <div className="sticky bottom-0 -mx-4 border-t border-brass/40 bg-ivory/95 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex-1 space-y-2">
            <Bone className="h-3 w-24" />
            <Bone className="h-6 w-28" />
          </div>
          <Bone className="h-11 w-32 rounded-button" />
        </div>
      </div>
    </div>
  )
}
