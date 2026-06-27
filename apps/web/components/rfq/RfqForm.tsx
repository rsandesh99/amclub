'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import type { RfqTemplateField } from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

export interface RfqCategoryOption {
  slug: string
  name: string
  fields: RfqTemplateField[]
}

const DRAFT_KEY = 'amclub_rfq_draft'

interface DraftState {
  categorySlug: string
  title: string
  details: Record<string, string>
  budgetMin: string
  budgetMax: string
  neededBy: string
}

const EMPTY: DraftState = { categorySlug: '', title: '', details: {}, budgetMin: '', budgetMax: '', neededBy: '' }

export function RfqForm({ categories }: { categories: RfqCategoryOption[] }) {
  const t = useTranslations('rfq')
  const locale = useLocale()
  const router = useRouter()

  const [s, setS] = useState<DraftState>({ ...EMPTY })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [restored, setRestored] = useState(false)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY)
      if (raw) { setS({ ...EMPTY, ...JSON.parse(raw) }); setRestored(true); setTimeout(() => setRestored(false), 3000) }
    } catch {}
  }, [])
  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(s)) } catch {}
  }, [s])

  const category = categories.find((c) => c.slug === s.categorySlug)

  function setField(name: string, value: string) {
    setS((prev) => ({ ...prev, details: { ...prev.details, [name]: value } }))
  }

  function label(f: RfqTemplateField): string {
    return locale === 'hi' ? f.label_hi : f.label_en
  }

  async function submit() {
    setError('')
    if (!category) { setError(t('required_field')); return }
    if (s.title.trim().length < 10) { setError(t('title_label') + ': ' + t('required_field')); return }
    for (const f of category.fields) {
      if (f.required && !s.details[f.name]?.trim()) { setError(label(f) + ': ' + t('required_field')); return }
    }
    setLoading(true)
    try {
      const details: Record<string, unknown> = { ...s.details }
      const res = await fetch('/api/v1/rfq', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category_slug: s.categorySlug,
          title: s.title.trim(),
          details,
          attachments: [],
          ...(s.budgetMin ? { budget_min_paise: Math.round(Number(s.budgetMin) * 100) } : {}),
          ...(s.budgetMax ? { budget_max_paise: Math.round(Number(s.budgetMax) * 100) } : {}),
          ...(s.neededBy ? { needed_by: s.neededBy } : {}),
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.status === 403 && d.error === 'profile_incomplete') {
        router.push('/app/profile'); return
      }
      if (!res.ok) throw new Error(t('err_create'))
      localStorage.removeItem(DRAFT_KEY)
      router.push(`/app/rfq/${d.rfqId}`)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('err_create'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {restored && <p className="rounded-button bg-success/10 px-3 py-2 text-xs text-success">{t('draft_restored')}</p>}

      {/* Category */}
      <div className="flex flex-col gap-1.5">
        <Label>{t('pick_category')}</Label>
        <Select value={s.categorySlug} onChange={(e) => setS((p) => ({ ...p, categorySlug: e.target.value, details: {} }))} placeholder="—">
          {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
        </Select>
      </div>

      {category && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rfq-title">{t('title_label')}</Label>
            <Input id="rfq-title" value={s.title} onChange={(e) => setS((p) => ({ ...p, title: e.target.value }))} placeholder={t('title_placeholder')} />
          </div>

          {/* Dynamic fields from the category's rfq_template */}
          {category.fields.map((f) => (
            <div key={f.name} className="flex flex-col gap-1.5">
              <Label htmlFor={`f-${f.name}`}>
                {label(f)}{f.required && <span className="text-danger"> *</span>}
              </Label>
              {f.type === 'select' ? (
                <Select id={`f-${f.name}`} value={s.details[f.name] ?? ''} onChange={(e) => setField(f.name, e.target.value)} placeholder="—">
                  {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                </Select>
              ) : f.type === 'textarea' ? (
                <Textarea id={`f-${f.name}`} value={s.details[f.name] ?? ''} onChange={(e) => setField(f.name, e.target.value)} rows={3} />
              ) : (
                <Input id={`f-${f.name}`} value={s.details[f.name] ?? ''} onChange={(e) => setField(f.name, e.target.value)} placeholder={f.placeholder_en ?? ''} />
              )}
            </div>
          ))}

          {/* Free-text */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rfq-free">{t('free_details_label')}</Label>
            <Textarea id="rfq-free" value={s.details['additional_details'] ?? ''} onChange={(e) => setField('additional_details', e.target.value)} placeholder={t('free_details_placeholder')} rows={3} />
          </div>

          {/* Budget */}
          <div className="flex flex-col gap-1.5">
            <Label>{t('budget_label')}</Label>
            <div className="flex gap-3">
              <Input type="number" inputMode="numeric" placeholder={t('budget_min')} value={s.budgetMin} onChange={(e) => setS((p) => ({ ...p, budgetMin: e.target.value }))} />
              <Input type="number" inputMode="numeric" placeholder={t('budget_max')} value={s.budgetMax} onChange={(e) => setS((p) => ({ ...p, budgetMax: e.target.value }))} />
            </div>
          </div>

          {/* Needed by */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rfq-needed">{t('needed_by_label')}</Label>
            <Input id="rfq-needed" type="date" value={s.neededBy} onChange={(e) => setS((p) => ({ ...p, neededBy: e.target.value }))} />
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}
          <Button onClick={submit} loading={loading} className="w-full">{loading ? t('submitting') : t('submit')}</Button>
        </>
      )}
    </div>
  )
}
