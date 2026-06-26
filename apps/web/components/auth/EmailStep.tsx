'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { createClient } from '@/lib/supabase/client'

interface EmailStepProps {
  /** Called with the email after a code has been sent. */
  onSuccess: (email: string) => void
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function EmailStep({ onSuccess }: EmailStepProps) {
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
    const supabase = createClient()
    // Supabase email OTP. shouldCreateUser:true so new emails sign up too.
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: value,
      options: { shouldCreateUser: true },
    })
    setLoading(false)
    if (otpError) {
      setError(otpError.message)
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
      <Button onClick={handleSend} loading={loading} className="w-full">
        {t('send_code')}
      </Button>
    </div>
  )
}
