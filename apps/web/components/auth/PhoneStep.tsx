'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { phoneSchema } from '@amclub/shared'
import type { RequestOtp } from './AuthPanel'

interface PhoneStepProps {
  onSuccess: (phone: string) => void
  /** Sends the OTP via the rate-limited / captcha proxy. */
  requestOtp: RequestOtp
  /** False while the captcha is still solving (when captcha is enabled). */
  captchaReady?: boolean
  emailField?: boolean
  onEmailChange?: (email: string) => void
}

export function PhoneStep({ onSuccess, requestOtp, captchaReady = true, emailField, onEmailChange }: PhoneStepProps) {
  const t = useTranslations('auth')
  const tErr = useTranslations('errors')

  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSend() {
    setError('')
    const parsed = phoneSchema.safeParse(phone.replace(/\s/g, ''))
    if (!parsed.success) {
      setError(tErr('invalid_phone'))
      return
    }

    const normalised = phone.startsWith('+91') ? phone : `+91${phone.replace(/^0/, '')}`

    setLoading(true)
    const result = await requestOtp('sms', normalised)
    setLoading(false)

    if (!result.ok) {
      setError(tErr(result.code === 'rate_limited' ? 'rate_limited' : result.code === 'captcha_failed' ? 'captcha_failed' : 'otp_send_failed'))
      return
    }

    if (emailField && onEmailChange) onEmailChange(email)
    onSuccess(normalised)
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="phone">{t('phone_label')}</Label>
        <div className="flex">
          <span className="inline-flex h-11 items-center rounded-l-[10px] border border-r-0 border-border bg-muted px-3 text-sm text-foreground-secondary select-none">
            +91
          </span>
          <Input
            id="phone"
            type="tel"
            inputMode="numeric"
            placeholder={t('phone_placeholder')}
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
            className="rounded-l-none"
            autoComplete="tel-national"
            error={error}
          />
        </div>
        <p className="text-xs text-foreground-secondary">{t('phone_hint')}</p>
      </div>

      {emailField && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="email">{t('email_label')}</Label>
          <Input
            id="email"
            type="email"
            placeholder={t('email_placeholder')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </div>
      )}

      <Button onClick={handleSend} loading={loading} disabled={!captchaReady} className="w-full">
        {captchaReady ? t('send_otp') : t('verifying_human')}
      </Button>
    </div>
  )
}
