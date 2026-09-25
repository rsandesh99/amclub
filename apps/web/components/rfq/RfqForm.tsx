'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useAnalytics } from '@/components/providers/posthog'
import { useRouter } from '@/i18n/navigation'
import { Mic } from 'lucide-react'
import {
  voiceMetaSchema,
  indianStateName,
  rfqFieldLabel,
  rfqFieldPlaceholder,
  rfqOptionLabel,
  rfqQualityScore,
  quoteSlaHours,
  RFQ_BUDGET_BANDS,
  RFQ_BUDGET_BAND_KEYS,
  rfqSchema,
  type RfqBudgetBand,
  type RfqEntryPoint,
  type RfqMustHaves,
  type RfqTemplateField,
  type VoiceMeta,
  type VoiceParseResponse,
} from '@amclub/shared'
import { Picker } from '@/components/ui-v3/Picker'
import { SegmentedControl } from '@/components/ui-v3/SegmentedControl'
import { Link } from '@/i18n/navigation'
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
import { RFQ_DRAFT_KEY } from './draft-key'

export interface RfqCategoryOption {
  slug: string
  name: string
  fields: RfqTemplateField[]
}

const DRAFT_KEY = RFQ_DRAFT_KEY
/** The server's title rule (rfqSchema), read from the schema so the form and the API never drift. */
const TITLE_MIN = rfqSchema.innerType().shape.title.minLength ?? 10

/** An inline field error, referenced by the control's aria-describedby. */
function FieldError({ id, msg }: { id: string; msg: string | undefined }) {
  return msg ? <p id={id} className="text-xs text-danger" role="alert">{msg}</p> : null
}

/** Experience v3 E6 — what the page hands the v3 form (flag `requirements`). */
export interface RfqFormV3 {
  /** category slug → its level-2 service slugs. */
  services: Record<string, readonly string[]>
  /** category slug → reviewed document suggestions (empty while document_suggestions_enabled is off). */
  documents: Record<string, { key: string; label: string; required: boolean; service: string | null; reviewedAt: string }[]>
  /** category slug → the quote-time stat for the buyer's state. */
  sla: Record<string, { medianMinutes: number | null; n: number }>
  stateName: string
  entry: RfqEntryPoint
}

const MUST_HAVE_CREDENTIALS = ['icai', 'icsi', 'bar_council', 'gstin'] as const
const MUST_HAVE_LANGUAGES = ['en', 'hi', 'te', 'ta'] as const
const EMPTY_MUST_HAVES: RfqMustHaves = { credentials: [], languages: [], onSite: false, inStateOnly: false }

interface DraftState {
  categorySlug: string
  /** E6 — the level-2 service ('' = none). */
  service?: string
  /** E6 — budget chip (writes budget_min/max). */
  budgetBand?: RfqBudgetBand | ''
  mustHaves?: RfqMustHaves
  documents?: string[]
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
export type RfqPrefill = Pick<DraftState, 'categorySlug' | 'title' | 'details' | 'budgetMin' | 'budgetMax'> & { service?: string; budgetBand?: RfqBudgetBand; mustHaves?: RfqMustHaves }

export function RfqForm({ categories, documentIntakeEnabled = false, prefill, v3 }: { categories: RfqCategoryOption[]; documentIntakeEnabled?: boolean; prefill?: RfqPrefill | undefined; v3?: RfqFormV3 | undefined }) {
  const t = useTranslations('rfq')
  const t3 = useTranslations('rfq_v3')
  const tSvc = useTranslations('services')
  const tCat = useTranslations('catalog')
  const tv = useTranslations('voice')
  const locale = useLocale()
  const router = useRouter()
  const posthog = useAnalytics()

  const [s, setS] = useState<DraftState>({ ...EMPTY })
  // S1.5 — set when the create reply is DEFERRED (questions before sending); replaces the form.
  const [quality, setQuality] = useState<{ rfqId: string; report: RfqQualityReport; deadlineAt: string | null; modelUsed: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // Client-side checks, shown inline at each field: 'category' | 'title' | 'free' | `f:<template field>`.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const rootRef = useRef<HTMLDivElement>(null)
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
      setS({ ...EMPTY, ...prefill, ...(prefill.service ? { service: prefill.service } : {}) })
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

  // ── Experience v3 E6 ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (v3) track('requirement_form_started', { entry: v3.entry })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per form
  }, [])
  const band = v3 && s.budgetBand ? (RFQ_BUDGET_BANDS[s.budgetBand] as { min?: number; max?: number }) : null
  const mustHaves = s.mustHaves ?? EMPTY_MUST_HAVES
  const docChoices = v3 && category ? (v3.documents[category.slug] ?? []).filter((d) => !d.service || d.service === s.service) : []

  function setField(name: string, value: string) {
    setS((prev) => ({ ...prev, details: { ...prev.details, [name]: value } }))
    clearFieldError(name === 'additional_details' || name === freeField?.name ? 'free' : `f:${name}`)
  }

  function clearFieldError(key: string) {
    setFieldErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }
  /** Spread onto Input / Textarea: the component renders the message under the field. */
  const errOf = (key: string) => (fieldErrors[key] ? { error: fieldErrors[key] } : {})

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
    if (v3) track('requirement_voice_used', { lang: p.original_language, ok: true })
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
    if (v3) track('requirement_voice_used', { lang: null, ok: false })
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

  // E0 / U10 — ONE free-text box. When the category template has its own
  // textarea (e.g. "notes"), that field IS the box: it's not rendered twice, it
  // takes the template's label + required mark, and on submit the typed text is
  // stored under the template's key (so the quality precheck and the provider's
  // view both see it). Voice fills still land in additional_details first.
  const freeField = category?.fields.find((f) => f.type === 'textarea') ?? null
  const freeValue = s.details['additional_details'] ?? (freeField ? s.details[freeField.name] : undefined) ?? ''

  /** The details object exactly as it is sent (the score reads the same one). */
  function detailsForSubmit(): Record<string, unknown> {
    const details: Record<string, unknown> = { ...s.details }
    if (freeField) {
      delete details['additional_details']
      details[freeField.name] = freeValue
    }
    if (v3) {
      if (s.service) details['service_slug'] = s.service
      const docs = (s.documents ?? []).filter((k) => docChoices.some((d) => d.key === k))
      if (docs.length > 0) details['documents_expected'] = docs
    }
    return details
  }

  // FR-6.2 — the strength meter runs the server's pre-check rules on what would be sent.
  const strength = v3 && category
    ? rfqQualityScore({
        categorySlug: category.slug,
        template: { fields: category.fields },
        title: s.title,
        details: detailsForSubmit(),
        budgetMinPaise: band?.min ?? null,
        budgetMaxPaise: band?.max ?? null,
        neededBy: s.neededBy || null,
        recentOpenSameCategory: false,
      })
    : null
  const strengthBucket = strength?.bucket
  useEffect(() => {
    if (strengthBucket) track('requirement_strength_changed', { bucket: strengthBucket })
  }, [strengthBucket, track])

  /** Every client-side problem at once, keyed by field (the keys match `data-rfq-field`). */
  function validate(): Record<string, string> {
    if (!category) return { category: t('required_field') }
    const errs: Record<string, string> = {}
    const title = s.title.trim()
    if (!title) errs['title'] = t('required_field')
    else if (title.length < TITLE_MIN) errs['title'] = t('err_title_min', { min: TITLE_MIN })
    for (const f of category.fields) {
      const v = f === freeField ? freeValue : s.details[f.name]
      if (f.required && !v?.trim()) errs[f === freeField ? 'free' : `f:${f.name}`] = t('required_field')
    }
    return errs
  }

  /** Scroll to the first invalid field (in page order) and put focus on its control. */
  function focusFirstInvalid(errs: Record<string, string>) {
    requestAnimationFrame(() => {
      const el = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-rfq-field]') ?? [])].find((n) => !!errs[n.dataset['rfqField'] ?? ''])
      if (!el) return
      el.scrollIntoView({ block: 'center' })
      el.querySelector<HTMLElement>('input, textarea, select, button:not([tabindex="-1"])')?.focus({ preventScroll: true })
    })
  }

  async function submit() {
    setError('')
    const errs = validate()
    setFieldErrors(errs)
    if (Object.keys(errs).length > 0 || !category) {
      focusFirstInvalid(errs)
      return
    }
    setLoading(true)
    try {
      const details = detailsForSubmit()
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
          ...(v3
            ? { ...(band?.min !== undefined ? { budget_min_paise: band.min } : {}), ...(band?.max !== undefined ? { budget_max_paise: band.max } : {}) }
            : {
                ...(s.budgetMin ? { budget_min_paise: Math.round(Number(s.budgetMin) * 100) } : {}),
                ...(s.budgetMax ? { budget_max_paise: Math.round(Number(s.budgetMax) * 100) } : {}),
              }),
          ...(v3 && (mustHaves.credentials.length || mustHaves.languages.length || mustHaves.onSite || mustHaves.inStateOnly) ? { must_haves: mustHaves } : {}),
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
      if (v3) {
        const required = category.fields.filter((f) => f.required)
        track('requirement_submitted', { score: strength?.score ?? null, required_filled: required.every((f) => (f === freeField ? freeValue : s.details[f.name])?.trim()), entry: v3.entry })
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
    <div ref={rootRef} className="space-y-6">
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
                  {indianStateName(voice.parse.state, locale)}
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

      {v3 ? (
        <div className="space-y-5" data-testid="rfq-v3">
          <p className="text-center text-xs font-medium uppercase tracking-wide text-foreground-tertiary">{t3('or_type')}</p>
          {/* FR-6.1 — category Picker, then the service. Each Picker has a visible label (the button's own name is for screen readers). */}
          <div className="flex flex-col gap-1.5" data-rfq-field="category">
            <Label htmlFor="rfq-category">{t('pick_category')}<span className="text-danger"> *</span></Label>
            <Picker
              id="rfq-category"
              label={t('pick_category')}
              placeholder={t3('choose')}
              value={s.categorySlug || null}
              options={categories.map((c) => ({ value: c.slug, label: c.name }))}
              invalid={!!fieldErrors['category']}
              describedBy={fieldErrors['category'] ? 'rfq-category-error' : undefined}
              onChange={(v) => {
                markEdited('category')
                setFieldErrors({})
                setS((p) => ({ ...p, categorySlug: v ?? '', service: '', documents: [], details: p.voice ? p.details : {} }))
              }}
            />
            <FieldError id="rfq-category-error" msg={fieldErrors['category']} />
          </div>
          {category && (v3.services[category.slug]?.length ?? 0) > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rfq-service">{t3('service')}</Label>
              <Picker
                id="rfq-service"
                label={t3('service')}
                placeholder={t3('any_service')}
                value={s.service || null}
                allowClear
                clearLabel={t3('any_service')}
                options={(v3.services[category.slug] ?? []).map((sv) => ({ value: sv, label: tSvc(sv as 'gst-filing') }))}
                onChange={(v) => setS((p) => ({ ...p, service: v ?? '' }))}
              />
            </div>
          )}
          {category && (
            <>
              <div className="flex flex-col gap-1.5" data-rfq-field="title">
                <Label htmlFor="rfq-title">{t('title_label')}<span className="text-danger"> *</span></Label>
                <Input id="rfq-title" value={s.title} onChange={(e) => { markEdited('title'); clearFieldError('title'); setS((p) => ({ ...p, title: e.target.value })) }} placeholder={t('title_placeholder')} {...errOf('title')} />
              </div>

              {/* Template fields — a segmented control for ≤ 5 options, a Picker for more. */}
              {category.fields.filter((f) => f !== freeField).map((f) => {
                const key = `f:${f.name}`
                const errId = `f-${f.name}-error`
                return (
                  <div key={f.name} className="flex flex-col gap-1.5" data-rfq-field={key}>
                    <Label htmlFor={`f-${f.name}`}>{label(f)}{f.required && <span className="text-danger"> *</span>}</Label>
                    {f.type === 'select' && (f.options ?? []).length > 5 ? (
                      <>
                        <Picker
                          id={`f-${f.name}`}
                          label={label(f)}
                          placeholder={t3('choose')}
                          value={s.details[f.name] || null}
                          options={(f.options ?? []).map((o) => ({ value: o, label: rfqOptionLabel(o, locale, f.option_labels) }))}
                          invalid={!!fieldErrors[key]}
                          describedBy={fieldErrors[key] ? errId : undefined}
                          onChange={(v) => setField(f.name, v ?? '')}
                        />
                        <FieldError id={errId} msg={fieldErrors[key]} />
                      </>
                    ) : f.type === 'select' ? (
                      <>
                        {/* Template options are data ("₹20 lakh – ₹1 crore"): the segments wrap instead of truncating. */}
                        <SegmentedControl<string>
                          size="sm"
                          wrap
                          ariaLabel={label(f)}
                          options={(f.options ?? []).map((o) => ({ value: o, label: rfqOptionLabel(o, locale, f.option_labels) }))}
                          value={s.details[f.name] || null}
                          invalid={!!fieldErrors[key]}
                          ariaDescribedBy={fieldErrors[key] ? errId : undefined}
                          onChange={(v) => setField(f.name, v)}
                        />
                        <FieldError id={errId} msg={fieldErrors[key]} />
                      </>
                    ) : f.type === 'textarea' ? (
                      <Textarea id={`f-${f.name}`} value={s.details[f.name] ?? ''} onChange={(e) => setField(f.name, e.target.value)} rows={3} {...errOf(key)} />
                    ) : (
                      <Input id={`f-${f.name}`} value={s.details[f.name] ?? ''} onChange={(e) => setField(f.name, e.target.value)} placeholder={rfqFieldPlaceholder(f, locale)} {...errOf(key)} />
                    )}
                  </div>
                )
              })}

              {/* ONE free-text field. */}
              <div className="flex flex-col gap-1.5" data-rfq-field="free">
                <Label htmlFor="rfq-free">{freeField ? label(freeField) : t('free_details_label')}{freeField?.required && <span className="text-danger"> *</span>}</Label>
                <Textarea id="rfq-free" value={freeValue} onChange={(e) => { markEdited('description'); setField('additional_details', e.target.value) }} placeholder={t('free_details_placeholder')} rows={3} {...errOf('free')} />
              </div>

              {/* Budget chips — bands write budget_min / budget_max. */}
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium">{t('budget_label')}</span>
                <div className="flex flex-wrap gap-2" role="group" aria-label={t('budget_label')}>
                  {RFQ_BUDGET_BAND_KEYS.map((b) => {
                    const on = s.budgetBand === b
                    return (
                      <button key={b} type="button" aria-pressed={on} onClick={() => setS((p) => ({ ...p, budgetBand: on ? '' : b }))} className={on ? 'min-h-[36px] rounded-chip border border-primary bg-primary/10 px-3 text-sm font-medium text-primary' : 'min-h-[36px] rounded-chip border border-border px-3 text-sm text-foreground-secondary hover:border-primary/40'}>
                        {t3(`budget_${b}`)}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rfq-needed">{t('needed_by_label')}</Label>
                <Input id="rfq-needed" type="date" value={s.neededBy} onChange={(e) => setS((p) => ({ ...p, neededBy: e.target.value }))} />
              </div>

              {/* FR-6.4 — must-haves: shown to providers, never used to match (D-PRD6). */}
              <fieldset className="space-y-2" data-testid="rfq-must-haves">
                <legend className="text-sm font-medium">{t3('must_haves')}</legend>
                <p className="text-xs text-foreground-secondary">{t3('must_haves_hint')}</p>
                <div className="flex flex-wrap gap-2">
                  {MUST_HAVE_CREDENTIALS.map((k) => {
                    const on = mustHaves.credentials.includes(k)
                    return (
                      <button key={k} type="button" aria-pressed={on} onClick={() => { track('requirement_must_have_set', { kind: 'credential', value: k, on: !on }); setS((p) => { const m = p.mustHaves ?? EMPTY_MUST_HAVES; return { ...p, mustHaves: { ...m, credentials: on ? m.credentials.filter((x) => x !== k) : [...m.credentials, k] } } }) }} className={on ? 'min-h-[36px] rounded-chip border border-primary bg-primary/10 px-3 text-sm font-medium text-primary' : 'min-h-[36px] rounded-chip border border-border px-3 text-sm text-foreground-secondary'}>
                        {tCat(`badge_${k}` as 'badge_gstin')}
                      </button>
                    )
                  })}
                  {MUST_HAVE_LANGUAGES.map((l) => {
                    const on = mustHaves.languages.includes(l)
                    return (
                      <button key={l} type="button" aria-pressed={on} onClick={() => { track('requirement_must_have_set', { kind: 'language', value: l, on: !on }); setS((p) => { const m = p.mustHaves ?? EMPTY_MUST_HAVES; return { ...p, mustHaves: { ...m, languages: on ? m.languages.filter((x) => x !== l) : [...m.languages, l] } } }) }} className={on ? 'min-h-[36px] rounded-chip border border-primary bg-primary/10 px-3 text-sm font-medium text-primary' : 'min-h-[36px] rounded-chip border border-border px-3 text-sm text-foreground-secondary'}>
                        {tCat(`lang_${l}` as 'lang_en')}
                      </button>
                    )
                  })}
                  {(['onSite', 'inStateOnly'] as const).map((k) => {
                    const on = mustHaves[k]
                    return (
                      <button key={k} type="button" aria-pressed={on} onClick={() => { track('requirement_must_have_set', { kind: k, on: !on }); setS((p) => ({ ...p, mustHaves: { ...(p.mustHaves ?? EMPTY_MUST_HAVES), [k]: !on } })) }} className={on ? 'min-h-[36px] rounded-chip border border-primary bg-primary/10 px-3 text-sm font-medium text-primary' : 'min-h-[36px] rounded-chip border border-border px-3 text-sm text-foreground-secondary'}>
                        {t3(k === 'onSite' ? 'on_site' : 'in_state_only', { state: v3.stateName })}
                      </button>
                    )
                  })}
                </div>
              </fieldset>

              {/* FR-6.3 — documents you'll likely need (reviewed content only). */}
              {docChoices.length > 0 && (
                <fieldset className="space-y-2" data-testid="rfq-documents">
                  <legend className="text-sm font-medium">{t3('documents')}</legend>
                  <ul className="space-y-1.5">
                    {docChoices.map((d) => {
                      const on = (s.documents ?? []).includes(d.key)
                      return (
                        <li key={d.key}>
                          <label className="flex min-h-[36px] items-center gap-2 text-sm">
                            <input type="checkbox" checked={on} onChange={() => { track('requirement_document_toggled', { key: d.key, on: !on }); setS((p) => ({ ...p, documents: on ? (p.documents ?? []).filter((x) => x !== d.key) : [...(p.documents ?? []), d.key] })) }} className="h-4 w-4 accent-primary" />
                            <span>{d.label}{d.required && <span className="text-foreground-secondary"> · {t3('usually_needed')}</span>}</span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                  <p className="text-[11px] text-foreground-tertiary">{t3('documents_reviewed', { date: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(docChoices[0]!.reviewedAt)) })}</p>
                </fieldset>
              )}

              {/* FR-6.2 — strength meter: a thin bar and the one change that helps most. */}
              {strength && (
                <div data-testid="rfq-strength" data-score={strength.score}>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunken" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={strength.score} aria-label={t3('strength_label')}>
                    <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${strength.score}%` }} />
                  </div>
                  <p className="mt-1 text-xs text-foreground-secondary">
                    {t3(`strength_${strength.bucket}`)}
                    {strength.next && ` · ${strength.next.reason === 'required' ? t3('next_required', { field: category.fields.find((f) => f.name === strength.next!.field) ? label(category.fields.find((f) => f.name === strength.next!.field)!) : strength.next.field, gain: strength.next.gain }) : t3(`next_${strength.next.reason}`, { gain: strength.next.gain })}`}
                  </p>
                </div>
              )}

              {/* FR-6.7 — the promise block. */}
              <p className="rounded-card bg-primary/5 px-4 py-3 text-sm text-foreground-secondary" data-testid="rfq-promise">
                {(() => {
                  const sla = quoteSlaHours(v3.sla[category.slug] ?? null)
                  return t3('promise', { state: v3.stateName, sla: sla.measured ? t3('sla_measured', { hours: sla.hours }) : t3('sla_default', { hours: sla.hours }) })
                })()}{' '}
                <Link href="/app/profile" className="font-medium text-primary hover:underline">{t3('change')}</Link>
              </p>

              {error && <p className="text-sm text-danger">{error}</p>}
              <div data-bottom-bar className="sticky bottom-[calc(var(--tabbar-h,0px)+env(safe-area-inset-bottom,0px))] z-20 -mx-4 border-t border-border bg-surface px-4 py-3 lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0">
                <Button onClick={submit} loading={loading} className="w-full" size="lg" data-testid="rfq-submit">{loading ? t('submitting') : t3('send')}</Button>
              </div>
            </>
          )}
        </div>
      ) : (
        <>
      {/* Category */}
      <div className="flex flex-col gap-1.5" data-rfq-field="category">
        <Label htmlFor="rfq-category">{t('pick_category')}<span className="text-danger"> *</span></Label>
        <Select
          id="rfq-category"
          value={s.categorySlug}
          onChange={(e) => {
            markEdited('category')
            setFieldErrors({})
            setS((p) => ({ ...p, categorySlug: e.target.value, details: p.voice ? p.details : {} }))
          }}
          placeholder="—"
          {...errOf('category')}
        >
          {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
        </Select>
      </div>

      {category && (
        <>
          <div className="flex flex-col gap-1.5" data-rfq-field="title">
            <Label htmlFor="rfq-title">{t('title_label')}<span className="text-danger"> *</span></Label>
            <Input
              id="rfq-title"
              value={s.title}
              onChange={(e) => { markEdited('title'); clearFieldError('title'); setS((p) => ({ ...p, title: e.target.value })) }}
              placeholder={t('title_placeholder')}
              {...errOf('title')}
            />
          </div>

          {/* Dynamic fields from the category's rfq_template */}
          {category.fields.filter((f) => f !== freeField).map((f) => (
            <div key={f.name} className="flex flex-col gap-1.5" data-rfq-field={`f:${f.name}`}>
              <Label htmlFor={`f-${f.name}`}>
                {label(f)}{f.required && <span className="text-danger"> *</span>}
              </Label>
              {f.type === 'select' ? (
                <Select id={`f-${f.name}`} value={s.details[f.name] ?? ''} onChange={(e) => setField(f.name, e.target.value)} placeholder="—" {...errOf(`f:${f.name}`)}>
                  {(f.options ?? []).map((o) => <option key={o} value={o}>{rfqOptionLabel(o, locale, f.option_labels)}</option>)}
                </Select>
              ) : f.type === 'textarea' ? (
                <Textarea id={`f-${f.name}`} value={s.details[f.name] ?? ''} onChange={(e) => setField(f.name, e.target.value)} rows={3} {...errOf(`f:${f.name}`)} />
              ) : (
                <Input id={`f-${f.name}`} value={s.details[f.name] ?? ''} onChange={(e) => setField(f.name, e.target.value)} placeholder={rfqFieldPlaceholder(f, locale)} {...errOf(`f:${f.name}`)} />
              )}
            </div>
          ))}

          {/* Free-text */}
          <div className="flex flex-col gap-1.5" data-rfq-field="free">
            <Label htmlFor="rfq-free">
              {freeField ? label(freeField) : t('free_details_label')}
              {freeField?.required && <span className="text-danger"> *</span>}
            </Label>
            <Textarea
              id="rfq-free"
              value={freeValue}
              onChange={(e) => { markEdited('description'); setField('additional_details', e.target.value) }}
              placeholder={t('free_details_placeholder')}
              rows={3}
              {...errOf('free')}
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
        </>
      )}
    </div>
  )
}
