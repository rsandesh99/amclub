'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { GroupedSection } from '@/components/ui-v3/GroupedList'
import { Banner } from '@/components/ui-v3/Feedback'

/**
 * E3 provider controls (N11 / N12): "next available" + capacity (display only)
 * and the logo, which shows publicly only after AMClub approves it.
 */
export function ProviderTrustSettings({
  initial,
}: {
  initial: { nextAvailableOn: string | null; capacitySlots: number; logoStatus: 'none' | 'pending' | 'approved' | 'rejected'; logoUrl: string | null }
}) {
  const t = useTranslations('trust_settings')
  const router = useRouter()
  const [date, setDate] = useState(initial.nextAvailableOn ?? '')
  const [slots, setSlots] = useState(String(initial.capacitySlots))
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'positive' | 'critical'; text: string } | null>(null)
  const [logoState, setLogoState] = useState(initial.logoStatus)

  async function save() {
    setSaving(true)
    setMsg(null)
    const res = await fetch('/api/v1/profile/provider/availability', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nextAvailableOn: date || null, capacitySlots: Number(slots) }),
    })
    setSaving(false)
    setMsg(res.ok ? { tone: 'positive', text: t('saved') } : { tone: 'critical', text: t('save_failed') })
    if (res.ok) router.refresh()
  }

  async function upload(file: File) {
    setMsg(null)
    const fd = new FormData()
    fd.append('file', file)
    const res = await fetch('/api/v1/profile/provider/logo', { method: 'POST', body: fd })
    const d = (await res.json().catch(() => ({}))) as { error?: string }
    if (res.ok) setLogoState('pending')
    else setMsg({ tone: 'critical', text: d.error === 'too_large' ? t('logo_too_large') : t('logo_failed') })
  }

  return (
    <GroupedSection header={t('title')} footer={t('footer')}>
      <div className="space-y-3 px-4 py-4">
        <label className="block">
          <span className="t-subhead font-medium text-foreground">{t('next_available')}</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="field-control mt-1" />
          <span className="t-footnote mt-1 block text-foreground-secondary">{t('next_available_hint')}</span>
        </label>
        <label className="block">
          <span className="t-subhead font-medium text-foreground">{t('capacity')}</span>
          <input type="number" inputMode="numeric" min={1} max={50} value={slots} onChange={(e) => setSlots(e.target.value)} className="field-control mt-1 w-28" />
          <span className="t-footnote mt-1 block text-foreground-secondary">{t('capacity_hint')}</span>
        </label>
        <button type="button" onClick={save} disabled={saving} className="h-11 rounded-button bg-primary px-5 text-sm font-semibold text-primary-foreground disabled:opacity-60">
          {saving ? t('saving') : t('save')}
        </button>
      </div>
      <div className="space-y-2 px-4 py-4">
        <p className="t-subhead font-medium text-foreground">{t('logo')}</p>
        {initial.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- the provider's own approved logo
          <img src={initial.logoUrl} alt="" width={64} height={64} className="h-16 w-16 rounded-card object-cover" />
        )}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          aria-label={t('logo_upload')}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f) }}
          className="block text-sm"
        />
        <p className="t-footnote text-foreground-secondary">
          {logoState === 'pending' ? t('logo_pending') : logoState === 'rejected' ? t('logo_rejected') : t('logo_hint')}
        </p>
      </div>
      {msg && <div className="px-4 pb-4"><Banner tone={msg.tone}>{msg.text}</Banner></div>}
    </GroupedSection>
  )
}
