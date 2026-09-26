import 'server-only'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { NextResponse } from 'next/server'
import { reportOpsError } from '@/lib/observability'

/**
 * Reusable rate limiting (§2.5 / API conventions — "rate-limited (Upstash) on
 * auth & search"). Backed by Upstash Redis REST.
 *
 * Design notes:
 *  - When Upstash isn't configured (local/dev, or env missing) every limiter is
 *    a no-op that allows the request. Production must set the env vars.
 *  - Limiters are sliding-window. Pick the key carefully at the call site:
 *    per-IP for unauthenticated routes, per-user for authed routes, and
 *    per-identifier (+ per-IP) for OTP send.
 *  - To add a limiter for a new Phase-5 endpoint: add one line to `build(...)`
 *    below and call `enforce(limiters.x, key)` in the route. Nothing else.
 *  - Probing a limiter in production: CDN-cached GETs (e.g. /catalog/search,
 *    `s-maxage=60`) never reach the function for a repeated URL, so give each
 *    probe request a unique query param or the limiter never runs.
 *  - Upstash trouble never becomes a 500 (audit M36). Each call waits at most
 *    UPSTASH_TIMEOUT_MS. On an error or a timeout an 'open' limiter allows the
 *    request; a 'local' limiter (anything that costs money per call — OTP / SMS,
 *    KYC, voice, paid model calls — or guards against brute force) keeps
 *    enforcing the same window in this instance's memory. Either way the outage
 *    is logged and reported to Sentry, at most once a minute per limiter, and the
 *    instance skips Upstash for that limiter for OUTAGE_BACKOFF_MS before trying again.
 */

const url = process.env['UPSTASH_REDIS_REST_URL']
const token = process.env['UPSTASH_REDIS_REST_TOKEN']
const redis = url && token ? new Redis({ url, token }) : null

if (!redis && process.env.NODE_ENV === 'production') {
  // Visible once at cold start — never silently ship prod without limits.
  console.warn('[rate-limit] UPSTASH_REDIS_REST_URL/TOKEN not set — rate limiting is DISABLED.')
}

/** The longest one limiter call may add to a request (the library default was 5 s). */
export const UPSTASH_TIMEOUT_MS = 1000

type Window = `${number} ${'ms' | 's' | 'm' | 'h' | 'd'}`

/** What a limiter does while Upstash errors or times out. */
type OutageMode = 'open' | 'local'

export interface Limiter {
  readonly prefix: string
  readonly outage: OutageMode
  readonly tokens: number
  readonly windowMs: number
  readonly rl: Ratelimit
}

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const

function windowMs(window: Window): number {
  const [n, unit] = window.split(' ') as [string, keyof typeof UNIT_MS]
  return Number(n) * UNIT_MS[unit]
}

function build(tokens: number, window: Window, prefix: string, outage: OutageMode = 'open'): Limiter | null {
  if (!redis) return null
  return {
    prefix,
    outage,
    tokens,
    windowMs: windowMs(window),
    rl: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(tokens, window),
      prefix,
      analytics: false,
      // On timeout the library resolves { success: true, reason: 'timeout' }; enforce() treats it as an outage.
      timeout: UPSTASH_TIMEOUT_MS,
    }),
  }
}

/**
 * Named limiters. Baselines: generous for public/authed traffic, tight on the
 * money- and bill-impacting paths (OTP → SMS cost, KYC → paid API). The fourth
 * argument 'local' keeps a limiter enforcing in memory while Upstash is down.
 */
export const limiters = {
  /** Generic unauthenticated per-IP cap. */
  publicIp: build(100, '1 m', 'rl:public'),
  /** Generic authenticated per-user cap. */
  authed: build(1000, '1 m', 'rl:authed'),
  /** Catalog search — unauthenticated, protects DB. */
  search: build(60, '1 m', 'rl:search'),
  /** OTP send per identifier (phone/email) — SMS/email bill-drain guard. */
  otp: build(5, '15 m', 'rl:otp', 'local'),
  /** OTP send per IP — blunts spraying many identifiers from one host. */
  otpIp: build(15, '15 m', 'rl:otp-ip', 'local'),
  /** Supabase SMS hook — every OTP SMS per number, however it was requested (audit H3). */
  smsHookPhone: build(5, '15 m', 'rl:sms-hook', 'local'),
  /** Global cap on OTP SMS while production runs the hook without SEND_SMS_HOOK_SECRET (transition only). */
  smsHookUnsigned: build(120, '1 h', 'rl:sms-hook-unsigned', 'local'),
  /** Paid KYC verification (GSTIN/bank) per user. */
  kyc: build(8, '1 m', 'rl:kyc', 'local'),
  /** Checkout creation per user (idempotency already prevents double-charge). */
  checkout: build(20, '1 m', 'rl:checkout'),
  /** RFQ creation per user — fan-out is work; keep it sane. */
  rfqCreate: build(10, '10 m', 'rl:rfq-create'),
  /** Quote submission per provider — one quote per RFQ anyway. */
  quoteSubmit: build(30, '1 m', 'rl:quote-submit'),
  /** Review submit / reply / flag per user — abuse + review-bomb guard. */
  reviewWrite: build(20, '10 m', 'rl:review-write'),
  // ADR-030 §6 — DPDP requests from web / mobile (per user; one open per kind is enforced separately).
  privacyRequest: build(5, '1 h', 'rl:privacy-request'),
  /** Coupon code validation per user — blunts code-guessing/brute force. */
  couponValidate: build(30, '1 m', 'rl:coupon-validate', 'local'),
  /** Admin mutations (suspend, resolve dispute, commission change, …) per user. */
  adminMutation: build(60, '1 m', 'rl:admin-mutation'),
  /** Voice RFQ parse per user — every call hits PAID APIs (Sarvam + LLM).
   *  Burst guard; pair with voiceParseHourly for the spend budget. */
  voiceParse: build(3, '1 m', 'rl:voice-parse', 'local'),
  /** Voice RFQ parse per user, hourly spend budget. */
  voiceParseHourly: build(15, '1 h', 'rl:voice-parse-h', 'local'),
  /** S1.1 quote extraction per provider — one paid routine-tier call each; burst + hourly pair (voice-parse precedent). */
  quoteExtract: build(5, '1 m', 'rl:quote-extract', 'local'),
  quoteExtractHourly: build(40, '1 h', 'rl:quote-extract-h', 'local'),
  /** S2.3 — the support chat: one bounded classifier call per turn. */
  supportChat: build(10, '1 m', 'rl:support-chat', 'local'),
  supportChatHourly: build(60, '1 h', 'rl:support-chat-h', 'local'),
  /** S3.1 — the procurement assistant composer (each message is one routed model call + maybe a parse). */
  procurementChat: build(10, '1 m', 'rl:procurement-chat', 'local'),
  procurementChatHourly: build(60, '1 h', 'rl:procurement-chat-h', 'local'),
  /** S1.2 compare pointers per buyer — one reasoning-tier call per cache miss. */
  comparePointers: build(6, '10 m', 'rl:compare-pointers', 'local'),
  /** S1.8 document intake per buyer — one frontier-tier vision/text call each; burst + hourly pair. */
  documentExtract: build(5, '1 m', 'rl:document-extract', 'local'),
  documentExtractHourly: build(30, '1 h', 'rl:document-extract-h', 'local'),
  // Experience v3 E11 — the view beacon: one count per visitor (IP + UA) per subject per day, and an IP cap.
  viewOnce: build(1, '1 d', 'rl:view-once'),
  viewIp: build(120, '1 m', 'rl:view-ip'),
  // E11 FR-11.4 — the quote preview (pure computation; typed per keystroke-ish, debounced on the client).
  quotePreview: build(60, '1 m', 'rl:quote-preview'),
  /** E8b — order messages per user (a conversation, not a firehose). */
  orderMessage: build(20, '1 m', 'rl:order-message'),
} as const

export interface RateLimitResult {
  ok: boolean
  /** Seconds until the window resets (only meaningful when !ok). */
  retryAfter: number
}

const ALLOW: RateLimitResult = { ok: true, retryAfter: 0 }

// ─── outage fallback (M36) ───────────────────────────────────────────────────

/** Per-instance fixed windows for 'local' limiters while Upstash is unreachable. */
const localWindows = new Map<string, { count: number; resetAt: number }>()
const LOCAL_MAX_KEYS = 10_000

function enforceLocally(limiter: Limiter, key: string, now = Date.now()): RateLimitResult {
  const id = `${limiter.prefix}:${key}`
  let w = localWindows.get(id)
  if (!w || w.resetAt <= now) {
    if (localWindows.size >= LOCAL_MAX_KEYS) {
      for (const [k, v] of localWindows) if (v.resetAt <= now) localWindows.delete(k)
      // Still full of live windows: drop the oldest entries rather than grow without bound.
      while (localWindows.size >= LOCAL_MAX_KEYS) localWindows.delete(localWindows.keys().next().value as string)
    }
    w = { count: 0, resetAt: now + limiter.windowMs }
    localWindows.set(id, w)
  }
  if (w.count >= limiter.tokens) return { ok: false, retryAfter: Math.max(1, Math.ceil((w.resetAt - now) / 1000)) }
  w.count++
  return ALLOW
}

const lastReported = new Map<string, number>()
const REPORT_EVERY_MS = 60_000
/** After an outage, this instance skips Upstash for a while, so a hung Upstash costs 1 s once, not on every request. */
const outageUntil = new Map<string, number>()
const OUTAGE_BACKOFF_MS = 15_000

function onOutage(limiter: Limiter, key: string, cause: unknown): RateLimitResult {
  const now = Date.now()
  outageUntil.set(limiter.prefix, now + OUTAGE_BACKOFF_MS)
  if (now - (lastReported.get(limiter.prefix) ?? 0) >= REPORT_EVERY_MS) {
    lastReported.set(limiter.prefix, now)
    // Upstash errors end with ", command was: [...]", which carries the key (a phone, an IP): never log or report it.
    const detail = (cause instanceof Error ? cause.message : String(cause)).split(', command was')[0]!.slice(0, 200)
    console.error(`[rate-limit] Upstash unavailable for ${limiter.prefix} — ${limiter.outage === 'local' ? 'enforcing in memory' : 'allowing'}: ${detail}`)
    reportOpsError(new Error(`upstash unavailable: ${detail}`), 'rate-limit.outage', {
      tags: { limiter: limiter.prefix, outage_mode: limiter.outage },
      level: limiter.outage === 'local' ? 'error' : 'warning',
    })
  }
  return limiter.outage === 'local' ? enforceLocally(limiter, key, now) : ALLOW
}

/**
 * Run a limiter for `key`. A null limiter (Upstash unconfigured) allows all.
 * Never throws: an Upstash error or timeout is an outage (see the header).
 */
export async function enforce(limiter: Limiter | null, key: string): Promise<RateLimitResult> {
  if (!limiter) return ALLOW
  if (Date.now() < (outageUntil.get(limiter.prefix) ?? 0)) {
    return limiter.outage === 'local' ? enforceLocally(limiter, key) : ALLOW
  }
  let res: Awaited<ReturnType<Ratelimit['limit']>>
  try {
    res = await limiter.rl.limit(key)
  } catch (e) {
    return onOutage(limiter, key, e)
  }
  if (res.reason === 'timeout') return onOutage(limiter, key, new Error(`upstash timeout after ${UPSTASH_TIMEOUT_MS} ms`))
  return {
    ok: res.success,
    retryAfter: res.success ? 0 : Math.max(1, Math.ceil((res.reset - Date.now()) / 1000)),
  }
}

/** Standard 429 response with a Retry-After header. */
export function tooManyRequests(retryAfter = 60): NextResponse {
  return NextResponse.json(
    { error: 'Too many requests. Please wait a moment and try again.' },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  )
}

/** Best-effort client IP behind Vercel's proxy. */
export function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0]!.trim()
  return request.headers.get('x-real-ip')?.trim() || '0.0.0.0'
}

/**
 * S1.1 — the ONE Upstash client, shared with agent-core's budget counters
 * (createRedisBudget) so a bounded model call never constructs a second
 * connection. null when Upstash is not configured (budgets then no-op).
 */
export function getRedis(): Redis | null {
  return redis
}
