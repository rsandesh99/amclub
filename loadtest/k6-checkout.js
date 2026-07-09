/**
 * Phase 8 §2(b) — 50 concurrent checkouts (simulate mode).
 *
 * 50 VUs over 25 prepared buyers (2 VUs/buyer); ~7s pacing keeps each buyer
 * under the 20-checkouts/min/user limiter so the numbers measure the money
 * path, not the limiter. Every iteration = POST /checkout (idempotency-keyed
 * session) → POST /checkout/simulate (materialises the order like a webhook).
 *
 * Prep first: tsx apps/web/scripts/loadtest-prep.ts
 * ALWAYS after: tsx apps/web/scripts/loadtest-cleanup.ts
 */
import http from 'k6/http'
import { check, sleep } from 'k6'
import { Counter } from 'k6/metrics'

const BASE = __ENV.BASE_URL
if (!BASE) throw new Error('BASE_URL required')
const ctx = JSON.parse(open('./.ctx.json'))

const rateLimited = new Counter('checkout_429')

export const options = {
  scenarios: {
    checkout: {
      executor: 'constant-vus',
      vus: 50,
      duration: '60s',
    },
  },
  thresholds: {
    // Checkout target: p95 < 1.5s per request; zero 5xx.
    'http_req_duration{name:checkout}': ['p(95)<1500'],
    'http_req_duration{name:simulate}': ['p(95)<1500'],
    http_req_failed: ['rate<0.01'],
  },
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

export default function () {
  const buyer = ctx.buyers[(__VU - 1) % ctx.buyers.length]
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` }

  const co = http.post(
    `${BASE}/api/v1/checkout`,
    JSON.stringify({ packageId: ctx.packageId, idempotencyKey: uuid() }),
    { headers, tags: { name: 'checkout' } },
  )
  if (co.status === 429) rateLimited.add(1)
  const ok = check(co, { 'checkout 200': (r) => r.status === 200 })

  if (ok) {
    const body = co.json()
    if (body.simulated) {
      const sim = http.post(
        `${BASE}/api/v1/checkout/simulate`,
        JSON.stringify({ checkoutSessionId: body.checkoutSessionId }),
        { headers, tags: { name: 'simulate' } },
      )
      if (sim.status === 429) rateLimited.add(1)
      check(sim, { 'simulate 200 + orderId': (r) => r.status === 200 && !!r.json('orderId') })
    }
  }
  sleep(6 + Math.random() * 2)
}
