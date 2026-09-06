'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useAnalytics } from '@/components/providers/posthog'
import { useRouter } from '@/i18n/navigation'
import { Mic } from 'lucide-react'
import { voiceMetaSchema, rfqFieldLabel, type RfqTemplateField, type VoiceMeta, type VoiceParseResponse } from '@amclub/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { VoiceRfqRecorder, type VoiceVendorTag } from '@/components/voice/VoiceRfqRecorder'
import { INDIAN_STATES } from '@/lib/constants/india'

export interface RfqCategoryOption {
  slug: string
  name: string
  fields: RfqTemplateField[]
}

const DRAFT_KEY = 'amclub_rfq_draft'
const STATE_LABEL = new Map(INDIAN_STATES.map((s) => [s.value, s.label]))

interface DraftState {
  categorySlug: string
  title: string
  details: Record<string, string>
  budgetMin: string
  budgetMax: string
  neededBy: string
  /** Phase 8b — present when the draft began as a voice recording. */
  voice?: VoiceMeta & { stub?: boolean }
}

const EMPTY: DraftState = { categorySlug: '', title: '', details: {}, budgetMin: '', budgetMax: '', neededBy: '' }

/** Human-readable fallback for a specialization slug ('gst-filing' → 'GST filing'). */
function specLabel(slug: string): string {
  const words = slug.split('-')
  return words
    .map((w, i) => (w.length <= 4 && ['gst', 'itr', 'tds', 'seo', 'iec', 'noc', 'llp', 'opc', 'pvt', 'ltd', 'hr', 'ip', 'dsa', 'gem', 'ondc', 'pmegp', 'fssai', 'msme', 'cgtmse'].includes(w) ? w.toUpperCase() : i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ')
}

export function RfqForm({ categories }: { categories: RfqCategoryOption[] }) {
  const t = useTranslations('rfq')
  const tv = useTranslations('voice')
  const locale = useLocale()
  const router = useRouter()
  const posthog = useAnalytics()

  const [s, setS] = useState<DraftState>({ ...EMPTY })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [restored, setRestored] = useState(false)

  const track = useCallback(
    (event: string, props?: Record<string, unknown>) =>
      posthog.capture(event, { locale, device: 'web', ...props }),
    [posthog, locale],
  )

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY)
      if (raw) {
        const parsed = { ...EMPTY, ...JSON.parse(raw) } as DraftState
        // Voice meta must survive a reload intact or not at all (server Zod-validates it).
        if (parsed.voice && !voiceMetaSchema.safeParse(parsed.voice).success) delete parsed.voice
        setS(parsed)
        setRestored(true)
        setTimeout(() => setRestored(false), 3000)
      }
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
    return rfqFieldLabel(f, locale)
  }

  /** Phase 8b — the user corrected a voice-prefilled field: record it once
   *  (voice_meta.edited_fields is the parse-quality training signal). */
  function markEdited(field: string) {
    setS((prev) => {
      if (!prev.voice || prev.voice.edited_fields.includes(field)) return prev
      track('voice_rfq_edited', { surface: 'rfq_form', field })
      return { ...prev, voice: { ...prev.voice, edited_fields: [...prev.voice.edited_fields, field] } }
    })
  }

  function applyParse(res: VoiceParseResponse & { vendor: VoiceVendorTag }, durationMs: number) {
    const p = res.parse
    const description = p.description_english
    setS((prev) => ({
      ...prev,
      categorySlug: p.category_slug ?? prev.categorySlug,
      title: description.length >= 10 ? description.slice(0, 120) : prev.title,
      details: {
        ...(p.category_slug && p.category_slug !== prev.categorySlug ? {} : prev.details),
        additional_details: description,
      },
      voice: {
        transcript_english: res.transcript_english.slice(0, 4000),
        parse: p,
        duration_ms: Math.min(Math.max(durationMs, 1), 60_000),
        edited_fields: [],
        vendor: res.vendor,
        stub: res.stub,
      },
    }))
  }

  function applyTranscriptOnly(transcript: string, durationMs: number) {
    setS((prev) => ({
      ...prev,
      details: { ...prev.details, additional_details: transcript },
      voice: {
        transcript_english: transcript.slice(0, 4000),
        parse: {
          category_slug: null,
          specialization: null,
          state: null,
          description_english: transcript.slice(0, 2000),
          original_language: 'unknown',
          uncertain: true,
        },
        duration_ms: Math.min(Math.max(durationMs, 1), 60_000),
        edited_fields: [],
        vendor: { stt: 'unknown', parser: 'failed' },
      },
    }))
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
      // Strip the client-only stub flag; the server Zod-validates the rest.
      const voiceMeta: VoiceMeta | undefined = s.voice
        ? {
            transcript_english: s.voice.transcript_english,
            parse: s.voice.parse,
            duration_ms: s.voice.duration_ms,
            edited_fields: s.voice.edited_fields,
            vendor: s.voice.vendor,
          }
        : undefined
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
          ...(voiceMeta ? { voice_meta: voiceMeta } : {}),
        }),
      })
      const d = await res.json().catch(() => ({}))
      if (res.status === 403 && d.error === 'profile_incomplete') {
        router.push('/app/profile'); return
      }
      if (!res.ok) throw new Error(t('err_create'))
      if (voiceMeta) {
        track('voice_rfq_submitted', {
          surface: 'rfq_form',
          original_language: voiceMeta.parse.original_language,
          uncertain: voiceMeta.parse.uncertain,
          edited_fields: voiceMeta.edited_fields,
          edit_count: voiceMeta.edited_fields.length,
        })
      }
      localStorage.removeItem(DRAFT_KEY)
      router.push(`/app/rfq/${d.rfqId}`)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('err_create'))
    } finally {
      setLoading(false)
    }
  }

  const voice = s.voice
  const voiceCategoryName = voice?.parse.category_slug
    ? categories.find((c) => c.slug === voice.parse.category_slug)?.name
    : null

  return (
    <div className="space-y-6">
      {restored && <p className="rounded-button bg-success/10 px-3 py-2 text-xs text-success">{t('draft_restored')}</p>}

      {/* Phase 8b — speak instead of type. Parse only pre-fills; never submits. */}
      <VoiceRfqRecorder onParsed={applyParse} onTranscriptOnly={applyTranscriptOnly} track={track} />

      {voice && (
        <div
          className={`rounded-card border p-4 ${voice.parse.uncertain ? 'border-warning/40 bg-warning/5' : 'border-primary/30 bg-primary-soft/40'}`}
          role="status"
        >
          <p className="text-sm text-foreground">
            <span className="font-semibold">{tv('heard_label')}</span>{' '}
            <span className="italic">“{voice.transcript_english}”</span>
          </p>
          {!voice.parse.uncertain && voiceCategoryName ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-semibold text-foreground">{tv('think_label')}</span>
              <span className="rounded-chip bg-primary-soft px-3 py-1 text-[13px] font-semibold text-primary">
                {voiceCategoryName}
              </span>
              {voice.parse.specialization && (
                <span className="rounded-chip bg-primary-soft px-3 py-1 text-[13px] font-semibold text-primary">
                  {specLabel(voice.parse.specialization)}
                </span>
              )}
              {voice.parse.state && (
                <span className="rounded-chip bg-muted px-3 py-1 text-[13px] font-medium text-foreground">
                  {STATE_LABEL.get(voice.parse.state) ?? voice.parse.state}
                </span>
              )}
            </div>
          ) : (
            <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-warning">
              <Mic className="h-4 w-4 shrink-0" aria-hidden />
              {tv('uncertain_note')}
            </p>
          )}
          <p className="mt-2 text-[13px] text-foreground-secondary">
            {tv('check_note')}
            {voice.stub ? ` ${tv('stub_note')}` : ''}
          </p>
        </div>
      )}

      {/* Category */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="rfq-category">{t('pick_category')}</Label>
        <Select
          id="rfq-category"
          value={s.categorySlug}
          onChange={(e) => {
            markEdited('category')
            setS((p) => ({ ...p, categorySlug: e.target.value, details: p.voice ? p.details : {} }))
          }}
          placeholder="—"
        >
          {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
        </Select>
      </div>

      {category && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rfq-title">{t('title_label')}</Label>
            <Input
              id="rfq-title"
              value={s.title}
              onChange={(e) => { markEdited('title'); setS((p) => ({ ...p, title: e.target.value })) }}
              placeholder={t('title_placeholder')}
            />
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
            <Textarea
              id="rfq-free"
              value={s.details['additional_details'] ?? ''}
              onChange={(e) => { markEdited('description'); setField('additional_details', e.target.value) }}
              placeholder={t('free_details_placeholder')}
              rows={3}
            />
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
