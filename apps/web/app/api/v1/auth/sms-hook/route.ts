/**
 * Supabase Auth SMS Hook — custom SMS delivery endpoint.
 *
 * Configuration (do once per project):
 *   Supabase Dashboard → Auth → Hooks → "Send SMS hook"
 *   URL: https://<your-domain>/api/v1/auth/sms-hook
 *   (Optional: add a shared secret as a Bearer token and verify below)
 *
 * Provision for production:
 *   MSG91_AUTH_KEY=<your-msg91-auth-key>
 *   MSG91 sender ID and template ID must be pre-approved by DLT.
 *
 * Dev behaviour: if MSG91_AUTH_KEY is missing, OTP is logged to the
 * server console only (visible in Vercel function logs / terminal).
 *
 * ⚠ This endpoint handles OTPs — keep it server-side only, rate-limit it,
 *   and never log OTPs in production.
 */
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'

const hookSchema = z.object({
  user: z.object({
    id: z.string(),
    phone: z.string().optional(),
  }),
  email_data: z.object({ token: z.string(), token_hash: z.string() }).optional(),
  sms_data: z.object({ message: z.string() }).optional(),
})

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null)
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
    })

    const data = await res.json()
    if (data.type !== 'success') {
      console.error('[SMS HOOK] MSG91 error:', data)
      return NextResponse.json({ error: 'SMS delivery failed', detail: data }, { status: 502 })
    }

    return NextResponse.json({ success: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'SMS delivery error'
    console.error('[SMS HOOK] Error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
