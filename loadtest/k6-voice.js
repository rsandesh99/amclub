/**
 * Phase 8 §2(d) — voice-parse endpoint AT its rate-limit ceiling.
 *
 * One user fires 12 requests in ~70s against a 3/min + 15/h per-user budget.
 * PASS = the limiter does its job: ≤ a handful of 200s, the rest clean 429s,
 * zero 5xx. If `voice_429s` stays 0 the limiter is NOT active (Upstash env
 * missing) — that is a finding, not a pass.
 *
 * Costs: each 200 is one real Sarvam+LLM call (~₹0.02) when live keys are set;
 * the 1s silence probe keeps STT trivially short.
 *
 * Prep first: tsx apps/web/scripts/loadtest-prep.ts
 */
import http from 'k6/http'
import { check, sleep } from 'k6'
import { Counter } from 'k6/metrics'

const BASE = __ENV.BASE_URL
if (!BASE) throw new Error('BASE_URL required')
const ctx = JSON.parse(open('./.ctx.json'))
const wav = open('./.probe.wav', 'b')

const ok200 = new Counter('voice_200s')
const limited = new Counter('voice_429s')
const server5xx = new Counter('voice_5xx')

export const options = {
  scenarios: {
    ceiling: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 12,
      maxDuration: '3m',
    },
  },
  thresholds: {
    voice_5xx: ['count==0'],
    // The whole point: prove the paid-API cap actually bites.
    voice_429s: ['count>0'],
  },
}

export default function () {
  const buyer = ctx.buyers[0]
  const res = http.post(
    `${BASE}/api/v1/rfq/voice-parse`,
    {
      audio: http.file(wav, 'probe.wav', 'audio/wav'),
      duration_ms: '1000',
    },
    { headers: { Authorization: `Bearer ${buyer.token}` }, tags: { name: 'voice-parse' } },
  )
  if (res.status === 200) ok200.add(1)
  else if (res.status === 429) limited.add(1)
  else if (res.status >= 500) server5xx.add(1)
  check(res, { 'no 5xx': (r) => r.status < 500 })
  sleep(5)
}
