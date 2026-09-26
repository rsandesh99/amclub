/**
 * WhatsApp adapter contract (BUILD_PROMPTS S0.5, ADR-008 topology). One
 * interface, three drivers: `meta_cloud` (Graph API), `interakt` (BSP REST),
 * and `stub` (logs, never touches the network — so nothing bills without
 * credentials). The runtime hosts the webhook; the web notification dispatcher
 * calls sendTemplate. Transactional only (§5.5): no marketing path exists here.
 */

import type { MediaLimits } from './media'

export type WhatsAppDriverName = 'meta_cloud' | 'interakt' | 'stub'

// ADR-030: the locale list lives in shared (WA_LOCALES) so web, runtime and the templates agree; ta added (audit B2).
export type { WaLocale } from '@amclub/shared'
import type { WaLocale } from '@amclub/shared'

export interface SendResult {
  ok: boolean
  /** Vendor message id when accepted; null for stub/failed. */
  vendorMessageId: string | null
  /** 'sent' | 'stub' | 'error:<detail>' */
  detail: string
}

export type InboundKind = 'text' | 'audio' | 'image' | 'document' | 'button' | 'unknown'

export interface InboundMessage {
  /** Vendor message id — the idempotency key for wa_messages.vendor_message_id. */
  vendorMessageId: string
  /** Sender in E.164 digits WITHOUT '+', e.g. 919876543210 (as vendors send it). */
  fromE164: string
  kind: InboundKind
  /** Text body, caption, or the button reply title. */
  body: string | null
  /** Vendor media id (meta) or a direct URL (interakt) — resolved by downloadMedia. */
  mediaRef: string | null
  mime: string | null
  /** Button reply payload/id when kind === 'button'. */
  buttonPayload: string | null
  /** Vendor timestamp (ISO). */
  timestamp: string
  /** Raw vendor object, stored in wa_messages.payload for audit. */
  raw: unknown
}

export interface StatusUpdate {
  vendorMessageId: string
  status: 'sent' | 'delivered' | 'read' | 'failed'
  timestamp: string
  raw: unknown
}

export interface ParsedInbound {
  messages: InboundMessage[]
  statuses: StatusUpdate[]
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

export interface WhatsAppProvider {
  readonly name: WhatsAppDriverName
  /** Approved transactional template, per-locale name + ordered body params. */
  sendTemplate(to: string, templateName: string, locale: WaLocale, params: string[]): Promise<SendResult>
  /** Free text — only valid inside the 24h customer-care window. */
  sendText(to: string, text: string): Promise<SendResult>
  /**
   * S1.6 — interactive reply buttons inside the 24h window. Up to 3 render as
   * buttons; 4..10 render as a list (single pick). The tapped button comes back
   * as kind='button' with buttonPayload = id. `listLabel` is the list's open button.
   */
  sendButtons(to: string, text: string, buttons: WaButton[], listLabel?: string): Promise<SendResult>
  sendMedia(to: string, media: { url?: string; bytes?: Uint8Array; mime: string; caption?: string }): Promise<SendResult>
  /**
   * Audit M34: bounded — each fetch times out, the MIME must be on the allow-list
   * and the body is read with a byte cap (DEFAULT_MEDIA_LIMITS when omitted).
   * Refusals throw MediaRefusedError. Called by the wa.inbound job, never the webhook.
   */
  downloadMedia(mediaRef: string, limits?: MediaLimits): Promise<MediaDownload>
  /** Parse a raw webhook body into inbound messages + delivery statuses. */
  parseInbound(body: unknown): ParsedInbound
  /** Verify the webhook came from the vendor (HMAC / shared secret). */
  verifySignature(rawBody: string, headers: Record<string, string | undefined>): boolean
}

export interface WhatsAppConfig {
  driver: WhatsAppDriverName
  // meta_cloud
  phoneNumberId?: string | undefined
  accessToken?: string | undefined
  appSecret?: string | undefined
  verifyToken?: string | undefined
  graphVersion?: string | undefined
  // interakt
  interaktApiKey?: string | undefined
  interaktWebhookSecret?: string | undefined
}
