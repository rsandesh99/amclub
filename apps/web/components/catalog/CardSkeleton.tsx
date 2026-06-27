/** Skeleton loaders for listing grids — never spinner-on-white (§4). */

export function ResultCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card">
      <div className="flex items-center gap-3">
        <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-muted" />
        <div className="flex-1 space-y-1.5">
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
        </div>
      </div>
      <div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
      <div className="flex gap-1.5">
        <div className="h-5 w-16 animate-pulse rounded-chip bg-muted" />
        <div className="h-5 w-16 animate-pulse rounded-chip bg-muted" />
      </div>
      <div className="mt-2 border-t border-border pt-3">
        <div className="h-6 w-24 animate-pulse rounded bg-muted" />
      </div>
    </div>
  )
}

export function ResultGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <ResultCardSkeleton key={i} />
      ))}
    </div>
  )
}
