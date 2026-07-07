'use client'

import { useCallback, useState } from 'react'
import { useTranslations } from 'next-intl'
import { PhoneStep } from './PhoneStep'
import { EmailStep } from './EmailStep'
import { OtpStep } from './OtpStep'
import { GoogleButton } from './GoogleButton'
import { Captcha, captchaEnabled } from './Captcha'
import { sendOtp, type OtpChannel, type SendOtpResult } from '@/lib/auth/otp-client'

/** Sends an OTP for the given identifier, returning a coarse result. Injected
 *  into the steps so they don't touch the captcha token directly. */
export type RequestOtp = (channel: OtpChannel, identifier: string) => Promise<SendOtpResult>

interface AuthPanelProps {
  /** Called once the user has verified an OTP (phone or email). */
  onAuthenticated: () => void
  /** Where Google OAuth returns the user after the callback exchange. */
  googleRedirectTo?: string
}

/**
 * Unified auth entry: phone OTP (primary) + email OTP + Google, sharing one
 * OTP step. Reused on /login and inside the MSME / provider signup wizards so
 * every surface offers the same methods. §2.2/§3.3.
 *
 * OTP send is routed through /api/v1/auth/otp (rate-limited + captcha). This
 * panel owns the Turnstile token: it's single-use, so we remount the widget
 * (via `captchaNonce`) after every send to get a fresh one.
 */
export function AuthPanel({ onAuthenticated, googleRedirectTo = '/app' }: AuthPanelProps) {
  const t = useTranslations('auth')
  const tCommon = useTranslations('common')
  const [method, setMethod] = useState<'phone' | 'email'>('phone')
  const [step, setStep] = useState<'input' | 'otp'>('input')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')

  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [captchaNonce, setCaptchaNonce] = useState(0)
  const captchaReady = !captchaEnabled() || !!captchaToken

  const requestOtp = useCallback<RequestOtp>(
    async (channel, identifier) => {
      const result = await sendOtp(channel, identifier, captchaToken ?? undefined)
      // Token is single-use — always refresh after an attempt (success or fail).
      if (captchaEnabled()) {
        setCaptchaToken(null)
        setCaptchaNonce((n) => n + 1)
      }
      return result
    },
    [captchaToken],
  )

  return (
    <div className="flex flex-col gap-5">
      {step === 'otp' ? (
        method === 'phone' ? (
          <OtpStep phone={phone} channel="sms" requestOtp={requestOtp} onSuccess={onAuthenticated} onChangePhone={() => setStep('input')} />
        ) : (
          <OtpStep email={email} channel="email" requestOtp={requestOtp} onSuccess={onAuthenticated} onChangePhone={() => setStep('input')} />
        )
      ) : (
        <>
          {method === 'phone' ? (
            <PhoneStep
              requestOtp={requestOtp}
              captchaReady={captchaReady}
              onSuccess={(p) => { setPhone(p); setStep('otp') }}
              onSwitchToEmail={() => setMethod('email')}
            />
          ) : (
            <EmailStep requestOtp={requestOtp} captchaReady={captchaReady} onSuccess={(e) => { setEmail(e); setStep('otp') }} />
          )}

          <button
            type="button"
            onClick={() => setMethod((m) => (m === 'phone' ? 'email' : 'phone'))}
            className="text-center text-sm text-primary underline underline-offset-2 hover:no-underline"
          >
            {method === 'phone' ? t('use_email_instead') : t('use_phone_instead')}
          </button>

          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-muted" />
            <span className="text-xs text-foreground-secondary">{tCommon('or')}</span>
            <div className="h-px flex-1 bg-muted" />
          </div>

          <GoogleButton redirectTo={googleRedirectTo} className="w-full" />

          {/* DPDP consent + contract formation line (B2) — every auth surface. */}
          <p className="text-center text-xs leading-relaxed text-foreground-secondary">
            {t.rich('consent_line', {
              terms: (chunks) => (
                <a href="/terms" target="_blank" rel="noopener" className="underline underline-offset-2 hover:text-primary">
                  {chunks}
                </a>
              ),
              privacy: (chunks) => (
                <a href="/privacy" target="_blank" rel="noopener" className="underline underline-offset-2 hover:text-primary">
                  {chunks}
                </a>
              ),
            })}
          </p>
        </>
      )}

      {/* Single Turnstile instance, shared by the send + resend paths. */}
      <Captcha key={captchaNonce} onToken={setCaptchaToken} />
    </div>
  )
}
