import { NextResponse } from 'next/server'
import { rateLimiterRedisActive } from '@/lib/rate-limit'

/**
 * TEMPORARY diagnostic — booleans only, NO secret values. Compares the
 * request-time env read against the module-load Upstash client state, so we can
 * tell "runtime never received the vars" from "module-load read them in the
 * wrong context". Remove once rate limiting is confirmed active.
 * (Note: a leading-underscore folder is non-routable in Next, hence /debug/.)
 */
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json({
    hasUrl: !!process.env['UPSTASH_REDIS_REST_URL'],
    hasToken: !!process.env['UPSTASH_REDIS_REST_TOKEN'],
    redisActive: rateLimiterRedisActive,
    runtime: process.env['NEXT_RUNTIME'] ?? 'nodejs',
  })
}
