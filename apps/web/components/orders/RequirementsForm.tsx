'use client'

import { useId, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import type { RequirementTemplateField, SubmittedRequirements } from '@/lib/orders/queries'

/** Free-text fallback key when the package froze no requirements template (quote orders, old packages). */
export const FREE_TEXT_FIELD = 'details'
const FREE_TEXT_MIN = 20
const FIELD_MAX = 4000

function fieldLabel(f: { labelEn: string | null; labelHi: string | null }, locale: string): string | null {
  return (locale === 'hi' ? f.labelHi ?? f.labelEn : f.labelEn ?? f.labelHi) ?? null
}

/**
 * Buyer's requirements form (accepted → requirements_submitted). Renders the
 * package's frozen requirements template when there is one, else one required
 * free-text box; sends `requirementsData` (record of field name → text) with
 * the `submit_requirements` action — the route stores it as the
 * `requirements_data` order_event, which both parties then see.
 */
export function RequirementsForm({ orderId, template }: { orderId: string; template: RequirementTemplateField[] }) {
  const t = useTranslations('orders')
  const locale = useLocale()
  const router = useRouter()
  const { toast } = useToast()
  const baseId = useId()
  const fields: RequirementTemplateField[] =
    template.length > 0 ? template : [{ name: FREE_TEXT_FIELD, labelEn: null, labelHi: null, required: true }]
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [touched, setTouched] = useState(false)

  const missing = fields.filter((f) => {
    const v = (values[f.name] ?? '').trim()
    if (f.name === FREE_TEXT_FIELD && template.length === 0) return v.length < FREE_TEXT_MIN
    return f.required && v.length === 0
  })

  async function submit() {
    setTouched(true)
    if (missing.length > 0) return
    setBusy(true)
    setError('')
    try {
      const requirementsData: Record<string, string> = {}
      for (const f of fields) {
        const v = (values[f.name] ?? '').trim()
        if (v) requirementsData[f.name] = v.slice(0, FIELD_MAX)
      }
      const res = await fetch(`/api/v1/orders/${orderId}/transition`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'submit_requirements', requirementsData }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof d.error === 'string' ? d.error : t('action_failed'))
      toast(t('done_submit_requirements'), 'success')
      router.refresh()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('action_failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{t('requirements_form_title')}</h3>
        <p className="mt-1 text-sm text-foreground-secondary">{t('requirements_form_intro')}</p>
      </div>
      {fields.map((f, i) => {
        const id = `${baseId}-${i}`
        const isFree = f.name === FREE_TEXT_FIELD && template.length === 0
        const label = isFree ? t('requirements_free_text_label') : fieldLabel(f, locale) ?? t('requirements_field_fallback', { n: i + 1 })
        const invalid = touched && missing.includes(f)
        return (
          <div key={f.name}>
            <label htmlFor={id} className="block text-sm font-medium">
              {label}
              {f.required && <span className="ml-1 text-danger" aria-hidden="true">*</span>}
            </label>
            <textarea
              id={id}
              value={values[f.name] ?? ''}
              onChange={(e) => setValues((prev) => ({ ...prev, [f.name]: e.target.value.slice(0, FIELD_MAX) }))}
              rows={isFree ? 5 : 3}
              required={f.required}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? `${id}-err` : undefined}
              className="mt-1 w-full rounded-button border border-border bg-background p-3 text-sm"
            />
            {isFree && <p className="mt-1 text-xs text-foreground-secondary">{t('requirements_free_text_hint', { min: FREE_TEXT_MIN })}</p>}
            {invalid && (
              <p id={`${id}-err`} className="mt-1 text-sm text-danger">
                {isFree ? t('requirements_min', { min: FREE_TEXT_MIN }) : t('requirements_required')}
              </p>
            )}
          </div>
        )
      })}
      <Button onClick={submit} loading={busy}>{t('action_submit_requirements')}</Button>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  )
}

/** The submitted requirements, rendered for BOTH parties. */
export function RequirementsCard({ requirements }: { requirements: SubmittedRequirements }) {
  const t = useTranslations('orders')
  const locale = useLocale()
  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card">
      <h2 className="text-sm font-semibold">{t('requirements_title')}</h2>
      <p className="mt-1 text-xs text-foreground-secondary">
        {t('requirements_submitted_at', {
          when: new Date(requirements.submittedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        })}
      </p>
      <dl className="mt-3 space-y-3 text-sm">
        {requirements.fields.map((f, i) => (
          <div key={f.name}>
            <dt className="font-medium">
              {f.name === FREE_TEXT_FIELD && !f.labelEn && !f.labelHi
                ? t('requirements_free_text_label')
                : fieldLabel(f, locale) ?? t('requirements_field_fallback', { n: i + 1 })}
            </dt>
            <dd className="mt-0.5 whitespace-pre-wrap text-foreground-secondary">{f.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
