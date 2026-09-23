import { z } from 'zod'
import { orderIsActive } from './support'

/**
 * PRD Experience v3 E8b FR-8.4 (N24) — messaging on a paid order. Threads
 * are `conversations` rows with context_type 'order' (0059); the route masks
 * phone / email with `redactContactInfo` exactly like quote threads, and a
 * notification never carries the message text.
 */

/** The thread stays writable this many days after the order completes or is resolved; then it is read-only. */
export const ORDER_THREAD_OPEN_DAYS = 30
export const ORDER_MESSAGE_MAX = 1000
export const ORDER_MESSAGE_MAX_DOCS = 3

export const orderMessageSchema = z.object({
  body: z.string().trim().min(1).max(ORDER_MESSAGE_MAX),
  /** order_documents on THIS order (checked by the route), shown as links under the message. */
  documentIds: z.array(z.string().uuid()).max(ORDER_MESSAGE_MAX_DOCS).optional(),
}).strict()
export type OrderMessageInput = z.infer<typeof orderMessageSchema>

export type OrderThreadState = 'open' | 'read_only'

/**
 * Open while the order is active; after it ends (completed, resolved,
 * cancelled, refunded) for ORDER_THREAD_OPEN_DAYS from `completed_at` (or,
 * without one, the order's last update — when the ending status was set).
 */
export function orderThreadState(input: { status: string; completedAt: string | null; updatedAt: string | null; now?: number }): OrderThreadState {
  if (orderIsActive(input.status)) return 'open'
  const ended = Date.parse(input.completedAt ?? input.updatedAt ?? '')
  if (!Number.isFinite(ended)) return 'read_only'
  return (input.now ?? Date.now()) - ended <= ORDER_THREAD_OPEN_DAYS * 86_400_000 ? 'open' : 'read_only'
}

export const orderMessageViewSchema = z.object({
  id: z.string().uuid(),
  mine: z.boolean(),
  body: z.string(),
  redacted: z.boolean(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
  documents: z.array(z.object({ id: z.string().uuid(), fileName: z.string() })),
})
export type OrderMessageView = z.infer<typeof orderMessageViewSchema>
