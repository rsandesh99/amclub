import { z } from 'zod'
import { NEXT_ACTIONS } from './order-next-action'

/**
 * N2 — `GET /api/v1/me/actions`: what needs the viewer's action, per role,
 * with the counts the nav badges show. Items are ordered by deadline (then
 * newest). Titles are the user's own content (RFQ / order titles), already
 * visible to the viewer; the client renders the rest from i18n keys.
 */
export const ACTION_ITEM_KINDS = ['order_action', 'quotes_waiting', 'clarification_question', 'rfq_new'] as const
export type ActionItemKind = (typeof ACTION_ITEM_KINDS)[number]

export const actionItemSchema = z.object({
  kind: z.enum(ACTION_ITEM_KINDS),
  objectId: z.string(),
  title: z.string(),
  /** order_action only: the N23 action key. */
  action: z.enum(NEXT_ACTIONS).nullable(),
  /** quotes_waiting: number of quotes; clarification_question: open questions. */
  count: z.number().int().nullable(),
  dueAt: z.string().nullable(),
  href: z.string(),
})
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
export function sortActionItems(items: ActionItem[]): ActionItem[] {
  return [...items].sort((a, b) => {
    if (a.dueAt && b.dueAt) return Date.parse(a.dueAt) - Date.parse(b.dueAt)
    if (a.dueAt) return -1
    if (b.dueAt) return 1
    return a.title.localeCompare(b.title)
  })
}
