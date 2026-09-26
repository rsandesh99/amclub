/**
 * WhatsApp adapter contract (BUILD_PROMPTS S0.5, ADR-008 topology, ADR-030 §1). One interface, two drivers:
 * `meta_cloud` (Meta's Cloud API, direct — no BSP) and `stub` (logs, never touches the network, so nothing bills
 * without credentials). The runtime hosts the webhook. Nothing but `sendWhatsApp` (send.ts) calls the send methods:
 * consent, the 24-hour window, the outbound ledger and error handling all live there (ADR-030 §3).
 */

import type { MediaLimits } from './media'

/** ADR-030 §1: the Interakt driver is removed; Meta's Cloud API is the only live driver. */
export type WhatsAppDriverName = 'meta_cloud' | 'stub'

// ADR-030: the locale list lives in shared (WA_LOCALES) so web, runtime and the templates agree; ta added (audit B2).
export type { WaLocale } from '@amclub/shared'
import type { WaLocale } from '@amclub/shared'

/** A Graph API error, parsed (never flattened to text: the code decides retry / suppression / fallback). */
export interface WaGraphError {
  code: number | null
  subcode: number | null
  title: string
  message: string
  /** The HTTP status of the response; null for a network error / timeout. */
  httpStatus: number | null
}

export interface SendResult {
  ok: boolean
  /** Vendor message id when accepted; null for stub/failed. */
  vendorMessageId: string | null
  /** 'sent' | 'stub' | 'error:<detail>' */
  detail: string
  /** The parsed Graph error when the send failed (absent for the stub and for success). */
  error?: WaGraphError
}

/** Meta message types (0086 `wa_messages.kind`); `button` covers template quick replies and interactive replies. */
export type InboundKind =
  | 'text' | 'audio' | 'image' | 'document' | 'video' | 'sticker' | 'location' | 'contacts' | 'reaction' | 'order'
  | 'system' | 'button' | 'flow_reply' | 'unknown'

/** Click-to-WhatsApp ad referral (Meta `messages[].referral`), stored for attribution and the 72-hour entry window. */
export interface WaReferral {
  sourceUrl: string | null
  sourceId: string | null
  sourceType: string | null
  headline: string | null
  body: string | null
  mediaType: string | null
  ctwaClid: string | null
}

export interface InboundMessage {
  /** Vendor message id — the idempotency key for wa_messages.vendor_message_id. */
  vendorMessageId: string
  /**
   * Sender in E.164 digits WITHOUT '+', e.g. 919876543210 — only when Meta sent a phone. A business-scoped user id
   * (audit 2.9) is NEVER reduced to digits: it arrives in `bsuid` and this is null.
   */
  fromE164: string | null
  /** Meta's business-scoped user id (BSUID) when present (`user_id` / `from_user_id`, or a non-numeric `from`). */
  bsuid: string | null
  kind: InboundKind
  /** Text body, caption, the button reply title, a reaction emoji, a system message's text. */
  body: string | null
  /** Vendor media id — resolved by downloadMedia. */
  mediaRef: string | null
  mime: string | null
  /** Button reply payload/id when kind === 'button'. */
  buttonPayload: string | null
  /** Vendor timestamp (ISO). */
  timestamp: string
  /** The ad the user tapped (click-to-WhatsApp), if any. */
  referral: WaReferral | null
  /** The vendor id of the message this one quotes / reacts to (Meta `context.id`, `reaction.message_id`). */
  contextId: string | null
  /** kind 'system' / user_changed_number: the user's new WhatsApp id (their new number). */
  newWaId: string | null
  /** kind 'flow_reply': the parsed Flow response (interactive nfm_reply response_json). */
  flowResponse: Record<string, unknown> | null
  /** Raw vendor object, stored in wa_messages.payload for audit. */
  raw: unknown
}

/** Meta's pricing object on a status callback (per-message pricing). */
export interface WaPricing {
  billable: boolean | null
  /** utility | marketing | authentication | authentication_international | service | referral_conversion … */
  category: string | null
  /** CBP / PMP */
  pricingModel: string | null
  /** regular | free_customer_service | free_entry_point … */
  type: string | null
}

export interface StatusUpdate {
  vendorMessageId: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  timestamp: string
  /** errors[0].code / title on a failed status. */
  errorCode: number | null
  errorTitle: string | null
  pricing: WaPricing | null
  recipientId: string | null
  raw: unknown
}

/** A WhatsApp Business Account change that is not a message (template status / category / quality, phone quality, account). */
export interface AccountChange {
  field: string
  /** The WABA id of the entry. */
  entryId: string | null
  value: Record<string, unknown>
}

export interface ParsedInbound {
  messages: InboundMessage[]
  statuses: StatusUpdate[]
  /** Account-level changes (every field other than `messages`). */
  account: AccountChange[]
  /** Message / status entries dropped because they were addressed to another phone number id (or another WABA). */
  dropped: number
}

export interface MediaDownload {
  bytes: Uint8Array
  mime: string
}

/** S1.6 — a reply button (Meta interactive `button` ≤ 3, or a list row when more). */
export interface WaButton {
  /** The payload echoed back as InboundMessage.buttonPayload (≤ 256 chars). */
  id: string
  /** Visible label (Meta: ≤ 20 chars for buttons, ≤ 24 for list rows; drivers truncate). */
  title: string
}

/** A template that exists at Meta: the approved name AND its language code (audit B2: never one without the other). */
export interface WaTemplateRef {
  name: string
  language: string
}

/** The variable parts of a template send. The driver cleans every parameter (newlines, tabs, length, never empty). */
export interface WaTemplateComponents {
  /** Ordered body parameters ({{1}}, {{2}} …). */
  body?: string[]
  /** The dynamic suffix of the template's URL button (the fixed https://<our domain>/ prefix is approved with it). */
  urlButton?: { index?: number; suffix: string } | null
  /** Quick-reply buttons: the payload each returns (index = the button's position in the template). */
  quickReplies?: ReadonlyArray<{ index?: number; payload: string }>
}

export interface WaMediaInput {
  /** A public https URL (Meta fetches it) … */
  url?: string
  /** … or the bytes, uploaded first through POST /{phone-number-id}/media. */
  bytes?: Uint8Array
  mime: string
  caption?: string
  /** Shown for a document (e.g. `AMC-1234-invoice.pdf`). */
  filename?: string
}

export interface WhatsAppProvider {
  readonly name: WhatsAppDriverName
  /** An approved template: the resolved (name, language) pair plus its parameters and buttons. */
  sendTemplate(to: string, template: WaTemplateRef, components?: WaTemplateComponents): Promise<SendResult>
  /**
   * @deprecated The pre-ADR-030 form (name + locale + body params). The language is taken from the name's `_xx`
   * suffix, so an en fallback name is never sent under another language code (audit B2). Remove once
   * apps/web/lib/notifications/channels.ts sends through `sendWhatsApp`.
   */
  sendTemplate(to: string, templateName: string, locale: WaLocale, params: string[]): Promise<SendResult>
  /** Free text — only valid inside the 24h customer-care window. */
  sendText(to: string, text: string): Promise<SendResult>
  /**
   * S1.6 — interactive reply buttons inside the 24h window. Up to 3 render as
   * buttons; 4..10 render as a list (single pick). The tapped button comes back
   * as kind='button' with buttonPayload = id. `listLabel` is the list's open button.
   */
  sendButtons(to: string, text: string, buttons: WaButton[], listLabel?: string): Promise<SendResult>
  /** An interactive call-to-action URL button (inside the window): body text + one button that opens `url`. */
  sendCtaUrl(to: string, text: string, label: string, url: string): Promise<SendResult>
  /** Image / audio / video / document by public link or by upload (bytes). */
  sendMedia(to: string, media: WaMediaInput): Promise<SendResult>
  /** Mark an inbound message read (blue ticks), optionally showing the typing indicator while a reply is prepared. */
  markRead(vendorMessageId: string, withTyping?: boolean): Promise<SendResult>
  /**
   * Audit M34: bounded — each fetch times out, the MIME must be on the allow-list
   * and the body is read with a byte cap (DEFAULT_MEDIA_LIMITS when omitted).
   * Refusals throw MediaRefusedError. Called by the wa.inbound job, never the webhook.
   */
  downloadMedia(mediaRef: string, limits?: MediaLimits): Promise<MediaDownload>
  /** Parse a raw webhook body into inbound messages, delivery statuses and account changes. */
  parseInbound(body: unknown): ParsedInbound
  /** Verify the webhook came from the vendor (HMAC). */
  verifySignature(rawBody: string, headers: Record<string, string | undefined>): boolean
}

export interface WhatsAppConfig {
  driver: WhatsAppDriverName
  phoneNumberId?: string | undefined
  accessToken?: string | undefined
  appSecret?: string | undefined
  verifyToken?: string | undefined
  /** Pinned Graph API version, e.g. 'v24.0' (ADR-030 §1; validated `^v\d{2}\.0$`). */
  graphVersion?: string | undefined
  /** The WhatsApp Business Account id (account webhooks for another WABA are dropped). */
  wabaId?: string | undefined
  /** Timeout for every Graph call, ms (WHATSAPP_TIMEOUT_MS, default 10 000). */
  timeoutMs?: number | undefined
}
