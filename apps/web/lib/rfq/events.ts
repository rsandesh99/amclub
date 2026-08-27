import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

export type QuoteEventType =
  | 'submitted'
  | 'declined'
  | 'withdrawn'
  | 'accepted'
  | 'expired'
  | 'auto_declined'

export interface QuoteEventInput {
  quoteId: string
  eventType: QuoteEventType
  /** Acting user id; omit for cron/payment-driven events (recorded as 'system'). */
  actor?: string | null
  reason?: string | null
  payload?: Record<string, unknown> | null
}

/**
 * Append one row to quote_events (append-only history beside quotes.status).
 * Best-effort: a failure is logged loudly but never breaks the RFQ flow —
 * the status column remains the operational truth.
 */
export async function addQuoteEvent(admin: Admin, input: QuoteEventInput): Promise<void> {
  await addQuoteEvents(admin, [input])
}

export async function addQuoteEvents(admin: Admin, inputs: QuoteEventInput[]): Promise<void> {
  if (inputs.length === 0) return
  const rows = inputs.map((i) => ({
    quote_id: i.quoteId,
    event_type: i.eventType,
    actor: i.actor ?? 'system',
    reason: i.reason ?? null,
    payload: i.payload ?? null,
  }))
  const { error } = await admin.from('quote_events').insert(rows)
  if (error) {
    console.error('[quote_events] insert failed —', rows.length, 'row(s):', error.message)
  }
}
