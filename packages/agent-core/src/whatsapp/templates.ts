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
  // S2.3 — Support agent (opt-in gated except the transactional nudges below). Params from the notification's title/body.
  support_reply: { names: { en: 'amc_support_reply_en', hi: 'amc_support_reply_hi', te: 'amc_support_reply_te' }, params: titleBody },
  support_escalated: { names: { en: 'amc_support_escalated_en', hi: 'amc_support_escalated_hi', te: 'amc_support_escalated_te' }, params: (n) => [n.title] },
  support_ticket_opened: { names: { en: 'amc_support_ticket_opened_en', hi: 'amc_support_ticket_opened_hi' }, params: (n) => [n.body] },
  support_resolved: { names: { en: 'amc_support_resolved_en', hi: 'amc_support_resolved_hi', te: 'amc_support_resolved_te' }, params: (n) => [n.body] },
  order_nudge: { names: { en: 'amc_order_nudge_en', hi: 'amc_order_nudge_hi', te: 'amc_order_nudge_te' }, params: (n) => [n.body] },
  rfq_nudge: { names: { en: 'amc_rfq_nudge_en', hi: 'amc_rfq_nudge_hi', te: 'amc_rfq_nudge_te' }, params: (n) => [n.body] },
  // S2.2 — Digital Munshi (provider-facing; opt-in gated). Params from the notification's title/body.
  munshi_draft: { names: { en: 'amc_munshi_draft_en', hi: 'amc_munshi_draft_hi', te: 'amc_munshi_draft_te' }, params: titleBody },
  munshi_window_warning: { names: { en: 'amc_munshi_window_warning_en', hi: 'amc_munshi_window_warning_hi', te: 'amc_munshi_window_warning_te' }, params: titleBody },
  munshi_reply_draft: { names: { en: 'amc_munshi_reply_draft_en', hi: 'amc_munshi_reply_draft_hi', te: 'amc_munshi_reply_draft_te' }, params: (n) => [n.title] },
  munshi_result: { names: { en: 'amc_munshi_result_en', hi: 'amc_munshi_result_hi', te: 'amc_munshi_result_te' }, params: (n) => [n.body] },
  // S2.4 — the weekly growth nudge (opt-in gated; informational): [the nudge line]
  munshi_growth: { names: { en: 'amc_munshi_growth_en', hi: 'amc_munshi_growth_hi', te: 'amc_munshi_growth_te' }, params: (n) => [n.body] },
  // S3.1 — the procurement agent outside the 24 h window: one line of the message + the assistant link (decisions then
  // happen in the app; buttons are in-window only). Buyer; opt-in gated. en/hi/te.
  procurement_update: { names: { en: 'amc_procurement_update_en', hi: 'amc_procurement_update_hi', te: 'amc_procurement_update_te' }, params: (n) => [n.body.split('\n')[0]!.slice(0, 300), n.link ?? ''] },
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
  // S1.3 — clarification threads (buyer ← question; every matched provider ← answer) and quote revision (buyer).
  rfq_question: { names: { en: 'amc_rfq_question_en', hi: 'amc_rfq_question_hi' }, params: titleBody },
  rfq_answer: { names: { en: 'amc_rfq_answer_en', hi: 'amc_rfq_answer_hi' }, params: titleBody },
  quote_revised: { names: { en: 'amc_quote_revised_en', hi: 'amc_quote_revised_hi' }, params: titleBody },
  payout_paid: { names: { en: 'amc_payout_paid_en', hi: 'amc_payout_paid_hi' }, params: titleBody },
  // S1.7 — a party's dispute statement (counter-party) and the ops triage card (ops user; opt-in gated).
  dispute_statement: { names: { en: 'amc_dispute_statement_en', hi: 'amc_dispute_statement_hi' }, params: titleBody },
  dispute_triage_ready: { names: { en: 'amc_dispute_triage_ready_en', hi: 'amc_dispute_triage_ready_hi' }, params: titleBody },
  // S1.4 — founder one-tap (ops user; requires the founder's own WhatsApp opt-in grant).
  payout_dossier_ready: { names: { en: 'amc_payout_dossier_ready_en', hi: 'amc_payout_dossier_ready_hi' }, params: titleBody },
  // S1.6 — Onboarding agent (provider; opt-in gated). Sent by the runtime outside the 24h window:
  // start [name], resume [step label], draft ready [display_name], expired [link]. en/hi/te.
  onboarding_start: { names: { en: 'amc_onboarding_start_en', hi: 'amc_onboarding_start_hi', te: 'amc_onboarding_start_te' }, params: (n) => [n.title] },
  onboarding_resume: { names: { en: 'amc_onboarding_resume_en', hi: 'amc_onboarding_resume_hi', te: 'amc_onboarding_resume_te' }, params: (n) => [n.title] },
  onboarding_draft_ready: { names: { en: 'amc_onboarding_draft_ready_en', hi: 'amc_onboarding_draft_ready_hi', te: 'amc_onboarding_draft_ready_te' }, params: (n) => [n.title] },
  onboarding_expired: { names: { en: 'amc_onboarding_expired_en', hi: 'amc_onboarding_expired_hi', te: 'amc_onboarding_expired_te' }, params: (n) => [n.link ?? ''] },
  // Experience v3 E10 — the provider-wizard stall nudge (opt-in gated; at most 2 per draft): [title "Your AMClub
  // profile is 2 steps from done", the deep link to the exact step]. en/hi/te.
  onboarding_stalled: { names: { en: 'amc_onboarding_stalled_en', hi: 'amc_onboarding_stalled_hi', te: 'amc_onboarding_stalled_te' }, params: (n) => [n.title, n.link ?? ''] },
  // Experience v3 E9b — licence renewal reminder (buyer; opt-in gated; dark behind obligations_enabled):
  // [title "Your FSSAI licence expires on 14 Nov", the category link]. en/hi/te.
  licence_renewal_due: { names: { en: 'amc_licence_renewal_due_en', hi: 'amc_licence_renewal_due_hi', te: 'amc_licence_renewal_due_te' }, params: (n) => [n.title, n.link ?? ''] },
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
  'start', 'yes', 'ok', 'hi', 'hello', 'namaste',
  'शुरू', 'हाँ', 'हां', 'नमस्ते',
  'ప్రారంభం', 'అవును', 'నమస్తే',
])
/**
 * S1.6 — the onboarding keyword. JOIN (and its Hindi/Telugu forms) moved here
 * from the opt-in set: with a WhatsApp grant it starts the provider interview;
 * without one the dispatcher treats it exactly as S0.5 did (opt-in), so the
 * flag-off behaviour of JOIN is unchanged.
 */
export const ONBOARDING_KEYWORDS: ReadonlySet<string> = new Set(['join', 'onboard', 'जुड़ें', 'చేరండి'])
export const WA_OPT_OUT_KEYWORDS: ReadonlySet<string> = new Set([
  'stop', 'unsubscribe', 'no', 'cancel',
  'बंद', 'रोकें', 'नहीं',
  'ఆపు', 'వద్దు',
])

export function classifyKeyword(text: string | null): 'opt_in' | 'opt_out' | 'onboard' | null {
  if (!text) return null
  const t = text.trim().toLowerCase().normalize('NFKC')
  if (WA_OPT_OUT_KEYWORDS.has(t)) return 'opt_out'
  if (ONBOARDING_KEYWORDS.has(t)) return 'onboard'
  if (WA_OPT_IN_KEYWORDS.has(t)) return 'opt_in'
  return null
}
