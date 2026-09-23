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
import { ClarifyBubble, type ClarifyPayload } from '@/components/voice/ClarifyBubble'
import { IntakeDocumentButton } from '@/components/rfq/IntakeDocumentButton'
import type { IntakeResult, VoiceMetaClarify } from '@amclub/shared'
import { QualityQuestionsCard } from '@/components/rfq/QualityQuestionsCard'
import type { RfqQualityReport } from '@amclub/shared'
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
  /** S1.8 — document / drawing intake: editable facts, the drawing summary, attachments and the ids the Create tap confirms. */
  intake?: IntakeDraft
}

interface IntakeFact { id: string; k: string; v: string; confidence: 'low' | 'medium' | 'high' }
interface IntakeDraft {
  extractionIds: string[]
  attachments: { url: string; name: string }[]
  facts: IntakeFact[]
  drawing?: { summary: string; rows: { k: string; v: string }[] } | undefined
  stub?: boolean | undefined
}
const EMPTY_INTAKE: IntakeDraft = { extractionIds: [], attachments: [], facts: [] }

const EMPTY: DraftState = { categorySlug: '', title: '', details: {}, budgetMin: '', budgetMax: '', neededBy: '' }

/** Human-readable fallback for a specialization slug ('gst-filing' → 'GST filing'). */
function specLabel(slug: string): string {
  const words = slug.split('-')
  return words
    .map((w, i) => (w.length <= 4 && ['gst', 'itr', 'tds', 'seo', 'iec', 'noc', 'llp', 'opc', 'pvt', 'ltd', 'hr', 'ip', 'dsa', 'gem', 'ondc', 'pmegp', 'fssai', 'msme', 'cgtmse'].includes(w) ? w.toUpperCase() : i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ')
}

/** "Repost with edits" — fields copied from one of the buyer's own earlier RFQs (loaded server-side, RLS-scoped). */
export type RfqPrefill = Pick<DraftState, 'categorySlug' | 'title' | 'details' | 'budgetMin' | 'budgetMax'>

export function RfqForm({ categories, documentIntakeEnabled = false, prefill }: { categories: RfqCategoryOption[]; documentIntakeEnabled?: boolean; prefill?: RfqPrefill | undefined }) {
  const t = useTranslations('rfq')
  const tv = useTranslations('voice')
  const locale = useLocale()
  const router = useRouter()
  const posthog = useAnalytics()

  const [s, setS] = useState<DraftState>({ ...EMPTY })
  // S1.5 — set when the create reply is DEFERRED (questions before sending); replaces the form.
  const [quality, setQuality] = useState<{ rfqId: string; report: RfqQualityReport; deadlineAt: string | null; modelUsed: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [restored, setRestored] = useState(false)
  // S1.8 — the ONE clarifying question (never persisted: the audio data URL is large and the round is transient).
  const [clarify, setClarify] = useState<{ payload: ClarifyPayload; prior: { transcript_english: string; parse: VoiceMeta['parse'] } } | null>(null)
  const [clarifyNote, setClarifyNote] = useState<'answered' | 'skipped' | null>(null)

  const track = useCallback(
    (event: string, props?: Record<string, unknown>) =>
      posthog.capture(event, { locale, device: 'web', ...props }),
    [posthog, locale],
  )

  useEffect(() => {
    // A repost starts from the earlier request, not from whatever draft this device holds.
    if (prefill) {
      setS({ ...EMPTY, ...prefill })
      setRestored(true)
      setTimeout(() => setRestored(false), 3000)
      return
    }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once on mount; prefill is fixed for the page
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

  function applyParse(res: VoiceParseResponse & { vendor: VoiceVendorTag }, durationMs: number, clarifyMeta?: VoiceMetaClarify) {
    const p = res.parse
    const description = p.description_english
    // S1.8 — round one may carry the ONE question; round two never does.
    if (res.clarify) setClarify({ payload: res.clarify, prior: { transcript_english: res.transcript_english, parse: p } })
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
        ...(clarifyMeta ? { clarify: clarifyMeta } : prev.voice?.clarify ? { clarify: prev.voice.clarify } : {}),
      },
    }))
  }

  // S1.8 — the clarify round: answered (merged parse replaces the prefill) or skipped (the first parse stands).
  function onClarifyAnswered(res: VoiceParseResponse & { vendor: VoiceVendorTag }, by: 'voice' | 'text', answerTranscript: string) {
    if (!clarify) return
    const meta: VoiceMetaClarify = { question: clarify.payload.question, gap: clarify.payload.gap, answer_transcript: answerTranscript.slice(0, 2000), answered_by: by }
    applyParse(res, s.voice?.duration_ms ?? 1, meta)
    addExtractionId(clarify.payload.extraction_id)
    setClarify(null)
    setClarifyNote('answered')
  }
  function onClarifySkip() {
    if (!clarify) return
    const meta: VoiceMetaClarify = { question: clarify.payload.question, gap: clarify.payload.gap, answer_transcript: '', answered_by: 'skipped' }
    setS((prev) => (prev.voice ? { ...prev, voice: { ...prev.voice, clarify: meta } } : prev))
    addExtractionId(clarify.payload.extraction_id)
    setClarify(null)
    setClarifyNote('skipped')
  }
  function addExtractionId(id: string) {
    setS((prev) => {
      const cur = prev.intake ?? EMPTY_INTAKE
      if (cur.extractionIds.includes(id) || cur.extractionIds.length >= 4) return prev
      return { ...prev, intake: { ...cur, extractionIds: [...cur.extractionIds, id] } }
    })
  }

  // S1.8 — document / drawing result → prefill only (facts as chips, description appended, category only when empty).
  function onIntakeResult(r: IntakeResult) {
    addExtractionId(r.extraction_id)
    setS((prev) => {
      const cur = prev.intake ?? EMPTY_INTAKE
      const attachments = cur.attachments.some((a) => a.url === r.attachment.url) || cur.attachments.length >= 5 ? cur.attachments : [...cur.attachments, r.attachment]
      if (r.kind === 'drawing') {
        const rows = r.result.spec_rows
        const line = r.result.summary_english
        return {
          ...prev,
          title: prev.title || (r.result.product_name ? `${r.result.product_name} — ${line}`.slice(0, 120) : ''),
          details: { ...prev.details, additional_details: prev.details['additional_details'] ? `${prev.details['additional_details']}\n${line}` : line },
          intake: { ...cur, attachments, drawing: { summary: line, rows } },
        }
      }
      const facts: IntakeFact[] = [...cur.facts, ...r.result.facts.map((f, i) => ({ id: `${r.extraction_id}:${i}`, k: f.k, v: f.v, confidence: f.confidence }))].slice(0, 20)
      const desc = r.result.description_english
      return {
        ...prev,
        categorySlug: prev.categorySlug || (r.result.suggested_category_slug ?? ''),
        title: prev.title || (desc.length >= 10 ? desc.slice(0, 120) : ''),
        details: { ...prev.details, additional_details: desc ? (prev.details['additional_details'] ? `${prev.details['additional_details']}\n${desc}` : desc) : (prev.details['additional_details'] ?? '') },
        intake: { ...cur, attachments, facts, stub: r.stub || cur.stub },
      }
    })
  }
  function onIntakeAttachmentOnly(a: { url: string; name: string }) {
    setS((prev) => {
      const cur = prev.intake ?? EMPTY_INTAKE
      if (cur.attachments.some((x) => x.url === a.url) || cur.attachments.length >= 5) return prev
      return { ...prev, intake: { ...cur, attachments: [...cur.attachments, a] } }
    })
  }
  function editFact(id: string, v: string) {
    setS((prev) => ({ ...prev, intake: { ...(prev.intake ?? EMPTY_INTAKE), facts: (prev.intake?.facts ?? []).map((f) => (f.id === id ? { ...f, v } : f)) } }))
  }
  function removeFact(id: string) {
    setS((prev) => ({ ...prev, intake: { ...(prev.intake ?? EMPTY_INTAKE), facts: (prev.intake?.facts ?? []).filter((f) => f.id !== id) } }))
  }
  function removeAttachment(url: string) {
    setS((prev) => ({ ...prev, intake: { ...(prev.intake ?? EMPTY_INTAKE), attachments: (prev.intake?.attachments ?? []).filter((a) => a.url !== url) } }))
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
      // S1.8 — the (edited) document facts travel with the request as one readable line.
      const facts = (s.intake?.facts ?? []).filter((f) => f.k.trim() && f.v.trim())
      if (facts.length > 0) details['document_facts'] = facts.map((f) => `${f.k}: ${f.v}`).join(' · ').slice(0, 2000)
      // Strip the client-only stub flag; the server Zod-validates the rest.
      const voiceMeta: VoiceMeta | undefined = s.voice
        ? {
            transcript_english: s.voice.transcript_english,
            parse: s.voice.parse,
            duration_ms: s.voice.duration_ms,
            edited_fields: s.voice.edited_fields,
            vendor: s.voice.vendor,
            ...(s.voice.clarify ? { clarify: s.voice.clarify } : {}),
          }
        : undefined
      const res = await fetch('/api/v1/rfq', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          category_slug: s.categorySlug,
          title: s.title.trim(),
          details,
          attachments: s.intake?.attachments ?? [],
          ...(s.intake?.extractionIds.length ? { intake_extraction_ids: s.intake.extractionIds } : {}),
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
      // S1.5 — DEFERRED: the RFQ exists but is not sent yet; show the questions instead of redirecting.
      if (d.deferred && d.quality && Array.isArray(d.quality.missing) && d.quality.missing.length > 0) {
        setQuality({ rfqId: d.rfqId, report: d.quality as RfqQualityReport, deadlineAt: d.deadline_at ?? null, modelUsed: d.quality_meta?.model_used !== false })
        return
      }
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

  // S1.5 — the request exists but is held for the buyer's answers: the card replaces the form.
  if (quality) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-foreground-secondary">{s.title.trim()}</p>
        <QualityQuestionsCard rfqId={quality.rfqId} report={quality.report} deadlineAt={quality.deadlineAt} modelUsed={quality.modelUsed} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {restored && <p className="rounded-button bg-success/10 px-3 py-2 text-xs text-success">{t('draft_restored')}</p>}

      {/* Phase 8b — speak instead of type. Parse only pre-fills; never submits. */}
      <VoiceRfqRecorder onParsed={applyParse} onTranscriptOnly={applyTranscriptOnly} track={track} />

      {/* S1.8 — the ONE clarifying question (round one only; the bubble unmounts once answered or skipped). */}
      {clarify && <ClarifyBubble clarify={clarify.payload} prior={clarify.prior} onAnswered={onClarifyAnswered} onSkip={onClarifySkip} track={track} />}
      {clarifyNote && <p className="text-xs text-foreground-secondary" role="status">{clarifyNote === 'answered' ? tv('clarify_answered_note') : tv('clarify_skipped_note')}</p>}

      {/* S1.8 — a photo of a notice or invoice, a text PDF, or a STEP / DXF drawing → prefill (cohorted buyers only). */}
      <div className="flex flex-wrap items-start gap-3">
        <IntakeDocumentButton mode="service" enabled={documentIntakeEnabled} track={track} onResult={onIntakeResult} onAttachmentOnly={onIntakeAttachmentOnly} />
      </div>
      {(s.intake?.facts.length ?? 0) > 0 && (
        <div className="rounded-card border border-border p-4">
          <p className="text-sm font-semibold text-foreground">{t('intake_facts_title')}</p>
          <p className="mt-0.5 text-xs text-foreground-secondary">{t('intake_facts_hint')}{s.intake?.stub ? ` ${t('intake_stub_note')}` : ''}</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {s.intake!.facts.map((f) => (
              <li key={f.id} className={`flex items-center gap-1 rounded-chip border px-2 py-1 text-[13px] ${f.confidence === 'low' ? 'border-dashed border-warning/60' : 'border-border'}`}>
                <span className="font-medium text-foreground-secondary">{f.k}:</span>
                <input
                  aria-label={`${t('intake_edit_value')} — ${f.k}`}
                  value={f.v}
                  maxLength={200}
                  onChange={(e) => editFact(f.id, e.target.value)}
                  onBlur={() => track('rfq_intake_chip_edited', { k: f.k })}
                  className="min-w-[6rem] bg-transparent text-foreground outline-none"
                />
                <button type="button" aria-label={`${t('intake_remove')} ${f.k}`} onClick={() => removeFact(f.id)} className="px-1 text-foreground-secondary">×</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {s.intake?.drawing && (
        <div className="rounded-card border border-border p-4">
          <p className="text-sm font-semibold text-foreground">{t('intake_drawing_title')}</p>
          <p className="mt-0.5 text-sm text-foreground">{s.intake.drawing.summary}</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {s.intake.drawing.rows.map((r) => (
              <li key={r.k} className="rounded-chip border border-border px-2 py-1 text-[13px]"><span className="font-medium text-foreground-secondary">{r.k}:</span> {r.v}</li>
            ))}
          </ul>
        </div>
      )}
      {(s.intake?.attachments.length ?? 0) > 0 && (
        <ul className="space-y-1 text-sm" aria-label={t('intake_attachments_title')}>
          {s.intake!.attachments.map((a) => (
            <li key={a.url} className="flex items-center justify-between gap-2 rounded-button border border-border px-3 py-2">
              <span className="truncate">{a.name}</span>
              <button type="button" onClick={() => removeAttachment(a.url)} className="min-h-8 px-2 text-xs text-foreground-secondary underline underline-offset-2">{t('intake_remove')}</button>
            </li>
          ))}
        </ul>
      )}

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
