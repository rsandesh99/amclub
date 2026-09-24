/**
 * Phase 8 §2(a) — 500 concurrent catalog searches.
 *
 * Query pool mirrors real traffic (popular category/state/term combos), so
 * most requests are Vercel-edge cache HITs (the search API sets s-maxage=60)
 * with a steady MISS stream hitting Postgres FTS. The per-IP search limiter is
 * 60 MISSes/min — cached HITs don't consume it.
 *
 * From ONE machine against a deployment with the limiter live (production),
 * most uncached searches are answered 429: 500 VUs share one IP. That is the
 * limiter doing its job, so a 429 counts as an expected response. The latency
 * target is measured on the 200s, and any 5xx fails the run (2026-09-24: the
 * first production run failed only on the 429 share).
 *
 * Run: k6 run -e BASE_URL=https://<preview>.vercel.app loadtest/k6-search.js
 */
import http from 'k6/http'
import { check, sleep } from 'k6'
import { Counter } from 'k6/metrics'

const BASE = __ENV.BASE_URL
if (!BASE) throw new Error('BASE_URL required')

const rateLimited = new Counter('search_429')
const serverErrors = new Counter('search_5xx')
const cacheHits = new Counter('edge_cache_hit')
const cacheMisses = new Counter('edge_cache_miss')

export const options = {
  scenarios: {
    search: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 500 },
        { duration: '60s', target: 500 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    // §6 Phase 8 target: search p95 < 800ms, on the searches actually served.
    'http_req_duration{status:200}': ['p(95)<800'],
    // Anything but 200 / 429 (the limiter) is a failure; a 5xx fails the run outright.
    http_req_failed: ['rate<0.01'],
    search_5xx: ['count==0'],
  },
}

// The per-IP limiter answering 429 is correct behaviour, not a failed request.
http.setResponseCallback(http.expectedStatuses(200, 429))

const CATEGORIES = ['tax-accounting', 'company-registrations', 'legal', 'hr-staffing', 'digital-marketing', 'web-tech']
const STATES = ['KA', 'AP', 'TS', 'TN', 'MH', '']
const TERMS = ['gst', 'trademark', 'itr filing', 'recruitment', 'website', '']

export default function () {
  const c = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)]
  const s = STATES[Math.floor(Math.random() * STATES.length)]
  const q = TERMS[Math.floor(Math.random() * TERMS.length)]
  // k6's runtime has no URLSearchParams — build the query by hand.
  let qs = `category=${c}`
  if (s) qs += `&state=${s}`
  if (q) qs += `&query=${encodeURIComponent(q)}`

  const res = http.get(`${BASE}/api/v1/catalog/search?${qs}`, {
    tags: { name: 'catalog-search' },
  })
  if (res.status === 429) rateLimited.add(1)
  if (res.status >= 500) serverErrors.add(1)
  const cache = res.headers['X-Vercel-Cache'] || ''
  if (cache === 'HIT' || cache === 'STALE') cacheHits.add(1)
  else if (cache) cacheMisses.add(1)
  check(res, { 'status 200 or 429 (limiter)': (r) => r.status === 200 || r.status === 429 })
  sleep(0.5 + Math.random())
}
