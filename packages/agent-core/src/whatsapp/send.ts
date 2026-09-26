import type { SupabaseClient } from '@supabase/supabase-js'
import type { WaConsentPurpose } from '@amclub/shared'
import type { WaButton, WaLocale, WhatsAppProvider } from './types'

/**
 * ADR-030 §3 — the ONE WhatsApp send path. The web notification dispatcher and every runtime agent send through
 * `sendWhatsApp`; nothing else calls a driver's send methods. In order, it:
 *   1. refuses a bad phone (a business-scoped id is never reduced to digits);
 *   2. checks consent and suppression (`mayMessage`): a STOPped phone gets nothing but the opt-out confirmation;
 *      business-initiated sends need the purpose's opt-in; a direct reply inside the 24-h window needs only "not STOPped";
 *   3. picks free-form vs template from the conversation's window (with a safety margin), falling back to
 *      `fallbackTemplate` outside it, and resolves the template's name AND language together (audit B2);
 *   4. writes the outbound wa_messages row (status queued) under the unique idempotency key BEFORE the vendor call, so a
 *      retried job returns `duplicate` instead of sending twice;
 *   5. calls the driver with a timeout, classifies a Graph error (131047 outside window → retry as template once;
 *      131026 not on WhatsApp / 131050 stopped marketing → suppression; 130429 / 131056 rate limit → retryable;
 *      368 / 131031 account restricted → not retryable), and records the outcome, error code and category on the row.
 * Statuses and pricing arrive later through the webhook, which updates the same row (monotonic, 0086 trigger).
 */

/** What to send. `template` names a registry kind (templates.ts), never a raw Meta template name. */
export type WaSendBody =
  | { type: 'template'; kind: string; locale: WaLocale; values: Record<string, string | null | undefined> }
  | { type: 'text'; text: string }
  | { type: 'buttons'; text: string; buttons: WaButton[]; listLabel?: string }
  | { type: 'cta_url'; text: string; label: string; url: string }
  | { type: 'media'; mime: string; caption?: string; filename?: string; url?: string; storagePath?: string }

export interface WaSendRequest {
  /** E.164 digits, with or without '+'. */
  phoneE164: string
  userId?: string | null
  conversationId?: string | null
  purpose: WaConsentPurpose
  /** 'reply' = answering the user's own message inside the 24-h window (service); 'business' = we write first. */
  initiation: 'business' | 'reply'
  /** Notification kind or runtime message kind, recorded on the row. */
  kind: string
  body: WaSendBody
  /** Sent instead when free-form is not allowed (outside the window). None → skipped: outside_window. */
  fallbackTemplate?: Extract<WaSendBody, { type: 'template' }>
  /** Unique per logical message: `${notificationId}:whatsapp`, `${runId}:${step}`, `${inboundMessageId}:reply:${n}`. */
  idempotencyKey: string
  runId?: string | null
  notificationId?: string | null
  /** Payload merged into the row (e.g. a card's run id for the M42 binding). Never secrets. */
  meta?: Record<string, unknown>
}

export type WaSendOutcome = 'sent' | 'stub' | 'duplicate' | 'skipped' | 'failed'
export type WaSkipReason =
  | 'bad_phone' | 'opted_out' | 'no_consent' | 'suppressed' | 'no_template' | 'template_not_approved'
  | 'outside_window' | 'not_live' | 'marketing_cap' | 'budget'
export type WaErrorKind =
  | 'outside_window' | 'marketing_limit' | 'not_on_whatsapp' | 'user_stopped_marketing' | 'rate_limited' | 'template'
  | 'account_restricted' | 'auth' | 'invalid' | 'server' | 'network' | 'unknown'

export interface WaSendError {
  code: number | null
  kind: WaErrorKind
  title: string
  retryable: boolean
}

export interface WaSendResult {
  outcome: WaSendOutcome
  reason?: WaSkipReason
  error?: WaSendError
  vendorMessageId?: string | null
  /** wa_messages.id of the outbound row (absent when skipped before a row was written). */
  messageId?: string | null
  /** True when a template was sent (the window was closed or the body was a template). */
  usedTemplate?: boolean
}

export interface WaSendDeps {
  db: SupabaseClient
  provider: WhatsAppProvider
  now?: () => Date
}

export type MayMessage = { ok: true } | { ok: false; reason: Extract<WaSkipReason, 'bad_phone' | 'opted_out' | 'no_consent' | 'suppressed'> }

/** Consent + suppression for one phone and purpose. See ADR-030 §2. */
export async function mayMessage(
  _db: SupabaseClient,
  _phoneE164: string,
  _purpose: WaConsentPurpose,
  _initiation: 'business' | 'reply',
): Promise<MayMessage> {
  // Implemented in wave 1 (transport). Until then nothing may send.
  return { ok: false, reason: 'no_consent' }
}

export async function sendWhatsApp(_deps: WaSendDeps, _req: WaSendRequest): Promise<WaSendResult> {
  // Implemented in wave 1 (transport).
  return { outcome: 'skipped', reason: 'not_live' }
}
