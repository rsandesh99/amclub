'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

type Lang = 'en' | 'hi'

export interface ProviderProfileInitial {
  displayName: string
  about: string
  city: string
  languages: Lang[]
  capacityPaused: boolean
}

/** Edits a provider's public-facing profile only (no KYC fields). PATCHes the
 *  safe-fields settings route, which never resets verification status. */
export function ProviderProfileForm({ initial }: { initial: ProviderProfileInitial }) {
  const t = useTranslations('profile')
  const tCommon = useTranslations('common')
  const tFields = useTranslations('msme_signup')
  const router = useRouter()

  const [form, setForm] = useState<ProviderProfileInitial>(initial)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  function update(patch: Partial<ProviderProfileInitial>) {
    setForm((s) => ({ ...s, ...patch }))
    setSaved(false)
  }

  function toggleLang(lang: Lang) {
    const has = form.languages.includes(lang)
    // Never allow zero languages.
    if (has && form.languages.length === 1) return
    update({ languages: has ? form.languages.filter((l) => l !== lang) : [...form.languages, lang] })
  }

  async function save() {
    if (!form.displayName.trim()) {
      setError(t('save_failed'))
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/v1/profile/provider/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: form.displayName.trim(),
          about: form.about.trim() || undefined,
          city: form.city.trim() || undefined,
          languages: form.languages,
          capacityPaused: form.capacityPaused,
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(typeof d.error === 'string' ? d.error : t('save_failed'))
      }
      setSaved(true)
      router.refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('save_failed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-card border border-border bg-surface p-5 shadow-card space-y-4">
        <h2 className="text-base font-semibold">{t('public_profile')}</h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="displayName">{t('display_name_label')}</Label>
          <Input id="displayName" value={form.displayName} onChange={(e) => update({ displayName: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="about">{t('about_label')}</Label>
          <Textarea id="about" value={form.about} onChange={(e) => update({ about: e.target.value })} maxLength={2000} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="city">{tFields('city_label')}</Label>
          <Input id="city" value={form.city} onChange={(e) => update({ city: e.target.value })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>{t('languages_label')}</Label>
          <div className="flex gap-2">
            {(['en', 'hi'] as Lang[]).map((lang) => (
              <button
                key={lang}
                type="button"
                onClick={() => toggleLang(lang)}
                className={`rounded-full border px-4 py-1.5 text-sm font-medium transition-colors ${
                  form.languages.includes(lang)
                    ? 'border-primary bg-primary text-white'
                    : 'border-border text-foreground hover:border-primary'
                }`}
              >
                {lang === 'en' ? 'English' : 'हिंदी'}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="rounded-card border border-border bg-surface p-5 shadow-card">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={form.capacityPaused}
            onChange={(e) => update({ capacityPaused: e.target.checked })}
            className="mt-0.5 h-4 w-4 rounded border-border text-primary focus:ring-primary/30"
          />
          <span>
            <span className="block text-sm font-medium">{t('capacity_pause_label')}</span>
            <span className="block text-xs text-foreground-secondary">{t('capacity_pause_hint')}</span>
          </span>
        </label>
      </section>

      <p className="rounded-button bg-warning/10 px-3 py-2 text-xs text-warning">{t('kyc_locked_note')}</p>

      {error && <p className="text-sm text-danger">{error}</p>}
      {saved && <p className="text-sm text-success">{t('save_success')}</p>}
      <div className="flex justify-end">
        <Button onClick={save} loading={loading}>{tCommon('save')}</Button>
      </div>
    </div>
  )
}
