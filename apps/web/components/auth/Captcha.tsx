'use client'

import { Turnstile } from '@marsidev/react-turnstile'

const SITE_KEY = process.env['NEXT_PUBLIC_TURNSTILE_SITE_KEY']

/** True when a Turnstile site key is configured (prod). When false the captcha
 *  is skipped entirely (local/dev) and the OTP proxy works without a token. */
export function captchaEnabled(): boolean {
  return !!SITE_KEY
}

interface CaptchaProps {
  /** Receives a fresh token on solve, or null on error/expiry/reset. */
  onToken: (token: string | null) => void
}

/**
 * Cloudflare Turnstile widget for the OTP/signup path. The matching secret key
 * is held by Supabase (Auth → CAPTCHA); the token we produce is forwarded to
 * Supabase via signInWithOtp({ options: { captchaToken } }) in the proxy.
 * Remount via a `key` prop to force a fresh token (tokens are single-use).
 */
export function Captcha({ onToken }: CaptchaProps) {
  if (!SITE_KEY) return null
  return (
    <Turnstile
      siteKey={SITE_KEY}
      options={{ theme: 'light', size: 'flexible' }}
      onSuccess={(token) => onToken(token)}
      onError={() => onToken(null)}
      onExpire={() => onToken(null)}
    />
  )
}
