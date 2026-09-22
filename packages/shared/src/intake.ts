import { z } from 'zod'
import { CATEGORY_SLUGS } from './categories'
import { redactContactInfo } from './rfq'
import { rfqAttachmentSchema, uuidSchema } from './schemas/index'

/**
 * S1.8 — voice RFQ v2 / document intake contracts (Zod first). The clarify
 * question, the prior-round envelope and the voice_meta clarify record live in
 * schemas/index.ts next to voiceParseSchema (they extend it) and are re-exported
 * here; this file holds the document / drawing results, the attachment
 * allow-list and the masking clamp every stored or returned fact passes.
 */
export {
  clarifyQuestionSchema,
  voiceParsePriorSchema,
  voiceMetaClarifySchema,
  type ClarifyQuestion,
  type VoiceParsePrior,
  type VoiceMetaClarify,
} from './schemas/index'

// ── attachments (spine) ──────────────────────────────────────────────────────

export const RFQ_ATTACHMENTS_BUCKET = 'rfq-attachments'
export const RFQ_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
/** Bucket + route allow-list. STEP/DXF arrive with vendor-specific mimes or as octet-stream; the extension decides. */
export const RFQ_ATTACHMENT_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'application/step',
  'application/STEP',
  'model/step',
  'application/x-step',
  'application/dxf',
  'image/vnd.dxf',
  'application/x-dxf',
  'application/octet-stream',
] as const
export const RFQ_ATTACHMENT_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'pdf', 'step', 'stp', 'dxf'] as const
export type RfqAttachmentExt = (typeof RFQ_ATTACHMENT_EXTS)[number]

export type IntakeFileKind = 'image' | 'pdf' | 'step' | 'dxf'

/** Classify an upload by extension first (drawings), then mime (images / PDF). null = not allowed. */
export function classifyIntakeFile(name: string, mime: string): { kind: IntakeFileKind; ext: RfqAttachmentExt } | null {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  const m = (mime || '').toLowerCase()
  if (ext === 'step' || ext === 'stp') return { kind: 'step', ext: ext as RfqAttachmentExt }
  if (ext === 'dxf') return { kind: 'dxf', ext: 'dxf' }
  if (m === 'application/pdf' || ext === 'pdf') return { kind: 'pdf', ext: 'pdf' }
  if (m === 'image/jpeg' || ext === 'jpg' || ext === 'jpeg') return { kind: 'image', ext: 'jpg' }
  if (m === 'image/png' || ext === 'png') return { kind: 'image', ext: 'png' }
  if (m === 'image/webp' || ext === 'webp') return { kind: 'image', ext: 'webp' }
  return null
}

// ── document extraction (images + text PDFs; one frontier call) ──────────────

export const DOC_TYPES = ['gst_notice', 'invoice', 'quotation', 'drawing', 'other'] as const
export type DocType = (typeof DOC_TYPES)[number]

export const documentFactSchema = z
  .object({
    k: z.string().min(1).max(40),
    v: z.string().min(1).max(200),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict()
export type DocumentFact = z.infer<typeof documentFactSchema>

export const documentExtractSchema = z
  .object({
    doc_type: z.enum(DOC_TYPES),
    facts: z.array(documentFactSchema).max(20),
    suggested_category_slug: z.enum(CATEGORY_SLUGS).nullable(),
    description_english: z.string().max(1200),
    uncertain: z.boolean(),
  })
  .strict()
export type DocumentExtract = z.infer<typeof documentExtractSchema>

// ── drawings (deterministic; never a model) ──────────────────────────────────

export const DRAWING_FORMATS = ['step', 'dxf'] as const
export const drawingSummarySchema = z
  .object({
    format: z.enum(DRAWING_FORMATS),
    product_name: z.string().max(120).nullable(),
    units: z.string().max(16).nullable(),
    bbox_mm: z.tuple([z.number(), z.number(), z.number()]).nullable(),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    hole_estimate: z.number().int().nonnegative().nullable(),
    layers: z.array(z.string().max(60)).max(50),
    summary_english: z.string().max(600),
    spec_rows: z.array(z.object({ k: z.string().max(40), v: z.string().max(200) })).max(12),
  })
  .strict()
export type DrawingSummary = z.infer<typeof drawingSummarySchema>

// ── the route reply + the extraction row ─────────────────────────────────────

export const INTAKE_KINDS = ['clarify', 'document', 'drawing'] as const
export type IntakeKind = (typeof INTAKE_KINDS)[number]

export const intakeResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document'), extraction_id: uuidSchema, attachment: rfqAttachmentSchema, result: documentExtractSchema, stub: z.boolean() }),
  z.object({ kind: z.literal('drawing'), extraction_id: uuidSchema, attachment: rfqAttachmentSchema, result: drawingSummarySchema }),
])
export type IntakeResult = z.infer<typeof intakeResultSchema>

export const INTAKE_MODES = ['service', 'goods'] as const
export type IntakeMode = (typeof INTAKE_MODES)[number]

// ── masking clamp (every stored or returned fact) ────────────────────────────

const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g
const PAN_RE = /\b[A-Z]{5}\d{4}[A-Z]\b/g
const LONG_ID_RE = /\b(?=[A-Z0-9]{12,20}\b)(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{12,20}\b/g

/** GSTIN (15) and PAN (10) → last 4 characters visible; other long alphanumeric ids (12–20) likewise. */
export function maskIdentityNumbers(text: string): string {
  const last4 = (s: string) => `${'X'.repeat(Math.max(0, s.length - 4))}${s.slice(-4)}`
  return text.replace(GSTIN_RE, last4).replace(PAN_RE, last4).replace(LONG_ID_RE, last4)
}

/** Mask ids and strip contact details from every fact and the description; drop facts emptied by the clamp. */
export function clampDocumentExtract(d: DocumentExtract): DocumentExtract {
  const clean = (s: string) => redactContactInfo(maskIdentityNumbers(s)).text.trim()
  const facts = d.facts
    .map((f) => ({ ...f, k: clean(f.k).slice(0, 40), v: clean(f.v).slice(0, 200) }))
    .filter((f) => f.k.length > 0 && f.v.length > 0)
    .slice(0, 20)
  return documentExtractSchema.parse({ ...d, facts, description_english: clean(d.description_english).slice(0, 1200) })
}

/** Stub extraction (no LLM key): doc_type from a few printed words, no facts invented. */
export function stubDocumentExtract(text: string | null, mime: string): DocumentExtract {
  const t = (text ?? '').toLowerCase()
  const doc_type: DocType = /gst|goods and services tax|notice|section \d+|show cause/.test(t)
    ? 'gst_notice'
    : /invoice|tax invoice|bill no/.test(t)
      ? 'invoice'
      : /quotation|quote no|estimate/.test(t)
        ? 'quotation'
        : /drawing|dimension|tolerance/.test(t)
          ? 'drawing'
          : 'other'
  const facts: DocumentFact[] = []
  const gstin = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/.exec(text ?? '')
  if (gstin) facts.push({ k: 'GSTIN', v: gstin[0], confidence: 'high' })
  const section = /section\s+(\d+[A-Z]?)/i.exec(text ?? '')
  if (section) facts.push({ k: 'Section', v: section[1]!, confidence: 'medium' })
  const amount = /(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d+)?)/i.exec(text ?? '')
  if (amount) facts.push({ k: 'Amount', v: `₹${amount[1]}`, confidence: 'medium' })
  const due = /due (?:date|by)[:\s]+([0-9]{1,2}[-/.][0-9]{1,2}[-/.][0-9]{2,4})/i.exec(text ?? '')
  if (due) facts.push({ k: 'Due date', v: due[1]!, confidence: 'medium' })
  const suggested_category_slug = doc_type === 'gst_notice' ? ('tax-accounting' as const) : null
  const description_english = text
    ? `A ${doc_type.replace('_', ' ')} was uploaded (${mime}); stub mode read ${Math.min(text.length, 4000)} characters and extracted ${facts.length} fact(s).`
    : `A document image was uploaded (${mime}); stub mode cannot read images — facts pending a model key.`
  return { doc_type, facts, suggested_category_slug, description_english, uncertain: !text || facts.length === 0 }
}
