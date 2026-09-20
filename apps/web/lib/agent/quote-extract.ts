import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AGENT_ENABLED } from '@/lib/flags'
import { isAgentEnabledForUser } from '@/lib/agent/settings'

/**
 * Quote-extraction helpers for the web routes/pages (S1.1). The pure pieces —
 * schema, clamp, stub producer, edited-fields diff — live in @amclub/shared
 * (quote-extraction.ts, unit-tested there; apps/web has no test runner) and the
 * prompt-parts builder in @amclub/agent-core (buildQuoteExtractParts, tested).
 */
export { clampQuoteExtraction, emptyExtraction, editedExtractFields } from '@amclub/shared'
export { buildQuoteExtractParts } from '@amclub/agent-core'

/** IST calendar date, YYYY-MM-DD — the trusted `today` the prompt resolves relative dates from. */
export function todayIST(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}`
}

/** AGENT_ENABLED + agents_enabled.quote_extract + cohort — for THIS user. */
export async function isQuoteExtractEnabledFor(admin: SupabaseClient, userId: string): Promise<boolean> {
  if (!AGENT_ENABLED) return false
  return isAgentEnabledForUser(admin, 'quote_extract', userId)
}
