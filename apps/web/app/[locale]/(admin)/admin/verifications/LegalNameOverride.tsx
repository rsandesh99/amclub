'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

/** E10 — override the GST-locked legal name (pending applications; audit-logged). */
export function LegalNameOverride({ providerId, current }: { providerId: string; current: string }) {
  const t = useTranslations('onboarding_v3')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(current)
  const [reason, setReason] = useState('')
  const [err, setErr] = useState(false)
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="text-xs text-primary underline-offset-2 hover:underline">{t('admin_override')}</button>
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      onSubmit={async (e) => {
        e.preventDefault()
        const res = await fetch(`/api/v1/admin/verifications/${providerId}/legal-name`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ legalName: name, reason }) }).catch(() => null)
        if (res?.ok) { setOpen(false); router.refresh() } else setErr(true)
      }}
    >
      <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 max-w-xs text-sm" aria-label={t('admin_override')} />
      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('admin_override_reason')} className="h-8 max-w-xs text-sm" />
      <Button type="submit" size="sm">{t('admin_override_save')}</Button>
      {err && <span className="text-xs text-danger">{t('admin_override_failed')}</span>}
    </form>
  )
}
