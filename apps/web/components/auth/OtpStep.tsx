'use client'

import { useState, useEffect, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

interface OtpStepProps {
  /** Phone (E.164) when channel is 'sms'. */
  phone?: string
  /** Email when channel is 'email'. */
  email?: string
  /** Verification channel. Defaults to 'sms' for backward compatibility. */
  channel?: 'sms' | 'email'
  onSuccess: () => void
  /** Back to the identifier-entry step. */
  onChangePhone: () => void
}

export function OtpStep({ phone, email, channel = 'sms', onSuccess, onChangePhone }: OtpStepProps) {
  const t = useTranslations('auth')
  const tErr = useTranslations('errors')

  const target = channel === 'email' ? (email ?? '') : (phone ?? '')

  const [otp, setOtp] = useState(['', '', '', '', '', ''])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [resendCountdown, setResendCountdown] = useState(30)
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    inputRefs.current[0]?.focus()
  }, [])

  useEffect(() => {
    if (resendCountdown <= 0) return
    const timer = setTimeout(() => setResendCountdown((c) => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [resendCountdown])

  function handleInput(index: number, value: string) {
    if (!/^\d*$/.test(value)) return
    const digit = value.slice(-1)
    const next = [...otp]
    next[index] = digit
    setOtp(next)
    if (digit && index < 5) inputRefs.current[index + 1]?.focus()
    if (next.every(Boolean)) {
      verify(next.join(''))
    }
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
    }
  }

  function handlePaste(e: React.ClipboardEvent) {
    const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (text.length === 6) {
      setOtp(text.split(''))
      verify(text)
    }
  }

  async function verify(code: string) {
    setError('')
    setLoading(true)
    const supabase = createClient()
    const { error: verifyError } =
      channel === 'email'
        ? await supabase.auth.verifyOtp({ email: target, token: code, type: 'email' })
        : await supabase.auth.verifyOtp({ phone: target, token: code, type: 'sms' })
    setLoading(false)

    if (verifyError) {
      setError(verifyError.message.includes('expired') ? tErr('otp_expired') : tErr('invalid_otp'))
      setOtp(['', '', '', '', '', ''])
      inputRefs.current[0]?.focus()
      return
    }

    onSuccess()
  }

  async function resend() {
    const supabase = createClient()
    if (channel === 'email') {
      await supabase.auth.signInWithOtp({ email: target, options: { shouldCreateUser: true } })
    } else {
      await supabase.auth.signInWithOtp({ phone: target, options: { shouldCreateUser: true } })
    }
    setResendCountdown(30)
    setOtp(['', '', '', '', '', ''])
    inputRefs.current[0]?.focus()
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-foreground">{t('otp_sent_to', { target })}</p>
        <button
          onClick={onChangePhone}
          className="mt-1 text-xs text-primary underline underline-offset-2 hover:no-underline"
        >
          {channel === 'email' ? t('change_email') : t('change_phone')}
        </button>
      </div>

      <div className="flex gap-2" onPaste={handlePaste}>
        {otp.map((digit, i) => (
          <input
            key={i}
            ref={(el) => { inputRefs.current[i] = el }}
            type="text"
            inputMode="numeric"
            maxLength={1}
            value={digit}
            onChange={(e) => handleInput(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            className="h-12 w-12 rounded-[10px] border border-gray-300 bg-surface text-center text-lg font-semibold focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
            aria-label={`OTP digit ${i + 1}`}
          />
        ))}
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <Button
        onClick={() => verify(otp.join(''))}
        loading={loading}
        disabled={otp.some((d) => !d)}
        className="w-full"
      >
        {t('verify_otp')}
      </Button>

      <div className="text-center text-sm text-foreground-secondary">
        {t('otp_not_received')}{' '}
        {resendCountdown > 0 ? (
          <span>{t('otp_resend_in', { seconds: resendCountdown })}</span>
        ) : (
          <button onClick={resend} className="text-primary underline underline-offset-2 hover:no-underline">
            {t('otp_resend')}
          </button>
        )}
      </div>
    </div>
  )
}
