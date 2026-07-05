import type { SearchResponse } from '@/lib/catalog/types'

export interface GatewayResults {
  results: SearchResponse['results']
  total: number
  /** True when the state filter matched nothing and we widened to all states. */
  widened: boolean
}

// Promise-cached so the fetch can start the moment the category step is
// answered (steps 3–4 + the reveal animation hide the latency) and the reveal
// screen reuses the same in-flight promise.
const cache = new Map<string, Promise<GatewayResults>>()

async function query(cat: string | undefined, state: string | undefined): Promise<SearchResponse> {
  const params = new URLSearchParams({ verifiedOnly: 'true', sort: 'rating', limit: '12' })
  if (cat) params.set('category', cat)
  if (state) params.set('state', state)
  const res = await fetch(`/api/v1/catalog/search?${params.toString()}`)
  if (!res.ok) throw new Error(`search failed: ${res.status}`)
  return (await res.json()) as SearchResponse
}

export function fetchGatewayResults(
  cat: string | undefined,
  state: string | undefined,
): Promise<GatewayResults> {
  const key = `${cat ?? ''}|${state ?? ''}`
  const hit = cache.get(key)
  if (hit) return hit

  const p = (async () => {
    const first = await query(cat, state)
    if (first.total > 0 || !state) {
      return { results: first.results, total: first.total, widened: false }
    }
    // Real matching, honest fallback: nothing in the visitor's state yet →
    // show providers from other states and say so (results_from_state).
    const widened = await query(cat, undefined)
    return { results: widened.results, total: widened.total, widened: true }
  })()

  // Drop failed lookups from the cache so a network blip can be retried.
  p.catch(() => cache.delete(key))
  cache.set(key, p)
  return p
}
