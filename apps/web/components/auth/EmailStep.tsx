'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { RequestOtp } from './AuthPanel'

interface EmailStepProps {
  /** Called with the email after a code has been sent. */
  onSuccess: (email: string) => void
  /** Sends the OTP via the rate-limited / captcha proxy. */
  requestOtp: RequestOtp
  /** False while the captcha is still solving (when captcha is enabled). */
  captchaReady?: boolean
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function EmailStep({ onSuccess, requestOtp, captchaReady = true }: EmailStepProps) {
  const t = useTranslations('auth')
  const tErr = useTranslations('errors')
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSend() {
    setError('')
    const value = email.trim().toLowerCase()
    if (!EMAIL_RE.test(value)) {
      setError(tErr('invalid_email'))
      return
    }
    setLoading(true)
    const result = await requestOtp('email', value)
    setLoading(false)
    if (!result.ok) {
      setError(tErr(result.code === 'rate_limited' ? 'rate_limited' : result.code === 'captcha_failed' ? 'captcha_failed' : 'otp_send_failed'))
      return
    }
    onSuccess(value)
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">{t('email_label')}</Label>
        <Input
          id="email"
          type="email"
          placeholder={t('email_placeholder')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          autoComplete="email"
          error={error}
        />
        <p className="text-xs text-foreground-secondary">{t('email_hint')}</p>
      </div>
      <Button onClick={handleSend} loading={loading} disabled={!captchaReady} className="w-full">
        {captchaReady ? t('send_code') : t('verifying_human')}
      </Button>
    </div>
  )
}
