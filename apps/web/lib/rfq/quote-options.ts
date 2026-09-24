import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { QuoteOptionInput, QuoteOptionLabel, QuoteOptionRow } from '@amclub/shared'
import { getAgentSetting } from '@/lib/agent/settings'

/**
 * E12b / ADR 020 — quote speed options. `quote_options` is service-role only;
 * every reader here is tolerant (switch off, table absent before 0066, any
 * error → no options), so a quote without options behaves exactly as before.
 * Rows are immutable and keyed by the quote's revision: a revision writes a new
 * set, and a checkout session frozen on an older row still resolves.
 */
export async function quoteOptionsOn(admin: SupabaseClient): Promise<boolean> {
  try {
    return (await getAgentSetting(admin, 'quote_options_enabled')) === true
  } catch {
    return false
  }
}

export async function writeQuoteOptions(admin: SupabaseClient, quoteId: string, revision: number, options: readonly QuoteOptionInput[]): Promise<boolean> {
  if (options.length === 0) return true
  const { error } = await admin.from('quote_options').insert(options.map((o) => ({ quote_id: quoteId, revision, label: o.label, price_paise: o.price_paise, delivery_days: o.delivery_days })))
  if (error) console.error('[quote-options] write', quoteId, error.message)
  return !error
}

/** The CURRENT revision's options per quote (Economy / Express; Standard is the quote row). */
export async function loadQuoteOptions(admin: SupabaseClient, quotes: readonly { id: string; revision: number }[]): Promise<Map<string, QuoteOptionRow[]>> {
  const out = new Map<string, QuoteOptionRow[]>()
  if (quotes.length === 0 || !(await quoteOptionsOn(admin))) return out
  try {
    const { data, error } = await admin.from('quote_options').select('id, quote_id, revision, label, price_paise, delivery_days').in('quote_id', quotes.map((q) => q.id))
    if (error) return out
    const current = new Map(quotes.map((q) => [q.id, q.revision]))
    for (const r of (data ?? []) as { id: string; quote_id: string; revision: number; label: QuoteOptionLabel; price_paise: number; delivery_days: number }[]) {
      if (current.get(r.quote_id) !== r.revision) continue
      out.set(r.quote_id, [...(out.get(r.quote_id) ?? []), { id: r.id, label: r.label, pricePaise: Number(r.price_paise), deliveryDays: r.delivery_days }])
    }
  } catch {
    /* no options */
  }
  return out
}

/** One option for checkout: it must be this quote's, at the quote's current revision. */
export async function optionForCheckout(admin: SupabaseClient, quoteId: string, optionId: string, revision: number): Promise<QuoteOptionRow | null> {
  const { data } = await admin.from('quote_options').select('id, quote_id, revision, label, price_paise, delivery_days').eq('id', optionId).maybeSingle()
  const r = data as { id: string; quote_id: string; revision: number; label: QuoteOptionLabel; price_paise: number; delivery_days: number } | null
  if (!r || r.quote_id !== quoteId || r.revision !== revision) return null
  return { id: r.id, label: r.label, pricePaise: Number(r.price_paise), deliveryDays: r.delivery_days }
}

/** The option an order's session was frozen on (null = Standard, or before 0066). Never throws. */
export async function optionForOrder(admin: SupabaseClient, orderId: string): Promise<QuoteOptionRow | null> {
  try {
    const { data: s, error } = await admin.from('checkout_sessions').select('quote_option_id').eq('order_id', orderId).limit(1).maybeSingle()
    const optionId = (s as { quote_option_id?: string | null } | null)?.quote_option_id
    if (error || !optionId) return null
    const { data } = await admin.from('quote_options').select('id, label, price_paise, delivery_days').eq('id', optionId).maybeSingle()
    const r = data as { id: string; label: QuoteOptionLabel; price_paise: number; delivery_days: number } | null
    return r ? { id: r.id, label: r.label, pricePaise: Number(r.price_paise), deliveryDays: r.delivery_days } : null
  } catch {
    return null
  }
}
