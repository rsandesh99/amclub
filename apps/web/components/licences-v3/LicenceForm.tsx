'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { LICENCE_TYPE_KEYS, type LicenceType } from '@amclub/shared'
import { useRouter } from '@/i18n/navigation'
import { useAnalytics } from '@/components/providers/posthog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Picker } from '@/components/ui-v3/Picker'

/**
 * E9b FR-9.5 — add a licence by hand (type, number, issued, expiry, authority,
 * certificate). The server validates (licenceCreateSchema); the certificate
 * goes to the private bucket after the row exists.
 */
export function LicenceForm() {
  const t = useTranslations('licences_v3')
  const router = useRouter()
  const analytics = useAnalytics()
  const [type, setType] = useState<LicenceType | ''>('')
  const [number, setNumber] = useState('')
  const [issuedOn, setIssuedOn] = useState('')
  const [expiresOn, setExpiresOn] = useState('')
  const [authority, setAuthority] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!type) { setError(t('err_type')); return }
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/v1/me/licences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenceType: type, ...(number.trim() ? { number: number.trim() } : {}), ...(issuedOn ? { issuedOn } : {}), ...(expiresOn ? { expiresOn } : {}), ...(authority.trim() ? { authority: authority.trim() } : {}) }),
      })
      const j = (await res.json().catch(() => ({}))) as { licence?: { id: string } }
      if (!res.ok || !j.licence) throw new Error()
      if (file) {
        const fd = new FormData()
        fd.append('file', file)
        const up = await fetch(`/api/v1/me/licences/${j.licence.id}/certificate`, { method: 'POST', body: fd })
        if (!up.ok) setError(t('err_certificate'))
      }
      analytics.capture('licence_added', { device: 'web', source: 'manual' })
      setType(''); setNumber(''); setIssuedOn(''); setExpiresOn(''); setAuthority(''); setFile(null)
      router.refresh()
    } catch {
      setError(t('err_save'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-card border border-border bg-surface p-4 shadow-card" data-testid="licence-form">
      <h2 className="t-headline">{t('add_heading')}</h2>
      <Picker id="lic-type" label={t('type_label')} placeholder={t('type_placeholder')} value={type || null} options={LICENCE_TYPE_KEYS.map((k) => ({ value: k, label: t(`type_${k}`) }))} onChange={(v) => setType((v ?? '') as LicenceType | '')} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1"><Label htmlFor="lic-number">{t('number_label')}</Label><Input id="lic-number" value={number} maxLength={64} onChange={(e) => setNumber(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="lic-authority">{t('authority_label')}</Label><Input id="lic-authority" value={authority} maxLength={120} onChange={(e) => setAuthority(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="lic-issued">{t('issued_label')}</Label><Input id="lic-issued" type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="lic-expires">{t('expires_label')}</Label><Input id="lic-expires" type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} /></div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="lic-cert">{t('certificate_label')}</Label>
        <input id="lic-cert" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm" />
        <p className="t-footnote text-foreground-secondary">{t('certificate_hint')}</p>
      </div>
      {error && <p className="text-sm text-danger" role="alert">{error}</p>}
      <Button type="submit" disabled={busy}>{busy ? t('saving') : t('save')}</Button>
    </form>
  )
}

/** Remove (soft delete) one licence. */
export function RemoveLicenceButton({ id }: { id: string }) {
  const t = useTranslations('licences_v3')
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        if (!window.confirm(t('remove_confirm'))) return
        setBusy(true)
        await fetch(`/api/v1/me/licences/${id}`, { method: 'DELETE' }).catch(() => null)
        setBusy(false)
        router.refresh()
      }}
      className="t-footnote text-foreground-secondary underline-offset-2 hover:underline"
    >
      {t('remove')}
    </button>
  )
}

/** The buyer's finished registration order: add the certificate the provider recorded to "My licences". */
export function AddFromOrderButton({ orderId }: { orderId: string }) {
  const t = useTranslations('licences_v3')
  const router = useRouter()
  const analytics = useAnalytics()
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle')
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="secondary"
        disabled={state === 'busy'}
        data-testid="licence-add-from-order"
        onClick={async () => {
          setState('busy')
          const res = await fetch('/api/v1/me/licences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromOrderId: orderId }) }).catch(() => null)
          if (res?.ok || res?.status === 409) {
            analytics.capture('licence_added', { device: 'web', source: 'order' })
            router.refresh()
            setState('idle')
          } else setState('error')
        }}
      >
        {t('add_from_order')}
      </Button>
      {state === 'error' && <span className="t-footnote text-danger">{t('err_save')}</span>}
    </span>
  )
}

/** The provider records the certificate a registration order produced. */
export function RecordFactsForm({ orderId, initial }: { orderId: string; initial: { licenceType: LicenceType; number: string; issuedOn: string | null; expiresOn: string | null; authority: string | null } | null }) {
  const t = useTranslations('licences_v3')
  const router = useRouter()
  const [type, setType] = useState<LicenceType | ''>(initial?.licenceType ?? '')
  const [number, setNumber] = useState(initial?.number ?? '')
  const [issuedOn, setIssuedOn] = useState(initial?.issuedOn ?? '')
  const [expiresOn, setExpiresOn] = useState(initial?.expiresOn ?? '')
  const [authority, setAuthority] = useState(initial?.authority ?? '')
  const [msg, setMsg] = useState<'saved' | 'error' | null>(null)
  return (
    <form
      data-testid="licence-record-facts"
      className="space-y-3 rounded-card border border-border bg-surface p-4 shadow-card"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!type || !number.trim()) { setMsg('error'); return }
        const res = await fetch(`/api/v1/orders/${orderId}/licence-facts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ licenceType: type, number: number.trim(), ...(issuedOn ? { issuedOn } : {}), ...(expiresOn ? { expiresOn } : {}), ...(authority.trim() ? { authority: authority.trim() } : {}) }),
        }).catch(() => null)
        setMsg(res?.ok ? 'saved' : 'error')
        if (res?.ok) router.refresh()
      }}
    >
      <h2 className="t-headline">{t('record_heading')}</h2>
      <p className="t-footnote text-foreground-secondary">{t('record_hint')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Picker id="rf-type" label={t('type_label')} placeholder={t('type_placeholder')} value={type || null} options={LICENCE_TYPE_KEYS.map((k) => ({ value: k, label: t(`type_${k}`) }))} onChange={(v) => setType((v ?? '') as LicenceType | '')} />
        <div className="space-y-1"><Label htmlFor="rf-number">{t('number_label')}</Label><Input id="rf-number" value={number} maxLength={64} onChange={(e) => setNumber(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="rf-issued">{t('issued_label')}</Label><Input id="rf-issued" type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} /></div>
        <div className="space-y-1"><Label htmlFor="rf-expires">{t('expires_label')}</Label><Input id="rf-expires" type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} /></div>
        <div className="space-y-1 sm:col-span-2"><Label htmlFor="rf-authority">{t('authority_label')}</Label><Input id="rf-authority" value={authority} maxLength={120} onChange={(e) => setAuthority(e.target.value)} /></div>
      </div>
      {msg === 'saved' && <p className="t-footnote text-success">{t('record_saved')}</p>}
      {msg === 'error' && <p className="t-footnote text-danger" role="alert">{t('err_save')}</p>}
      <Button type="submit">{t('record_save')}</Button>
    </form>
  )
}
