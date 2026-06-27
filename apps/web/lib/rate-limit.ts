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
  /** Paid KYC verification (GSTIN/bank) per user. */
  kyc: build(8, '1 m', 'rl:kyc'),
  /** Checkout creation per user (idempotency already prevents double-charge). */
  checkout: build(20, '1 m', 'rl:checkout'),
  /** RFQ creation per user — fan-out is work; keep it sane. */
  rfqCreate: build(10, '10 m', 'rl:rfq-create'),
  /** Quote submission per provider — one quote per RFQ anyway. */
  quoteSubmit: build(30, '1 m', 'rl:quote-submit'),
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
