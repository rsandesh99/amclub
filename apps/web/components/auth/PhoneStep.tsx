'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'
import { phoneSchema } from '@amclub/shared'

interface PhoneStepProps {
  onSuccess: (phone: string) => void
  emailField?: boolean
  onEmailChange?: (email: string) => void
}

export function PhoneStep({ onSuccess, emailField, onEmailChange }: PhoneStepProps) {
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
    const supabase = createClient()
    const { error: otpError } = await supabase.auth.signInWithOtp({
      phone: normalised,
      options: { shouldCreateUser: true },
    })
    setLoading(false)

    if (otpError) {
      setError(otpError.message)
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
          <span className="inline-flex h-11 items-center rounded-l-[10px] border border-r-0 border-gray-300 bg-gray-50 px-3 text-sm text-foreground-secondary select-none">
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

      <Button onClick={handleSend} loading={loading} className="w-full">
        {t('send_otp')}
      </Button>
    </div>
  )
}
