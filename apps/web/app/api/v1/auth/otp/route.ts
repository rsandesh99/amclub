import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createPublicClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests, clientIp } from '@/lib/rate-limit'

/**
 * Server-side OTP-send proxy. The client used to call supabase.auth.signInWithOtp
 * directly, which left our rate limiter out of the path. Routing the SEND through
 * here lets us cap abuse (SMS/email bill-drain) per identifier AND per IP before
 * Supabase (and MSG91) ever runs. The VERIFY step stays client-side.
 *
 * Captcha: when Supabase CAPTCHA is enabled, `captchaToken` (Cloudflare Turnstile)
 * is forwarded and validated by Supabase. Enumeration-safe: signInWithOtp returns
 * a uniform result whether or not the identifier already exists.
 */
const bodySchema = z.discriminatedUnion('channel', [
  z.object({
    channel: z.literal('sms'),
    // Client normalizes to E.164 (+91XXXXXXXXXX) before sending.
    identifier: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Invalid phone'),
    captchaToken: z.string().optional(),
  }),
  z.object({
    channel: z.literal('email'),
    identifier: z.string().email(),
    captchaToken: z.string().optional(),
  }),
])

export async function POST(request: NextRequest) {
  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  }
  const { channel, identifier, captchaToken } = parsed.data

  // Tight limits: per-IP (blunts spraying many identifiers) and per-identifier
  // (blunts hammering one number/email). Either tripping → 429.
  const ip = clientIp(request)
  const ipLimit = await enforce(limiters.otpIp, `otp:ip:${ip}`)
  if (!ipLimit.ok) return tooManyRequests(ipLimit.retryAfter)
  const idLimit = await enforce(limiters.otp, `otp:${channel}:${identifier.toLowerCase()}`)
  if (!idLimit.ok) return tooManyRequests(idLimit.retryAfter)

  // Only include captchaToken when present (exactOptionalPropertyTypes).
  const options = { shouldCreateUser: true, ...(captchaToken ? { captchaToken } : {}) }
  const supabase = createPublicClient()
  const { error } = await supabase.auth.signInWithOtp(
    channel === 'email' ? { email: identifier, options } : { phone: identifier, options },
  )

  if (error) {
    // Full detail server-side only. Surface a coarse, non-enumerating message;
    // flag captcha failures so the client can refresh the widget.
    console.error('[auth/otp send]', { channel, status: error.status, message: error.message })
    const isCaptcha = /captcha/i.test(error.message)
    return NextResponse.json(
      { error: isCaptcha ? 'captcha_failed' : 'send_failed' },
      { status: isCaptcha ? 400 : 502 },
    )
  }

  return NextResponse.json({ success: true })
}
