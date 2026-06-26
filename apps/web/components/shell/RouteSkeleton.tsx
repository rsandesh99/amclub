/** Generic content skeleton shown during route-segment loading. */
export function RouteSkeleton() {
  return (
    <div className="mx-auto max-w-2xl animate-pulse px-4 py-8" aria-hidden>
      <div className="h-7 w-40 rounded bg-gray-200" />
      <div className="mt-2 h-4 w-64 rounded bg-gray-100" />
      <div className="mt-6 space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-20 rounded-card bg-gray-100" />
        ))}
      </div>
    </div>
  )
}
