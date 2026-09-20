import { z } from 'zod'
import { rfqIsActive } from './rfq'

/**
 * RFQ clarification threads (BUILD_PROMPTS S1.3).
 *
 * A matched provider asks a question on an active RFQ; the buyer answers once.
 * Every question and answer is visible to EVERY matched provider of that RFQ
 * (fairness, and it kills duplicate questions) — a provider never learns which
 * competitor asked. "In clarification" is DERIVED (an active RFQ with at least
 * one unanswered question), never an RFQ status: `rfqIsActive`, the 72-hour
 * window and the expiry cron are untouched. Both free-text fields cross
 * parties, so they pass `redactContactInfo` before storage and carry a
 * `*_redacted` flag. Pure contracts + helpers here; no I/O.
 */

/** Open (unanswered) questions one provider may hold on one RFQ at a time. */
export const CLARIFICATION_MAX_OPEN_PER_PROVIDER = 3
export const CLARIFICATION_QUESTION_MIN = 10
export const CLARIFICATION_QUESTION_MAX = 500
export const CLARIFICATION_ANSWER_MAX = 1000

export const clarificationAskSchema = z.object({
  question: z.string().trim().min(CLARIFICATION_QUESTION_MIN).max(CLARIFICATION_QUESTION_MAX),
})
export type ClarificationAskInput = z.infer<typeof clarificationAskSchema>

export const clarificationAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(CLARIFICATION_ANSWER_MAX),
})
export type ClarificationAnswerInput = z.infer<typeof clarificationAnswerSchema>

/** What both parties read. `provider_id` is NEVER part of this shape. */
export interface ClarificationView {
  id: string
  question: string
  answer: string | null
  askedAt: string
  answeredAt: string | null
  /** Provider view: I asked it (so the UI can say "you asked"). Always false for the buyer. */
  mine: boolean
  questionRedacted: boolean
  answerRedacted: boolean
  /** Buyer view only — the asking provider's display name (the buyer sees it on the quote anyway). Absent for providers. */
  askedByName?: string | null
}

export const clarificationViewSchema = z.object({
  id: z.string().uuid(),
  question: z.string(),
  answer: z.string().nullable(),
  askedAt: z.string(),
  answeredAt: z.string().nullable(),
  mine: z.boolean(),
  questionRedacted: z.boolean(),
  answerRedacted: z.boolean(),
  askedByName: z.string().nullable().optional(),
})

/** Unanswered questions in a list (soft-deleted rows are never in the list). */
export function openQuestionCount(list: readonly Pick<ClarificationView, 'answeredAt'>[]): number {
  let n = 0
  for (const c of list) if (c.answeredAt === null) n++
  return n
}

/** Derived state: an active RFQ (open | quoted) with at least one unanswered question. Never a status. */
export function isInClarification(rfqStatus: string, list: readonly Pick<ClarificationView, 'answeredAt'>[]): boolean {
  return rfqIsActive(rfqStatus) && openQuestionCount(list) > 0
}

/** Display order: unanswered first, then oldest asked first. Stable for equal keys. */
export function sortClarifications<T extends Pick<ClarificationView, 'answeredAt' | 'askedAt'>>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => {
    const ao = a.answeredAt === null ? 0 : 1
    const bo = b.answeredAt === null ? 0 : 1
    if (ao !== bo) return ao - bo
    return a.askedAt < b.askedAt ? -1 : a.askedAt > b.askedAt ? 1 : 0
  })
}

/** Whole hours between ask and answer, for the `rfq_question_answered` event (never negative). */
export function hoursToAnswer(askedAt: string, answeredAt: string): number {
  const ms = new Date(answeredAt).getTime() - new Date(askedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 0
  return Math.round((ms / 3_600_000) * 10) / 10
}
