import type { WaLocale } from './types'

/**
 * Template registry (S0.5). One entry per notification kind used today, with
 * per-locale APPROVED template names and a param builder from the notification
 * payload. Names here are exactly what gets submitted for approval
 * (docs/PRE_LAUNCH_CHECKLIST.md Track 1.3). The dispatcher sends nothing for a
 * kind that is not registered — an unknown kind can never reach the vendor.
 *
 * Opt-in policy: the ALWAYS_ALLOWED set is order/payment events to a party of
 * the order (transactional under the BSP policy). Every other kind requires an
 * active agent_grants row with channel='whatsapp' (the user's opt-in).
 */

export interface TemplateSpec {
  /** Approved template name per locale (falls back to en). */
  names: Partial<Record<WaLocale, string>> & { en: string }
  /** Ordered body params from the notification's rendered title/body/link. */
  params: (n: { title: string; body: string; link: string | null }) => string[]
}

const titleBody = (n: { title: string; body: string }) => [n.title, n.body]

export const WA_TEMPLATES: Record<string, TemplateSpec> = {
  order_placed: { names: { en: 'amc_order_placed_en', hi: 'amc_order_placed_hi' }, params: titleBody },
  order_accepted: { names: { en: 'amc_order_accepted_en', hi: 'amc_order_accepted_hi' }, params: titleBody },
  requirements_submitted: { names: { en: 'amc_requirements_submitted_en', hi: 'amc_requirements_submitted_hi' }, params: titleBody },
  order_in_progress: { names: { en: 'amc_order_in_progress_en', hi: 'amc_order_in_progress_hi' }, params: titleBody },
  order_delivered: { names: { en: 'amc_order_delivered_en', hi: 'amc_order_delivered_hi' }, params: titleBody },
  order_completed: { names: { en: 'amc_order_completed_en', hi: 'amc_order_completed_hi' }, params: titleBody },
  order_cancelled: { names: { en: 'amc_order_cancelled_en', hi: 'amc_order_cancelled_hi' }, params: titleBody },
  order_auto_cancelled: { names: { en: 'amc_order_auto_cancelled_en', hi: 'amc_order_auto_cancelled_hi' }, params: titleBody },
  order_disputed: { names: { en: 'amc_order_disputed_en', hi: 'amc_order_disputed_hi' }, params: titleBody },
  revision_requested: { names: { en: 'amc_revision_requested_en', hi: 'amc_revision_requested_hi' }, params: titleBody },
  milestone_added: { names: { en: 'amc_milestone_added_en', hi: 'amc_milestone_added_hi' }, params: titleBody },
  review_prompt: { names: { en: 'amc_review_prompt_en', hi: 'amc_review_prompt_hi' }, params: titleBody },
  rfq_matched: { names: { en: 'amc_rfq_matched_en', hi: 'amc_rfq_matched_hi' }, params: titleBody },
  rfq_new_quote: { names: { en: 'amc_rfq_new_quote_en', hi: 'amc_rfq_new_quote_hi' }, params: titleBody },
  rfq_providers_unavailable: { names: { en: 'amc_rfq_unavailable_en', hi: 'amc_rfq_unavailable_hi' }, params: titleBody },
  quote_accepted: { names: { en: 'amc_quote_accepted_en', hi: 'amc_quote_accepted_hi' }, params: titleBody },
  quote_declined: { names: { en: 'amc_quote_declined_en', hi: 'amc_quote_declined_hi' }, params: titleBody },
  quote_message: { names: { en: 'amc_quote_message_en', hi: 'amc_quote_message_hi' }, params: titleBody },
  payout_paid: { names: { en: 'amc_payout_paid_en', hi: 'amc_payout_paid_hi' }, params: titleBody },
  // System templates used by the inbound job (opt-in / opt-out / holding reply).
  wa_opt_in_confirmed: { names: { en: 'amc_wa_opt_in_en', hi: 'amc_wa_opt_in_hi' }, params: () => [] },
  wa_opt_out_confirmed: { names: { en: 'amc_wa_opt_out_en', hi: 'amc_wa_opt_out_hi' }, params: () => [] },
  wa_holding_reply: { names: { en: 'amc_wa_holding_en', hi: 'amc_wa_holding_hi' }, params: () => [] },
}

/** Order/payment events to a party of the order — sendable without a WhatsApp grant. */
export const WA_ALWAYS_ALLOWED_KINDS: ReadonlySet<string> = new Set([
  'order_placed', 'order_accepted', 'requirements_submitted', 'order_in_progress', 'order_delivered',
  'order_completed', 'order_cancelled', 'order_auto_cancelled', 'order_disputed', 'revision_requested',
  'milestone_added', 'payout_paid',
])

/** Every approved template name, for the checklist and the eval. */
export function allTemplateNames(): string[] {
  const out = new Set<string>()
  for (const spec of Object.values(WA_TEMPLATES)) for (const n of Object.values(spec.names)) if (n) out.add(n)
  return [...out].sort()
}

export function templateFor(kind: string, locale: WaLocale): { name: string; spec: TemplateSpec } | null {
  const spec = WA_TEMPLATES[kind]
  if (!spec) return null
  return { name: spec.names[locale] ?? spec.names.en, spec }
}

// ── Opt-in / opt-out keywords (S0.5 inbound job) ─────────────────────────────
// Plain words a user types to consent or revoke. Case/whitespace-insensitive;
// vernacular equivalents included so a Hindi/Telugu user is never stuck.
export const WA_OPT_IN_KEYWORDS: ReadonlySet<string> = new Set([
  'start', 'join', 'yes', 'ok', 'hi', 'hello', 'namaste',
  'शुरू', 'हाँ', 'हां', 'जुड़ें', 'नमस्ते',
  'ప్రారంభం', 'అవును', 'నమస్తే',
])
export const WA_OPT_OUT_KEYWORDS: ReadonlySet<string> = new Set([
  'stop', 'unsubscribe', 'no', 'cancel',
  'बंद', 'रोकें', 'नहीं',
  'ఆపు', 'వద్దు',
])

export function classifyKeyword(text: string | null): 'opt_in' | 'opt_out' | null {
  if (!text) return null
  const t = text.trim().toLowerCase().normalize('NFKC')
  if (WA_OPT_OUT_KEYWORDS.has(t)) return 'opt_out'
  if (WA_OPT_IN_KEYWORDS.has(t)) return 'opt_in'
  return null
}
