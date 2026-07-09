/**
 * Phase 8 §2(c) — RFQ create + fan-out burst.
 *
 * 25 VUs (one per prepared buyer) firing 2 RFQs each in a tight burst:
 * 50 RFQ creations, each triggering synchronous provider fan-out (matching +
 * rfq_matches inserts + notifications). Stays under the 10-per-10min/user
 * limiter. Measures the heaviest single write path a real user can trigger.
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

const rateLimited = new Counter('rfq_429')

export const options = {
  scenarios: {
    rfqBurst: {
      executor: 'per-vu-iterations',
      vus: 25,
      iterations: 2,
      maxDuration: '2m',
    },
  },
  thresholds: {
    'http_req_duration{name:rfq-create}': ['p(95)<2000'],
    http_req_failed: ['rate<0.01'],
  },
}

export default function () {
  const buyer = ctx.buyers[(__VU - 1) % ctx.buyers.length]
  const res = http.post(
    `${BASE}/api/v1/rfq`,
    JSON.stringify({
      category_slug: ctx.categorySlug,
      title: `Load test RFQ ${__VU}-${__ITER} — GST filing for small manufacturer`,
      details: { work_type: 'GST filing', notes: 'k6 load test — cleaned up by loadtest-cleanup.ts' },
    }),
    {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${buyer.token}` },
      tags: { name: 'rfq-create' },
    },
  )
  if (res.status === 429) rateLimited.add(1)
  check(res, { 'rfq 200/201': (r) => r.status === 200 || r.status === 201 })
  sleep(Math.random() * 2)
}
