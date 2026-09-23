import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CATEGORY_LIST, DrawingParseError, clampDocumentExtract, parseDxfSummary, parseStepSummary, stubDocumentExtract, type DocumentExtract, type DrawingSummary, type IntakeKind, type IntakeMode, type IntakeResult } from '@amclub/shared'
import { buildDocumentParts, documentExtractSchema } from '@amclub/agent-core'
import { BudgetExceededError, boundedChatJson } from '@/lib/agent/bounded'
import { recordAiDecision } from '@/lib/mart/events'
import type { StoredRfqAttachment } from '@/lib/rfq/attachments'

/**
 * S1.8 — intake server helpers. Every intake result becomes ONE
 * rfq_intake_extractions row (agent-owned telemetry + the prefill the buyer
 * saw); nothing here creates an RFQ. The Create tap on POST /api/v1/rfq calls
 * `checkIntakeExtractions` BEFORE its insert (theirs, unlinked, ≤ 4 — the S1.1
 * lesson) and `linkIntakeExtractions` after it: one ai_decisions row (feature
 * rfq_intake), rfq_id + decision_id on the rows. A linked row is never reused.
 */

export const INTAKE_MAX_IDS = 4
const PDF_MIN_TEXT_CHARS = 40

export interface IntakeRow {
  id: string
  user_id: string
  kind: IntakeKind
  proposed: unknown
  rfq_id: string | null
  decision_id: string | null
}

export async function insertIntakeExtraction(
  admin: SupabaseClient,
  row: { userId: string; kind: IntakeKind; inputRefs: Record<string, unknown>; proposed: unknown; model: string | null; stub: boolean; costEstPaise: number | null },
): Promise<string> {
  const { data, error } = await admin
    .from('rfq_intake_extractions')
    .insert({ user_id: row.userId, kind: row.kind, input_refs: row.inputRefs, proposed: row.proposed, model: row.model, stub: row.stub, cost_est_paise: row.costEstPaise })
    .select('id')
    .single()
  if (error || !data) throw new Error(`rfq_intake_extractions insert: ${error?.message ?? 'no row'}`)
  return data.id as string
}

export type IntakeCheckError = 'intake_too_many' | 'intake_not_found' | 'intake_not_owned' | 'intake_already_linked'

/** The Create tap's pre-insert check: every id exists, belongs to the caller, and is unlinked. */
export async function checkIntakeExtractions(admin: SupabaseClient, userId: string, ids: string[]): Promise<{ ok: true; rows: IntakeRow[] } | { ok: false; error: IntakeCheckError }> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return { ok: true, rows: [] }
  if (unique.length > INTAKE_MAX_IDS) return { ok: false, error: 'intake_too_many' }
  const { data } = await admin.from('rfq_intake_extractions').select('id, user_id, kind, proposed, rfq_id, decision_id').in('id', unique).is('deleted_at', null)
  const rows = (data ?? []) as IntakeRow[]
  if (rows.length !== unique.length) return { ok: false, error: 'intake_not_found' }
  if (rows.some((r) => r.user_id !== userId)) return { ok: false, error: 'intake_not_owned' }
  if (rows.some((r) => r.rfq_id !== null)) return { ok: false, error: 'intake_already_linked' }
  return { ok: true, rows }
}

/** After the RFQ insert: ONE ai_decisions row (feature rfq_intake), then rfq_id + decision_id on the rows (only while still unlinked). */
export async function linkIntakeExtractions(
  admin: SupabaseClient,
  args: { userId: string; rfqId: string; rows: IntakeRow[]; final: Record<string, unknown>; existingDecisionId?: string | null },
): Promise<string | null> {
  if (args.rows.length === 0) return null
  const ids = args.rows.map((r) => r.id)
  if (args.existingDecisionId) {
    // S3.1 — the procurement agent's create: the buyer's procurement_step decision IS the confirmation (no second row)
    const { error } = await admin.from('rfq_intake_extractions').update({ rfq_id: args.rfqId, decision_id: args.existingDecisionId }).in('id', ids).is('rfq_id', null)
    if (error) console.error('[intake link]', error.message)
    return args.existingDecisionId
  }
  const proposed: Record<string, unknown> = {}
  for (const r of args.rows) proposed[r.id] = { kind: r.kind, proposed: r.proposed }
  const tool = args.rows[0]!.kind === 'clarify' ? 'clarify_rfq' : 'extract_document'
  const decisionId = await recordAiDecision(
    admin,
    args.userId,
    { feature: 'rfq_intake', input_refs: { rfq_id: args.rfqId, extraction_ids: ids }, proposed, final: args.final },
    { runId: null, tool },
  )
  const { error } = await admin.from('rfq_intake_extractions').update({ rfq_id: args.rfqId, decision_id: decisionId }).in('id', ids).is('rfq_id', null)
  if (error) console.error('[intake link]', error.message)
  return decisionId
}

/** Text layer of a PDF via the pure-JS parser (no rasteriser). Empty for scanned PDFs. */
export async function extractPdfText(bytes: Buffer): Promise<string> {
  type PdfParse = (b: Buffer, o?: { max?: number }) => Promise<{ text: string }>
  // pdf-parse 1.1.1's index.js runs a self-test (reads ./test/data/… from cwd) whenever `module.parent` is falsy —
  // which a dynamic ESM import is. Import the library file directly; it has no side effects.
  const spec = 'pdf-parse/lib/pdf-parse.js'
  const mod: unknown = await import(/* webpackIgnore: true */ spec)
  const fn = (typeof mod === 'function' ? mod : (mod as { default?: unknown }).default) as PdfParse
  // pdf.js 1.10 reads the typed array's underlying ArrayBuffer without honouring byteOffset: a Node Buffer from the
  // small-buffer pool (< 4 KB, byteOffset ≠ 0) parses garbage at random ("bad XRef entry"). Hand it an exact copy.
  const exact = new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const out = await fn(exact as unknown as Buffer, { max: 20 })
  return (out.text ?? '').replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').trim()
}

export type DocumentIntakeError = 'pdf_no_text' | 'drawing_unreadable' | 'drawing_too_large' | 'budget_exceeded' | 'extract_failed'

const CATEGORIES = CATEGORY_LIST.map((c) => ({ slug: c.slug, description: c.description_i18n.en }))

/** Photo / text PDF → one frontier call; STEP / DXF → deterministic summary. Always one extraction row on success. */
export async function runDocumentIntake(
  admin: SupabaseClient,
  args: { userId: string; attachment: StoredRfqAttachment; mode: IntakeMode },
): Promise<{ ok: true; result: IntakeResult; row: { kind: IntakeKind; stub: boolean; facts: number; docType: string } } | { ok: false; error: DocumentIntakeError; detail?: string }> {
  const { attachment: a } = args
  const attachmentRef = { url: a.url, name: a.name }
  const baseRefs = { attachment_path: a.path, mime: a.mime, name: a.name, size_bytes: a.size, mode: args.mode }

  if (a.kind === 'step' || a.kind === 'dxf') {
    let summary: DrawingSummary
    try {
      const text = a.bytes.toString('utf8')
      summary = a.kind === 'step' ? parseStepSummary(text) : parseDxfSummary(text)
    } catch (e) {
      if (e instanceof DrawingParseError) return { ok: false, error: e.code, detail: e.message }
      return { ok: false, error: 'drawing_unreadable', detail: (e as Error).message }
    }
    const id = await insertIntakeExtraction(admin, { userId: args.userId, kind: 'drawing', inputRefs: { ...baseRefs, format: summary.format }, proposed: summary, model: null, stub: false, costEstPaise: 0 })
    return { ok: true, result: { kind: 'drawing', extraction_id: id, attachment: attachmentRef, result: summary }, row: { kind: 'drawing', stub: false, facts: summary.spec_rows.length, docType: summary.format } }
  }

  let text: string | null = null
  let imageUrl: string | null = null
  if (a.kind === 'pdf') {
    try {
      text = await extractPdfText(a.bytes)
    } catch (e) {
      console.error('[intake pdf]', (e as Error).message)
      text = ''
    }
    if (text.length < PDF_MIN_TEXT_CHARS) return { ok: false, error: 'pdf_no_text' }
    text = text.slice(0, 12_000)
  } else {
    imageUrl = `data:${a.mime};base64,${a.bytes.toString('base64')}`
  }

  const parts = buildDocumentParts({ docId: a.path, today: new Date().toISOString().slice(0, 10), categories: CATEGORIES, mime: a.mime, text, imageUrl })
  let extract: DocumentExtract
  let model: string | null = null
  let stub = false
  let cost: number | null = null
  try {
    const res = await boundedChatJson(admin, {
      userId: args.userId,
      feature: 'rfq_intake',
      taskClass: 'document_extract',
      promptId: 'document_extract',
      promptVersion: 'v1',
      schema: documentExtractSchema,
      parts,
      temperature: 0,
      stub: () => stubDocumentExtract(text, a.mime),
      meta: { attachment_path: a.path, mime: a.mime, mode: args.mode, kind: a.kind, text_chars: text?.length ?? 0 },
    })
    extract = clampDocumentExtract(res.data)
    model = res.stub ? null : res.model
    stub = res.stub
    cost = res.costPaise
  } catch (e) {
    if (e instanceof BudgetExceededError) return { ok: false, error: 'budget_exceeded' }
    console.error('[intake document]', (e as Error).message)
    return { ok: false, error: 'extract_failed', detail: (e as Error).message }
  }
  const id = await insertIntakeExtraction(admin, { userId: args.userId, kind: 'document', inputRefs: { ...baseRefs, text_chars: text?.length ?? 0 }, proposed: extract, model, stub, costEstPaise: cost })
  return { ok: true, result: { kind: 'document', extraction_id: id, attachment: attachmentRef, result: extract, stub }, row: { kind: 'document', stub, facts: extract.facts.length, docType: extract.doc_type } }
}
