'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { INDIAN_STATES } from '@/lib/constants/india'

export interface MsmeProfileInitial {
  fullName: string
  businessName: string
  sector: string
  stateCode: string
  city: string
  udyamNumber: string
  gstin: string
  preferredLocale: string
}

/** Edit form for an existing MSME profile. POSTs to the same upsert route the
 *  signup wizard uses (idempotent by user_id) — never resets anything. */
export function MsmeProfileForm({ initial }: { initial: MsmeProfileInitial }) {
  const t = useTranslations('msme_signup')
  const tProfile = useTranslations('profile')
  const tAuth = useTranslations('auth')
  const tCommon = useTranslations('common')
  const router = useRouter()

  const [form, setForm] = useState<MsmeProfileInitial>(initial)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  function update(patch: Partial<MsmeProfileInitial>) {
    setForm((s) => ({ ...s, ...patch }))
    setSaved(false)
  }

  async function save() {
    if (!form.fullName.trim() || !form.businessName.trim()) {
      setError(t('err_name_business'))
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/v1/profile/msme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName: form.fullName,
          businessName: form.businessName,
          sector: form.sector || undefined,
          state: form.stateCode || undefined,
          city: form.city || undefined,
          udyamNumber: form.udyamNumber || undefined,
          gstin: form.gstin || undefined,
          preferredLocale: form.preferredLocale === 'hi' ? 'hi' : 'en',
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(typeof d.error === 'string' ? d.error : tProfile('save_failed'))
      }
      setSaved(true)
      router.refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : tProfile('save_failed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-card border border-border bg-surface p-5 shadow-card space-y-4">
        <h2 className="text-base font-semibold">{tProfile('personal_info')}</h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="fullName">{tAuth('name_label')}</Label>
          <Input id="fullName" value={form.fullName} onChange={(e) => update({ fullName: e.target.value })} autoComplete="name" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="locale">{tProfile('language_pref')}</Label>
          <Select id="locale" value={form.preferredLocale} onChange={(e) => update({ preferredLocale: e.target.value })}>
            <option value="en">English</option>
            <option value="hi">हिंदी</option>
          </Select>
        </div>
      </section>

      <section className="rounded-card border border-border bg-surface p-5 shadow-card space-y-4">
        <h2 className="text-base font-semibold">{tProfile('business_info')}</h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="businessName">{tAuth('business_name_label')}</Label>
          <Input id="businessName" value={form.businessName} onChange={(e) => update({ businessName: e.target.value })} autoComplete="organization" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sector">{t('sector_label')}</Label>
          <Select id="sector" value={form.sector} onChange={(e) => update({ sector: e.target.value })} placeholder="—">
            <option value="manufacturing">{t('sector_manufacturing')}</option>
            <option value="trade">{t('sector_trade')}</option>
            <option value="services">{t('sector_services')}</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="stateCode">{t('state_label')}</Label>
          <Select id="stateCode" value={form.stateCode} onChange={(e) => update({ stateCode: e.target.value })} placeholder="—">
            {INDIAN_STATES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="city">{t('city_label')}</Label>
          <Input id="city" value={form.city} onChange={(e) => update({ city: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="udyam">{t('udyam_label')}</Label>
          <Input id="udyam" placeholder="UDYAM-XX-00-0000000" value={form.udyamNumber} onChange={(e) => update({ udyamNumber: e.target.value.toUpperCase() })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="gstin">{t('gstin_label')}</Label>
          <Input id="gstin" placeholder="29ABCDE1234F1Z5" value={form.gstin} onChange={(e) => update({ gstin: e.target.value.toUpperCase() })} />
        </div>
      </section>

      {error && <p className="text-sm text-danger">{error}</p>}
      {saved && <p className="text-sm text-success">{tProfile('save_success')}</p>}
      <div className="flex justify-end">
        <Button onClick={save} loading={loading}>{tCommon('save')}</Button>
      </div>
    </div>
  )
}
