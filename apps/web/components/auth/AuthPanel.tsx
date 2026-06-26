'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { PhoneStep } from './PhoneStep'
import { EmailStep } from './EmailStep'
import { OtpStep } from './OtpStep'
import { GoogleButton } from './GoogleButton'

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
 */
export function AuthPanel({ onAuthenticated, googleRedirectTo = '/app' }: AuthPanelProps) {
  const t = useTranslations('auth')
  const tCommon = useTranslations('common')
  const [method, setMethod] = useState<'phone' | 'email'>('phone')
  const [step, setStep] = useState<'input' | 'otp'>('input')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')

  if (step === 'otp') {
    return method === 'phone' ? (
      <OtpStep phone={phone} channel="sms" onSuccess={onAuthenticated} onChangePhone={() => setStep('input')} />
    ) : (
      <OtpStep email={email} channel="email" onSuccess={onAuthenticated} onChangePhone={() => setStep('input')} />
    )
  }

  return (
    <div className="flex flex-col gap-5">
      {method === 'phone' ? (
        <PhoneStep onSuccess={(p) => { setPhone(p); setStep('otp') }} />
      ) : (
        <EmailStep onSuccess={(e) => { setEmail(e); setStep('otp') }} />
      )}

      <button
        type="button"
        onClick={() => setMethod((m) => (m === 'phone' ? 'email' : 'phone'))}
        className="text-center text-sm text-primary underline underline-offset-2 hover:no-underline"
      >
        {method === 'phone' ? t('use_email_instead') : t('use_phone_instead')}
      </button>

      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-gray-200" />
        <span className="text-xs text-foreground-secondary">{tCommon('or')}</span>
        <div className="h-px flex-1 bg-gray-200" />
      </div>

      <GoogleButton redirectTo={googleRedirectTo} className="w-full" />
    </div>
  )
}
