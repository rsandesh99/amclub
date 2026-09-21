import type { VoiceParse } from '@amclub/shared'
import { envelope } from '../untrusted/envelope'
import type { ChatImage, ChatParts } from '../llm/gateway'

/**
 * S1.8 — prompt parts for the voice/document intake calls. The rule every
 * builder here obeys (taint tests in parts.test.ts): a buyer's transcript, a
 * typed answer and a document's text enter ONLY as Envelopes in `untrusted`;
 * images carry a label only (never OCR'd text from the platform side); the
 * trusted block holds what the platform owns — vocabularies, the template's
 * field names, the prior-round JSON the platform itself produced, today.
 */

// ── rfq_parse@v1 / @v2 ───────────────────────────────────────────────────────

export interface RfqParsePrior {
  /** The first-round English transcript (untrusted again on round two). */
  transcript_english: string
  /** The first-round parse (platform-produced → trusted). */
  parse: VoiceParse
  /** The ONE question the buyer heard (platform-produced → trusted). */
  question: string
  gap: string
  /** Template-required field names the merged parse must cover (trusted). */
  requiredFields?: string[]
}

export interface RfqParsePartsInput {
  /** The English transcript of THIS round (round one: the clip; round two: the spoken answer) — or the typed answer. */
  transcript: string
  /** Provenance id for the envelope (request id, clip id, or 'clip'). */
  transcriptId: string
  originalLanguage: string
  categories: ReadonlyArray<{ slug: string; description: string }>
  specializations: Readonly<Record<string, ReadonlyArray<string>>>
  states: ReadonlyArray<{ value: string; label: string }>
  /** Round two only. */
  prior?: RfqParsePrior | null
  /** Round two only: true when `transcript` is the typed answer rather than a transcript. */
  answerTyped?: boolean
}

export function buildRfqParseParts(input: RfqParsePartsInput): ChatParts {
  const trusted = [
    `original_language: ${input.originalLanguage || 'unknown'}`,
    `categories:\n${input.categories.map((c) => `- ${c.slug}: ${c.description}`).join('\n')}`,
    `specializations:\n${Object.entries(input.specializations)
      .map(([slug, list]) => `- ${slug}: ${list.join(', ')}`)
      .join('\n')}`,
    `states: ${input.states.map((s) => `${s.value}=${s.label}`).join(', ')}`,
  ]
  const untrusted = []
  if (input.prior) {
    // Structured fields of the first parse are platform-clamped enums → trusted. Its
    // description_english is model prose restating the buyer → untrusted, like the transcript.
    const { description_english, ...structured } = input.prior.parse
    trusted.push(`prior_parse: ${JSON.stringify(structured)}`)
    trusted.push(`question_asked: ${input.prior.question}`)
    trusted.push(`gap: ${input.prior.gap}`)
    trusted.push(`required_fields: ${input.prior.requiredFields?.length ? input.prior.requiredFields.join(', ') : 'none'}`)
    untrusted.push(envelope(input.prior.transcript_english, { kind: 'voice_transcript', id: `${input.transcriptId}:prior` }))
    untrusted.push(envelope(description_english, { kind: 'prior_description', id: `${input.transcriptId}:prior` }))
    untrusted.push(envelope(input.transcript, { kind: input.answerTyped ? 'clarify_answer_text' : 'clarify_answer', id: input.transcriptId }))
  } else {
    untrusted.push(envelope(input.transcript, { kind: 'voice_transcript', id: input.transcriptId }))
  }
  return { trusted, untrusted }
}

// ── rfq_clarify@v1 ───────────────────────────────────────────────────────────

export interface ClarifyPartsInput {
  gap: string
  /** Target language for the question: te | hi | ta | en. */
  locale: string
  categorySlug: string | null
  /** Labels (English) of the template's required fields, when the category is known. */
  requiredFieldLabels: string[]
  transcript: string
  transcriptId: string
}

export function buildClarifyParts(input: ClarifyPartsInput): ChatParts {
  return {
    trusted: [
      `gap: ${input.gap}`,
      `locale: ${input.locale || 'en'}`,
      `category: ${input.categorySlug ?? 'unknown'}`,
      `required_fields: ${input.requiredFieldLabels.length ? input.requiredFieldLabels.join('; ') : 'none'}`,
    ],
    untrusted: [envelope(input.transcript, { kind: 'voice_transcript', id: input.transcriptId })],
  }
}

// ── document_extract@v1 ──────────────────────────────────────────────────────

export interface DocumentPartsInput {
  docId: string
  /** IST date, YYYY-MM-DD. */
  today: string
  categories: ReadonlyArray<{ slug: string; description: string }>
  mime: string
  /** Text PDFs: the extracted text (untrusted envelope). */
  text?: string | null
  /** Images: a signed or data URL; the model sees the label only. */
  imageUrl?: string | null
}

export function buildDocumentParts(input: DocumentPartsInput): ChatParts {
  const trusted = [
    `today: ${input.today}`,
    `document_label: doc`,
    `mime: ${input.mime}`,
    `categories:\n${input.categories.map((c) => `- ${c.slug}: ${c.description}`).join('\n')}`,
  ]
  const parts: ChatParts = { trusted }
  if (input.text && input.text.trim()) parts.untrusted = [envelope(input.text, { kind: 'document_text', id: input.docId })]
  if (input.imageUrl) {
    const image: ChatImage = { url: input.imageUrl, mime: input.mime, label: 'doc' }
    parts.images = [image]
  }
  return parts
}
