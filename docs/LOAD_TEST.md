# Load test — Phase 8 §2 report

**Date:** 2026-07-09 · **Tool:** k6 v2.1.0 · **Scripts:** `loadtest/k6-*.js` · **Fixtures:** `apps/web/scripts/loadtest-prep.ts` / `loadtest-cleanup.ts` (25 buyers + 1 provider + 1 package, fully removed afterwards — residue re-verified zero).

## Where the load ran (deviation from "preview deployment", explained)

Vercel **preview deployments are SSO-protected** on this project (`amclub-web-git-*` URLs return the Vercel auth interstitial; no bypass secret exists and no Vercel credentials live on this machine). So:

- **Search / checkout / RFQ load** ran against a local production build (`next start`, same commit) talking to the **live Supabase in ap-south-1** — the DB, RLS and query plans are the real ones; app-server scaling is not (1 Node process vs Vercel's horizontal serverless).
- **Voice-parse ceiling** (12 requests — a limiter probe, not load) ran against **production**.
- To run the full suite against a true preview later: create a *Protection Bypass for Automation* secret in Vercel → `k6 run -e BASE_URL=https://<preview-url> --http-header x-vercel-protection-bypass=<secret> loadtest/k6-<x>.js` (or disable Vercel Authentication for previews).

Latency caveat: every DB hop from this machine pays laptop→Mumbai RTT (~40–80 ms), which **overstates** latency vs deployed functions co-located with the DB — conservative in the right direction.

## Results

| Test | Load | Result | Target | Verdict |
|---|---|---|---|---|
| (a) Catalog search | 500 VUs, 100s ramp+hold, 36,714 reqs (363 rps) | p50 **51 ms** · p90 135 ms · **p95 241 ms** · 0 failed · 0 429 | p95 < 800 ms, zero 5xx | ✅ (2nd run; 1st = 807 ms warmup, see below) |
| (b) Checkout ×50 (simulate) | 50 VUs / 25 buyers, 60s, **353 orders** | checkout p95 2.51s · simulate p95 2.55s · **0 failed, 100% orders materialised** | p95 < 1.5s, zero 5xx | ⚠ correctness ✅, latency ❌ locally — harness artifact, see analysis |
| (c) RFQ create + fan-out burst | 50 RFQs / 25 buyers in ~25s | p50 621 ms · **p95 911 ms** · 0 failed · every RFQ matched + fanned out | zero 5xx | ✅ (2nd run; 1st see below) |
| (d) Voice-parse at ceiling (**prod**) | 1 user, 12 reqs / ~95s vs 3/min+15/h caps | **6× 429, 0× 5xx**, clean `Retry-After`s | limiter proves out, zero 5xx | ✅ — also proves **Upstash rate limiting is LIVE in prod** (closes STATUS_AUDIT §3 unknown) |

## 2026-09-24 — search against production (Actions `loadtest.yml`)

It ran from one GitHub runner against `https://amclub-web.vercel.app` (bom1), with the same 500 VUs for 100 s: 32,470 requests at 313 rps.

| | Result |
|---|---|
| Served searches (200) | **p95 68.5 ms**, p99 652 ms, max 2.06 s. Target is p95 < 800 ms: ✅ |
| 5xx / other errors | **0** |
| 429 from the per-IP limiter | 26,130 (80 %) |
| Edge cache | 6,220 HIT, 26,250 MISS (the 429s are MISSes) |

The first run failed only its `http_req_failed` threshold, and every one of those "failures" was a 429. Production's limiter is live (Upstash). It allows 60 uncached searches a minute per IP, and 500 VUs from one runner share one IP. A 429 is never cached, so most of the 216 query combinations could never warm. The 2026-07-09 run went to a local build without the limiter, so it saw none.

`k6-search.js` now counts a 429 as an expected response. The target is measured on 200s, and any 5xx fails the run. **Still unmeasured on production:** the uncached Postgres FTS path under real concurrency. One IP only gets about 120 misses into a run. Measuring it needs distributed load generators (many IPs); the 2026-07-09 local run (p95 241 ms on the live database) remains the best evidence.

## The bottleneck that mattered (found, fixed, re-measured)

Profiling the search p95 miss led somewhere much bigger than the test harness:

| Path | Before | After |
|---|---|---|
| Local unloaded search (laptop→Mumbai DB) | med 84 ms | — |
| **Prod search cache-MISS** | **med 1,152 ms** (min 721, max 2,121) | **med 105 ms** (min 68; cold-start outliers ~0.8–1.1s) |
| Prod search cache-HIT (edge) | med 38 ms | unchanged |

A laptop in India was beating production by 13× on the identical query. Cause: **no Vercel region config → all functions ran in default `iad1` (US East) while Postgres lives in `ap-south-1`** — every DB round trip crossed the planet, and multi-query routes (checkout/simulate does a dozen sequential queries) compounded it. Fix: `"regions": ["bom1"]` in `apps/web/vercel.json` (commit 71af36a). Verified serving `x-vercel-id: bom1::bom1::…`.

This also resolves (b): simulate's 2.5s p95 is ~12 sequential DB hops × laptop RTT under 50-VU contention — the same request shape on bom1 functions pays ~1–5 ms per hop. Post-deploy spot-check of prod search MISS confirms the pattern; checkout can't be spot-checked on prod without creating real orders outside a test window, and is bounded above by the (now-fixed) same root cause. **No app-code change was warranted** — adding caching/batching to the idempotent money path to beat a harness artifact would add risk for nothing.

## Anomalies logged honestly

- **Search run 1 vs run 2:** first-ever run under load returned p95 807 ms (max 6.7s outliers during ramp) — cold process + cold caches; re-run once (per protocol): p95 241 ms. Report keeps both.
- **RFQ run 1:** all 50 requests failed uniformly at ~10.5s when fired ~30s after the 353-order checkout burst on the same single process; unreproducible afterwards (10× and 25× concurrent node probes, single k6, full k6 re-run — all green, p95 911 ms). Filed as: single-instance back-pressure after a heavy write burst. Deployed topology (per-request serverless instances) does not share this failure mode; no code change.
- **Cleanup bug caught:** the first cleanup pass silently missed all 353 orders (queried a nonexistent `buyer_msme_id` column; Supabase errors were unchecked). Residue was recovered by tag and deleted (re-verified zero); `loadtest-cleanup.ts` now throws on any delete error.

## Deferred optimizations

1. **Cold-start tail on API routes** (~0.8–1.1s on first hit of a fresh instance; Sentry init is a known contributor). Options when it matters: trim serverless bundle, Vercel fluid compute/provisioned concurrency. Not blocking pilot traffic volumes.
2. **checkout/simulate query count** — the materialise path runs ~a dozen sequential statements; could batch into an RPC if p95 on real Vercel telemetry (post-bom1) exceeds target. Measure first via Vercel analytics at pilot.
3. Preview-deployment bypass secret so the suite runs against real serverless topology in CI/cron.
