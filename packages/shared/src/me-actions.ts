import { z } from 'zod'
import { NEXT_ACTIONS } from './order-next-action'

/**
 * N2 — `GET /api/v1/me/actions`: what needs the viewer's action, per role,
 * with the counts the nav badges show. Items are ordered by deadline (then
 * newest). Titles are the user's own content (RFQ / order titles), already
 * visible to the viewer; the client renders the rest from i18n keys.
 *
 * E9 (FR-9.1, N25) — the buyer kinds of the home's "Needs your action":
 * `quotes_waiting` carries the lowest normalised total (`compareQuotes`),
 * `quote_expiring` is a submitted quote whose validity ends within 48 h, and
 * order rows stay `order_action` with the N23 key (`share_requirements`,
 * `review_delivery`, `dispute_statement`, …) so the home, the order's
 * NextStepBar and notifications read one rule. `clarification_question` is
 * the PRD's `answer_clarification`.
 */
export const ACTION_ITEM_KINDS = ['order_action', 'quotes_waiting', 'quote_expiring', 'clarification_question', 'rfq_new', 'buyer_message', 'munshi_draft'] as const
export type ActionItemKind = (typeof ACTION_ITEM_KINDS)[number]

const base = {
  objectId: z.string(),
  title: z.string(),
  /** order_action only: the N23 action key. */
  action: z.enum(NEXT_ACTIONS).nullable(),
  /** quotes_waiting: number of quotes; clarification_question: open questions. */
  count: z.number().int().nullable(),
  dueAt: z.string().nullable(),
  href: z.string(),
}

export const actionItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('order_action'), ...base }),
  z.object({
    kind: z.literal('quotes_waiting'),
    ...base,
    /** E9 — the lowest normalised all-in total among the submitted quotes (server `compareQuotes`); null when not computed. */
    fromPaise: z.number().int().nullable().optional(),
  }),
  z.object({
    kind: z.literal('quote_expiring'),
    ...base,
    /** The quoting provider's public display name (already shown on the buyer's compare screen). */
    providerName: z.string(),
  }),
  z.object({ kind: z.literal('clarification_question'), ...base }),
  z.object({ kind: z.literal('rfq_new'), ...base }),
  // E11 (FR-11.1) provider kinds: a buyer's message on my quote waiting for my reply, and a Munshi draft ready (dark, S2.2).
  z.object({ kind: z.literal('buyer_message'), ...base }),
  z.object({ kind: z.literal('munshi_draft'), ...base }),
])
export type ActionItem = z.infer<typeof actionItemSchema>

export const meActionsSchema = z.object({
  buyer: z
    .object({
      counts: z.object({ requirements: z.number().int(), orders: z.number().int() }),
      items: z.array(actionItemSchema),
    })
    .nullable(),
  provider: z
    .object({
      counts: z.object({ rfqs: z.number().int(), orders: z.number().int() }),
      items: z.array(actionItemSchema),
    })
    .nullable(),
})
export type MeActions = z.infer<typeof meActionsSchema>

/** Deadline first (soonest), undated after, then by title for a stable order. */
export function sortActionItems<T extends Pick<ActionItem, 'dueAt' | 'title'>>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.dueAt && b.dueAt) return Date.parse(a.dueAt) - Date.parse(b.dueAt)
    if (a.dueAt) return -1
    if (b.dueAt) return 1
    return a.title.localeCompare(b.title)
  })
}

/** FR-9.1 — the home shows at most this many rows, then "See all". */
export const HOME_ACTION_MAX = 5
/** FR-9.1 — a submitted quote is "expiring" when its validity ends within this many hours. */
export const QUOTE_EXPIRING_HOURS = 48

/**
 * The instant a quote's `valid_until` (an IST calendar date, YYYY-MM-DD) ends:
 * 23:59:59.999 IST that day, as UTC ISO. Null for anything else.
 */
export function quoteValidityEndsAt(validUntil: string | null | undefined): string | null {
  if (!validUntil || !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) return null
  const t = Date.parse(`${validUntil}T23:59:59.999+05:30`)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** True when the quote is still valid and its validity ends within QUOTE_EXPIRING_HOURS of `now`. */
export function isQuoteExpiringSoon(validUntil: string | null | undefined, now: Date = new Date()): boolean {
  const end = quoteValidityEndsAt(validUntil)
  if (!end) return false
  const ms = Date.parse(end) - now.getTime()
  return ms >= 0 && ms <= QUOTE_EXPIRING_HOURS * 3600 * 1000
}
