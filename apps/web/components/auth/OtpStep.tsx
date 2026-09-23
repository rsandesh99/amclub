'use client'

import { useState, useEffect, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import type { RequestOtp } from './AuthPanel'

const OTP_LENGTH = 6

interface OtpStepProps {
  /** Phone (E.164) when channel is 'sms'. */
  phone?: string
  /** Email when channel is 'email'. */
  email?: string
  /** Verification channel. Defaults to 'sms' for backward compatibility. */
  channel?: 'sms' | 'email'
  /** Re-sends the OTP via the rate-limited / captcha proxy. */
  requestOtp: RequestOtp
  onSuccess: () => void
  /** Back to the identifier-entry step. */
  onChangePhone: () => void
}

export function OtpStep({ phone, email, channel = 'sms', requestOtp, onSuccess, onChangePhone }: OtpStepProps) {
  const t = useTranslations('auth')
  const tErr = useTranslations('errors')

  const target = channel === 'email' ? (email ?? '') : (phone ?? '')

  const [otp, setOtp] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [focused, setFocused] = useState(false)
  const [resendCountdown, setResendCountdown] = useState(30)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // Single-flight guard: auto-submit (typing, paste, SMS autofill) and the
  // button can all fire for the same code — only one verify runs at a time.
  const verifyingRef = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (resendCountdown <= 0) return
    const timer = setTimeout(() => setResendCountdown((c) => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [resendCountdown])

  /** Accepts typed digits, any-length paste ("Your OTP is 123456"), and
   *  one-time-code autofill — keeps the first 6 digits. */
  function handleChange(value: string) {
    const code = value.replace(/\D/g, '').slice(0, OTP_LENGTH)
    setOtp(code)
    if (code.length === OTP_LENGTH) void verify(code)
  }

  async function verify(code: string) {
    if (verifyingRef.current || code.length !== OTP_LENGTH) return
    verifyingRef.current = true
    setError('')
    setLoading(true)
    try {
      const supabase = createClient()
      const { error: verifyError } =
        channel === 'email'
          ? await supabase.auth.verifyOtp({ email: target, token: code, type: 'email' })
          : await supabase.auth.verifyOtp({ phone: target, token: code, type: 'sms' })

      if (verifyError) {
        setError(verifyError.message.includes('expired') ? tErr('otp_expired') : tErr('invalid_otp'))
        setOtp('')
        inputRef.current?.focus()
        return
      }

      onSuccess()
    } catch {
      setError(tErr('invalid_otp'))
    } finally {
      verifyingRef.current = false
      setLoading(false)
    }
  }

  async function resend() {
    setError('')
    const result = await requestOtp(channel, target)
    if (!result.ok) {
      setError(tErr(result.code === 'rate_limited' ? 'rate_limited' : result.code === 'captcha_failed' ? 'captcha_failed' : 'otp_send_failed'))
      return
    }
    setResendCountdown(30)
    setOtp('')
    inputRef.current?.focus()
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-foreground">{t('otp_sent_to', { target })}</p>
        <button
          type="button"
          onClick={onChangePhone}
          className="inline-flex min-h-[44px] items-center text-sm text-primary underline underline-offset-2 hover:no-underline"
        >
          {channel === 'email' ? t('change_email') : t('change_phone')}
        </button>
      </div>

      {/* ONE real input (autofill, paste, screen readers) drawn as 6 fluid
          cells — the grid shrinks with the card, so 320 px screens fit. */}
      <div className="relative">
        <div className="grid grid-cols-6 gap-1.5 sm:gap-2" aria-hidden="true">
          {Array.from({ length: OTP_LENGTH }, (_, i) => {
            const active = focused && (i === otp.length || (i === OTP_LENGTH - 1 && otp.length === OTP_LENGTH))
            return (
              <div
                key={i}
                className={cn(
                  'flex h-12 min-w-0 items-center justify-center rounded-button border bg-surface text-lg font-semibold tabular-nums text-foreground',
                  error ? 'border-danger' : active ? 'border-primary ring-2 ring-primary/20' : 'border-border',
                )}
              >
                {otp[i] ?? ''}
              </div>
            )
          })}
        </div>
        <input
          ref={inputRef}
          id="otp-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={OTP_LENGTH}
          value={otp}
          onChange={(e) => handleChange(e.target.value)}
          onPaste={(e) => {
            e.preventDefault()
            handleChange(e.clipboardData.getData('text'))
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          readOnly={loading}
          aria-label={t('otp_label')}
          aria-invalid={!!error}
          aria-describedby={error ? 'otp-error' : undefined}
          className="absolute inset-0 h-full w-full cursor-text border-0 bg-transparent text-transparent caret-transparent outline-none selection:bg-transparent"
        />
      </div>

      {error && (
        <p id="otp-error" role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <Button
        onClick={() => void verify(otp)}
        loading={loading}
        disabled={otp.length !== OTP_LENGTH}
        className="w-full"
      >
        {t('verify_otp')}
      </Button>

      <div className="text-center text-sm text-foreground-secondary">
        {t('otp_not_received')}{' '}
        {resendCountdown > 0 ? (
          <span>{t('otp_resend_in', { seconds: resendCountdown })}</span>
        ) : (
          <button type="button" onClick={resend} className="text-primary underline underline-offset-2 hover:no-underline">
            {t('otp_resend')}
          </button>
        )}
      </div>
    </div>
  )
}
