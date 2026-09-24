import 'server-only'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import { NextResponse } from 'next/server'

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
 */

const url = process.env['UPSTASH_REDIS_REST_URL']
const token = process.env['UPSTASH_REDIS_REST_TOKEN']
const redis = url && token ? new Redis({ url, token }) : null

if (!redis && process.env.NODE_ENV === 'production') {
  // Visible once at cold start — never silently ship prod without limits.
  console.warn('[rate-limit] UPSTASH_REDIS_REST_URL/TOKEN not set — rate limiting is DISABLED.')
}

type Window = `${number} ${'ms' | 's' | 'm' | 'h' | 'd'}`

function build(tokens: number, window: Window, prefix: string): Ratelimit | null {
  if (!redis) return null
  return new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(tokens, window),
    prefix,
    analytics: false,
  })
}

/**
 * Named limiters. Baselines: generous for public/authed traffic, tight on the
 * money- and bill-impacting paths (OTP → SMS cost, KYC → paid API).
 */
export const limiters = {
  /** Generic unauthenticated per-IP cap. */
  publicIp: build(100, '1 m', 'rl:public'),
  /** Generic authenticated per-user cap. */
  authed: build(1000, '1 m', 'rl:authed'),
  /** Catalog search — unauthenticated, protects DB. */
  search: build(60, '1 m', 'rl:search'),
  /** OTP send per identifier (phone/email) — SMS/email bill-drain guard. */
  otp: build(5, '15 m', 'rl:otp'),
  /** OTP send per IP — blunts spraying many identifiers from one host. */
  otpIp: build(15, '15 m', 'rl:otp-ip'),
  /** Supabase SMS hook — every OTP SMS per number, however it was requested (audit H3). */
  smsHookPhone: build(5, '15 m', 'rl:sms-hook'),
  /** Global cap on OTP SMS while production runs the hook without SEND_SMS_HOOK_SECRET (transition only). */
  smsHookUnsigned: build(120, '1 h', 'rl:sms-hook-unsigned'),
  /** Paid KYC verification (GSTIN/bank) per user. */
  kyc: build(8, '1 m', 'rl:kyc'),
  /** Checkout creation per user (idempotency already prevents double-charge). */
  checkout: build(20, '1 m', 'rl:checkout'),
  /** RFQ creation per user — fan-out is work; keep it sane. */
  rfqCreate: build(10, '10 m', 'rl:rfq-create'),
  /** Quote submission per provider — one quote per RFQ anyway. */
  quoteSubmit: build(30, '1 m', 'rl:quote-submit'),
  /** Review submit / reply / flag per user — abuse + review-bomb guard. */
  reviewWrite: build(20, '10 m', 'rl:review-write'),
  /** Coupon code validation per user — blunts code-guessing/brute force. */
  couponValidate: build(30, '1 m', 'rl:coupon-validate'),
  /** Admin mutations (suspend, resolve dispute, commission change, …) per user. */
  adminMutation: build(60, '1 m', 'rl:admin-mutation'),
  /** Voice RFQ parse per user — every call hits PAID APIs (Sarvam + LLM).
   *  Burst guard; pair with voiceParseHourly for the spend budget. */
  voiceParse: build(3, '1 m', 'rl:voice-parse'),
  /** Voice RFQ parse per user, hourly spend budget. */
  voiceParseHourly: build(15, '1 h', 'rl:voice-parse-h'),
  /** S1.1 quote extraction per provider — one paid routine-tier call each; burst + hourly pair (voice-parse precedent). */
  quoteExtract: build(5, '1 m', 'rl:quote-extract'),
  quoteExtractHourly: build(40, '1 h', 'rl:quote-extract-h'),
  /** S2.3 — the support chat: one bounded classifier call per turn. */
  supportChat: build(10, '1 m', 'rl:support-chat'),
  supportChatHourly: build(60, '1 h', 'rl:support-chat-h'),
  /** S3.1 — the procurement assistant composer (each message is one routed model call + maybe a parse). */
  procurementChat: build(10, '1 m', 'rl:procurement-chat'),
  procurementChatHourly: build(60, '1 h', 'rl:procurement-chat-h'),
  /** S1.2 compare pointers per buyer — one reasoning-tier call per cache miss. */
  comparePointers: build(6, '10 m', 'rl:compare-pointers'),
  /** S1.8 document intake per buyer — one frontier-tier vision/text call each; burst + hourly pair. */
  documentExtract: build(5, '1 m', 'rl:document-extract'),
  documentExtractHourly: build(30, '1 h', 'rl:document-extract-h'),
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

/** Run a limiter for `key`. A null limiter (Upstash unconfigured) allows all. */
export async function enforce(limiter: Ratelimit | null, key: string): Promise<RateLimitResult> {
  if (!limiter) return { ok: true, retryAfter: 0 }
  const { success, reset } = await limiter.limit(key)
  return {
    ok: success,
    retryAfter: success ? 0 : Math.max(1, Math.ceil((reset - Date.now()) / 1000)),
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
