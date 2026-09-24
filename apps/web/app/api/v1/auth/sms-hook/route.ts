/**
 * Supabase Auth SMS Hook — custom SMS delivery endpoint.
 *
 * Configuration (do once per project):
 *   Supabase Dashboard → Auth → Hooks → "Send SMS hook" (HTTPS)
 *   URL: https://<your-domain>/api/v1/auth/sms-hook
 *   Generate the hook secret there and set the SAME value ("v1,whsec_…") as
 *   SEND_SMS_HOOK_SECRET in Vercel. Every request must carry a valid Standard
 *   Webhooks signature (audit H3): unsigned calls could otherwise make AMClub
 *   send an SMS with any text to any number, at AMClub's cost.
 *
 * Provision for production:
 *   MSG91_AUTH_KEY=<your-msg91-auth-key>
 *   MSG91 sender ID and template ID must be pre-approved by DLT.
 *
 * Dev behaviour: without SEND_SMS_HOOK_SECRET the signature is not checked
 * outside production, and without MSG91_AUTH_KEY the OTP is logged to the
 * server console only.
 *
 * Production without the secret (transition only, so this deploy cannot stop
 * phone login): every call logs an error and is held to +91 mobiles, the
 * per-phone limit and a global hourly cap. Once the secret is set, an unsigned
 * or badly signed call is refused.
 */
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyStandardWebhook } from '@/lib/auth/standard-webhook'
import { enforce, limiters } from '@/lib/rate-limit'

const hookSchema = z.object({
  user: z.object({
    id: z.string(),
    phone: z.string().optional(),
  }),
  email_data: z.object({ token: z.string(), token_hash: z.string() }).optional(),
  sms_data: z.object({ message: z.string() }).optional(),
})

/** India only: +91 and a 10-digit mobile number starting 6–9. */
const INDIAN_MOBILE = /^\+?91[6-9]\d{9}$/

export async function POST(request: NextRequest) {
  const raw = await request.text()
  const secret = process.env['SEND_SMS_HOOK_SECRET']
  const unsignedInProduction = !secret && process.env.NODE_ENV === 'production'
  if (secret && !verifyStandardWebhook(secret, request.headers, raw)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }
  if (unsignedInProduction) {
    console.error('[SMS HOOK] SEND_SMS_HOOK_SECRET not configured — unsigned hook call accepted under the transition caps. Set the secret (audit H3).')
  }

  let body: unknown = null
  try {
    body = JSON.parse(raw)
  } catch {
    body = null
  }
  const parsed = hookSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
  }

  const { user, sms_data } = parsed.data
  const phone = user.phone
  const message = sms_data?.message

  if (!phone || !message) {
    return NextResponse.json({ error: 'Missing phone or message' }, { status: 400 })
  }
  if (!INDIAN_MOBILE.test(phone.replace(/[\s-]/g, ''))) {
    return NextResponse.json({ error: 'Unsupported phone number' }, { status: 422 })
  }
  // Backstop for every OTP SMS, including requests made straight to Supabase
  // Auth (which skip /api/v1/auth/otp and its limiter).
  const rl = await enforce(limiters.smsHookPhone, `sms:${phone.replace(/\D/g, '')}`)
  if (!rl.ok) return NextResponse.json({ error: 'Too many codes for this number' }, { status: 429 })
  if (unsignedInProduction) {
    const global = await enforce(limiters.smsHookUnsigned, 'sms:unsigned')
    if (!global.ok) return NextResponse.json({ error: 'Too many codes' }, { status: 429 })
  }

  const authKey = process.env['MSG91_AUTH_KEY']
  const isRealKey = authKey && !['<msg91-auth-key>', 'placeholder', ''].includes(authKey)

  if (!isRealKey) {
    // The OTP + phone must NEVER reach production logs (account-takeover risk if
    // log access leaks). Only echo it to the console in local/dev; in production
    // an unset MSG91 key means SMS cannot be delivered — fail loudly WITHOUT the
    // OTP so login breaks visibly instead of silently logging credentials.
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[SMS HOOK DEV] To: ${phone} | Message: ${message}`)
      return NextResponse.json({ success: true, dev: true })
    }
    console.error('[SMS HOOK] MSG91_AUTH_KEY not configured — OTP not delivered.')
    return NextResponse.json({ error: 'SMS delivery not configured' }, { status: 500 })
  }

  // Production: send via MSG91
  // MSG91 transactional SMS API (Flow-based for DLT compliance)
  // You'll need to create a flow in MSG91 dashboard with the OTP variable.
  try {
    const otpMatch = message.match(/\b(\d{6})\b/)
    const otp = otpMatch?.[1]
    if (!otp) throw new Error('Could not extract OTP from message')

    const res = await fetch('https://api.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authkey: authKey,
      },
      body: JSON.stringify({
        template_id: process.env['MSG91_OTP_TEMPLATE_ID'] ?? '',
        short_url: '0',
        recipients: [{ mobiles: phone.replace('+', ''), otp }],
      }),
      signal: AbortSignal.timeout(8000),
    })

    const data = await res.json()
    if (data.type !== 'success') {
      // The vendor's response stays in our logs, never in the reply.
      console.error('[SMS HOOK] MSG91 error:', data)
      return NextResponse.json({ error: 'SMS delivery failed' }, { status: 502 })
    }

    return NextResponse.json({ success: true })
  } catch (e: unknown) {
    console.error('[SMS HOOK] Error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'SMS delivery error' }, { status: 500 })
  }
}
