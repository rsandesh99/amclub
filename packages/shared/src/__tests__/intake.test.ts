import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  clampDocumentExtract,
  classifyIntakeFile,
  clarifyLocaleFor,
  clarifyQuestionSchema,
  documentExtractSchema,
  drawingSummarySchema,
  intakeResultSchema,
  maskIdentityNumbers,
  needsClarification,
  parseDxfSummary,
  parseStepSummary,
  rfqSchema,
  stubDocumentExtract,
  voiceMetaSchema,
  voiceParsePriorSchema,
  voiceParseResponseSchema,
  DrawingParseError,
  type RfqTemplate,
  type VoiceParse,
} from '../index'

// ── the pinned STEP fixture (apps/web/tests/fixtures/drawings/cad1.step, 1 822 lines) ──
// Derived by running the parser (S1.8 §Ground truth: "the parser wins"): the plan's 1 solid / 51 faces /
// 17 cylindrical surfaces agree; the rest is what the parser returns and is pinned here.
export const CAD1_PINNED = {
  solids: 1,
  faces: 51,
  cylindrical_surfaces: 17,
  planes: 34,
  edges: 149,
  points: 300,
  hole_estimate: 9,
  bbox_mm: [60.5, 20.1, 506.3] as [number, number, number],
  units: 'mm',
  product_name: 'Untitled',
  ap: 'STEP AP214',
}

const stepPath = fileURLToPath(new URL('../../../../apps/web/tests/fixtures/drawings/cad1.step', import.meta.url))
const dxfPath = fileURLToPath(new URL('./fixtures/plate.dxf', import.meta.url))

const parse = (over: Partial<VoiceParse> = {}): VoiceParse => ({
  category_slug: 'tax-accounting',
  specialization: 'gst-filing',
  state: 'AP',
  description_english: 'File the monthly GST returns for my garment unit in Guntur; three returns are pending since April.',
  original_language: 'te-IN',
  uncertain: false,
  ...over,
})
const template: RfqTemplate = {
  fields: [
    { name: 'business_type', type: 'select', label_en: 'Business type', label_hi: 'व्यवसाय का प्रकार', required: true, options: ['Proprietorship', 'Partnership', 'Private Limited'] },
    { name: 'pending_periods', type: 'text', label_en: 'Pending periods', label_hi: 'लंबित अवधि', required: true },
    { name: 'city', type: 'text', label_en: 'City', label_hi: 'शहर', required: false },
    { name: 'additional_details', type: 'textarea', label_en: 'Additional details', label_hi: 'अन्य', required: false },
  ],
}

describe('S1.8 contracts', () => {
  it('clarify question is strict; the response carries it only as an optional key; the prior round validates', () => {
    expect(clarifyQuestionSchema.safeParse({ question: 'Which state is your business in?', gap: 'state', locale: 'en' }).success).toBe(true)
    expect(clarifyQuestionSchema.safeParse({ question: 'Which state?', gap: 'state', locale: 'en', extra: 1 }).success).toBe(false)
    expect(clarifyQuestionSchema.safeParse({ question: 'Hi?', gap: 'state', locale: 'en' }).success).toBe(false)
    const base = { transcript_english: 'x', parse: parse(), stub: true }
    expect(voiceParseResponseSchema.safeParse(base).success).toBe(true)
    expect(Object.keys(voiceParseResponseSchema.parse(base))).toEqual(['transcript_english', 'parse', 'stub'])
    expect(voiceParseResponseSchema.safeParse({ ...base, clarify: { question: 'Which state?', gap: 'state', locale: 'en', audio_data_url: null, extraction_id: '00000000-0000-4000-8000-000000000001' } }).success).toBe(true)
    expect(voiceParsePriorSchema.safeParse({ transcript_english: 'x', parse: parse(), question: { question: 'Which state?', gap: 'state', locale: 'en' }, answer_text: 'Andhra Pradesh' }).success).toBe(true)
  })

  it('voice_meta.clarify and rfq.intake_extraction_ids are optional additions (old bodies still validate)', () => {
    const meta = { transcript_english: 'x', parse: parse(), duration_ms: 20000, edited_fields: [], vendor: { stt: 'stub', parser: 'stub' } }
    expect(voiceMetaSchema.safeParse(meta).success).toBe(true)
    expect(voiceMetaSchema.safeParse({ ...meta, clarify: { question: 'Which state?', gap: 'state', answer_transcript: 'AP', answered_by: 'voice' } }).success).toBe(true)
    expect(voiceMetaSchema.safeParse({ ...meta, clarify: { question: 'Which state?', gap: 'state', answer_transcript: 'AP', answered_by: 'later' } }).success).toBe(false)
    const rfq = rfqSchema.parse({ category_slug: 'tax-accounting', title: 'GST filing for a garment unit', details: {} })
    expect(rfq.intake_extraction_ids).toEqual([])
    expect(rfqSchema.safeParse({ category_slug: 'tax-accounting', title: 'GST filing for a garment unit', details: {}, intake_extraction_ids: Array(5).fill('00000000-0000-4000-8000-000000000001') }).success).toBe(false)
  })

  it('document extract is strict; the drawing summary is strict; the intake result discriminates', () => {
    const doc = { doc_type: 'gst_notice', facts: [{ k: 'Section', v: '61', confidence: 'high' }], suggested_category_slug: 'tax-accounting', description_english: 'A notice.', uncertain: false }
    expect(documentExtractSchema.safeParse(doc).success).toBe(true)
    expect(documentExtractSchema.safeParse({ ...doc, amount_paise: 1 }).success).toBe(false)
    expect(documentExtractSchema.safeParse({ ...doc, facts: [{ k: 'x', v: 'y', confidence: 'high', extra: 1 }] }).success).toBe(false)
    expect(documentExtractSchema.safeParse({ ...doc, suggested_category_slug: 'not-a-category' }).success).toBe(false)
    const id = '00000000-0000-4000-8000-000000000001'
    expect(intakeResultSchema.safeParse({ kind: 'document', extraction_id: id, attachment: { url: 'rfq-attachments/a/b.png', name: 'b.png' }, result: doc, stub: true }).success).toBe(true)
    expect(intakeResultSchema.safeParse({ kind: 'drawing', extraction_id: id, attachment: { url: 'x', name: 'y' }, result: doc }).success).toBe(false)
  })
})

describe('S1.8 masking clamp', () => {
  it('GSTIN and PAN → last 4; phones and emails stripped; emptied facts dropped', () => {
    expect(maskIdentityNumbers('GSTIN 36AAACR1234A1Z5, PAN AAACR1234A')).toBe('GSTIN XXXXXXXXXXXA1Z5, PAN XXXXXX234A')
    const out = clampDocumentExtract({
      doc_type: 'invoice',
      facts: [
        { k: 'GSTIN', v: '36AAACR1234A1Z5', confidence: 'high' },
        { k: 'Contact', v: 'call 9876543210 or mail a@b.com', confidence: 'low' },
        { k: 'Amount', v: '₹12,500', confidence: 'medium' },
      ],
      suggested_category_slug: null,
      description_english: 'Invoice from PAN AAACR1234A; reach 9876543210.',
      uncertain: false,
    })
    expect(out.facts.find((f) => f.k === 'GSTIN')?.v).toBe('XXXXXXXXXXXA1Z5')
    expect(out.facts.find((f) => f.k === 'Contact')?.v ?? '').not.toMatch(/9876543210|a@b\.com/)
    expect(out.facts.find((f) => f.k === 'Amount')?.v).toBe('₹12,500')
    expect(out.description_english).not.toContain('AAACR1234A')
    expect(out.description_english).not.toContain('9876543210')
  })

  it('the stub extraction never invents facts and marks images uncertain', () => {
    const text = stubDocumentExtract('GST notice under section 61 — GSTIN 36AAACR1234A1Z5 — amount Rs. 45,000 due by 30/09/2026', 'application/pdf')
    expect(text.doc_type).toBe('gst_notice')
    expect(text.facts.map((f) => f.k)).toEqual(['GSTIN', 'Section', 'Amount', 'Due date'])
    expect(text.suggested_category_slug).toBe('tax-accounting')
    expect(documentExtractSchema.safeParse(clampDocumentExtract(text)).success).toBe(true)
    const img = stubDocumentExtract(null, 'image/png')
    expect(img.uncertain).toBe(true)
    expect(img.facts).toEqual([])
  })

  it('classifies uploads by extension first, then mime; refuses the rest', () => {
    expect(classifyIntakeFile('part.STEP', 'application/octet-stream')).toEqual({ kind: 'step', ext: 'step' })
    expect(classifyIntakeFile('part.stp', '')).toEqual({ kind: 'step', ext: 'stp' })
    expect(classifyIntakeFile('plate.dxf', 'image/vnd.dxf')).toEqual({ kind: 'dxf', ext: 'dxf' })
    expect(classifyIntakeFile('notice.pdf', 'application/pdf')).toEqual({ kind: 'pdf', ext: 'pdf' })
    expect(classifyIntakeFile('photo.jpeg', 'image/jpeg')).toEqual({ kind: 'image', ext: 'jpg' })
    expect(classifyIntakeFile('macro.xlsm', 'application/vnd.ms-excel')).toBeNull()
    expect(classifyIntakeFile('evil.exe', 'application/octet-stream')).toBeNull()
  })
})

describe('S1.8 needsClarification — the one rule', () => {
  it('category first: uncertain or no category → category', () => {
    expect(needsClarification(parse({ uncertain: true, category_slug: null }), template)).toEqual({ gap: 'category' })
    expect(needsClarification(parse({ category_slug: null }), template)).toEqual({ gap: 'category' })
  })
  it('then the first required template field the description does not cover (select options / keywords)', () => {
    const need = needsClarification(parse({ description_english: 'File the GST returns for my unit in Guntur, pending since April 2026.' }), template)
    expect(need?.gap).toBe('business_type')
    expect(need?.field?.label_en).toBe('Business type')
    const covered = needsClarification(parse({ description_english: 'Private limited garment unit in Guntur: file the GST returns pending since April 2026.' }), template)
    expect(covered).toBeNull()
  })
  it('then scope (thin description), then state (no state and no place named); nothing → null', () => {
    expect(needsClarification(parse({ description_english: 'GST filing help.' }), null)).toEqual({ gap: 'scope' })
    expect(needsClarification(parse({ state: null, description_english: 'File the monthly GST returns for my garment unit; three returns are pending since April.' }), null)).toEqual({ gap: 'state' })
    expect(needsClarification(parse({ state: null, description_english: 'File the monthly GST returns for my garment unit in Guntur; three returns are pending since April.' }), null)).toBeNull()
    expect(needsClarification(parse(), null)).toBeNull()
  })
  it('maps STT language codes to the four question languages', () => {
    expect(clarifyLocaleFor('te-IN')).toBe('te')
    expect(clarifyLocaleFor('hi-IN')).toBe('hi')
    expect(clarifyLocaleFor('ta-IN')).toBe('ta')
    expect(clarifyLocaleFor('kn-IN')).toBe('en')
    expect(clarifyLocaleFor('unknown')).toBe('en')
  })
})

describe('S1.8 drawings — deterministic, no model', () => {
  it('STEP: the pinned cad1.step counts, units, bbox and AP; under 2 s', () => {
    const text = readFileSync(stepPath, 'utf8')
    const t0 = Date.now()
    const s = parseStepSummary(text)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(drawingSummarySchema.safeParse(s).success).toBe(true)
    expect(s.format).toBe('step')
    expect(s.product_name).toBe(CAD1_PINNED.product_name)
    expect(s.units).toBe(CAD1_PINNED.units)
    expect(s.bbox_mm).toEqual(CAD1_PINNED.bbox_mm)
    expect(s.counts).toEqual({ solids: CAD1_PINNED.solids, faces: CAD1_PINNED.faces, cylindrical_surfaces: CAD1_PINNED.cylindrical_surfaces, planes: CAD1_PINNED.planes, edges: CAD1_PINNED.edges, points: CAD1_PINNED.points })
    expect(s.hole_estimate).toBe(CAD1_PINNED.hole_estimate)
    expect(s.spec_rows.find((r) => r.k === 'Source')?.v).toBe(CAD1_PINNED.ap)
    expect(s.spec_rows.find((r) => r.k === 'Material')?.v).toBe('not stated')
    expect(s.summary_english).toContain("Machined part 'Untitled'")
    expect(s.summary_english).toContain('51 faces')
    expect(s.summary_english).toContain('about 9 holes')
  })
  it('STEP: refuses non-STEP text and oversized input', () => {
    expect(() => parseStepSummary('%PDF-1.4 not a step file')).toThrow(DrawingParseError)
    expect(() => parseStepSummary('ISO-10303-21;' + 'x'.repeat(10 * 1024 * 1024 + 1))).toThrow(/drawing_too_large/)
  })
  it('DXF: units, extents, layers and entity counts from the hand-written plate', () => {
    const s = parseDxfSummary(readFileSync(dxfPath, 'utf8'))
    expect(drawingSummarySchema.safeParse(s).success).toBe(true)
    expect(s.format).toBe('dxf')
    expect(s.units).toBe('mm')
    expect(s.bbox_mm).toEqual([120, 80, 0])
    expect(s.layers).toEqual(['OUTLINE', 'HOLES'])
    expect(s.counts).toEqual({ LINE: 2, CIRCLE: 3, ARC: 1, LWPOLYLINE: 1, TEXT: 1, MTEXT: 0, INSERT: 0, entities: 8 })
    expect(s.hole_estimate).toBe(3)
    expect(s.spec_rows.find((r) => r.k === 'Overall size')?.v).toBe('120 × 80 mm')
    expect(s.spec_rows.find((r) => r.k === 'Layers')?.v).toBe('OUTLINE, HOLES')
    expect(s.summary_english).toContain('8 entities on 2 layers')
    expect(s.summary_english).not.toContain('PLATE 120x80') // TEXT content is not summarised
  })
  it('DXF: inch drawings convert to mm; binary DXF and non-DXF text are refused', () => {
    const inch = readFileSync(dxfPath, 'utf8').replace('$INSUNITS\n70\n4', '$INSUNITS\n70\n1')
    expect(parseDxfSummary(inch).units).toBe('inch')
    expect(parseDxfSummary(inch).bbox_mm).toEqual([3048, 2032, 0])
    const code = (fn: () => unknown): string | null => { try { fn(); return null } catch (e) { return e instanceof DrawingParseError ? e.code : 'other' } }
    expect(code(() => parseDxfSummary('AutoCAD Binary DXF\r\n\u001a\u0000'))).toBe('drawing_unreadable')
    expect(code(() => parseDxfSummary('hello\nworld'))).toBe('drawing_unreadable')
    expect(code(() => parseStepSummary('%PDF-1.4 not a step file'))).toBe('drawing_unreadable')
  })
})
