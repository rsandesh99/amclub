/**
 * Client → server OTP send. Replaces direct supabase.auth.signInWithOtp calls so
 * the request passes through our rate-limited, captcha-aware proxy
 * (/api/v1/auth/otp). The VERIFY step stays on supabase.auth.verifyOtp client-side.
 */
export type OtpChannel = 'sms' | 'email'

export interface SendOtpResult {
  ok: boolean
  /** Coarse failure reason for mapping to a localized message. */
  code?: 'rate_limited' | 'captcha_failed' | 'send_failed'
}

export async function sendOtp(
  channel: OtpChannel,
  identifier: string,
  captchaToken?: string,
): Promise<SendOtpResult> {
  let res: Response
  try {
    res = await fetch('/api/v1/auth/otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, identifier, captchaToken }),
    })
  } catch {
    return { ok: false, code: 'send_failed' }
  }

  if (res.ok) return { ok: true }
  if (res.status === 429) return { ok: false, code: 'rate_limited' }

  const data = await res.json().catch(() => ({}))
  if (data?.error === 'captcha_failed') return { ok: false, code: 'captcha_failed' }
  return { ok: false, code: 'send_failed' }
}
