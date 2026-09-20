import { z } from 'zod'

/**
 * Trust mechanics (BUILD_PROMPTS S0.4). Quote-or-decline: a matched provider
 * either quotes or declines with a reason within the quote window; silence is
 * auto-declined by the rfq-expire cron. A decline is recorded on rfq_matches
 * (declined_at + decline_reason) — the source of truth the score view reads —
 * so a declined match is an ACTIVE decision, never "ignored".
 */

export const DECLINE_REASONS = ['not_my_specialty', 'capacity', 'location', 'budget', 'other'] as const
export type DeclineReason = (typeof DECLINE_REASONS)[number]
export const declineReasonSchema = z.enum(DECLINE_REASONS)

/** System reason written by the cron when the quote window lapses with no action. */
export const DECLINE_REASON_WINDOW_LAPSED = 'window_lapsed' as const
export type AnyDeclineReason = DeclineReason | typeof DECLINE_REASON_WINDOW_LAPSED

/** POST /api/v1/rfq/[id]/decline body. */
export const rfqDeclineSchema = z.object({
  reason: declineReasonSchema,
  note: z.string().trim().max(300).optional(),
})
export type RfqDeclineInput = z.infer<typeof rfqDeclineSchema>

/** Historical hard-coded cap; the fallback when agent_settings.rfq_max_quotes is unset. */
export const RFQ_MAX_QUOTES_LEGACY = 7

/** Clamp a configured cap into the allowed band (defensive; the registry already validates). */
export function effectiveQuoteCap(configured: unknown): number {
  // Only a genuine integer counts as configured: null/undefined/"" must fall
  // back to the legacy cap (Number(null) === 0 would otherwise clamp to 3).
  if (typeof configured !== 'number' || !Number.isInteger(configured)) return RFQ_MAX_QUOTES_LEGACY
  return Math.min(7, Math.max(3, configured))
}

/**
 * Has this match's quote window lapsed? Pure: given when the provider was
 * notified, the window (hours) and now. Used by the cron sweep and its test.
 */
export function quoteWindowLapsed(notifiedAt: Date, windowHours: number, now: Date): boolean {
  return now.getTime() - notifiedAt.getTime() >= windowHours * 3600 * 1000
}
