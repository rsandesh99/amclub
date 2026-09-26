import type { ParsedInbound, SendResult, WhatsAppConfig, WhatsAppDriverName, WhatsAppProvider } from './types'
import { makeMetaCloudDriver } from './meta-cloud'
import { makeInteraktDriver } from './interakt'

export * from './types'
export * from './templates'
export * from './media'
export * from './send'
export * from './template-types'

/**
 * Audit M42 — the vendor id of the message a WhatsApp reply QUOTES (Meta:
 * `messages[].context.id`, stored in wa_messages.payload as the raw message).
 * The dispatcher maps it to the outbound row it quoted, whose payload carries
 * the proposal's run id, so a quoted "yes" binds to exactly that proposal.
 * Interakt carries no quote context here → null.
 */
export function quotedVendorMessageId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const ctx = (payload as { context?: { id?: unknown } }).context
  const id = ctx && typeof ctx === 'object' ? ctx.id : null
  return typeof id === 'string' && id.length > 0 && id.length <= 256 ? id : null
}

/** Audit M34 — the vendor media reference the webhook stored for the job to download (payload.amc_media_ref). */
export const PENDING_MEDIA_KEY = 'amc_media_ref'
export function pendingMediaRef(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const v = (payload as Record<string, unknown>)[PENDING_MEDIA_KEY]
  return typeof v === 'string' && v.length > 0 && v.length <= 2048 ? v : null
}
export { makeMetaCloudDriver, metaVerifyChallenge } from './meta-cloud'
export { makeInteraktDriver } from './interakt'

/**
 * Stub driver — logs and returns ok, NEVER touches the network, so nothing
 * bills before credentials exist. parseInbound accepts the Meta shape so the
 * webhook can be exercised end-to-end with recorded fixtures.
 */
export function makeStubDriver(log: (line: string) => void = (l) => console.warn(l)): WhatsAppProvider {
  const meta = makeMetaCloudDriver({ driver: 'meta_cloud' })
  const ok = (what: string): SendResult => {
    log(`[whatsapp STUB] would ${what}`)
    return { ok: true, vendorMessageId: null, detail: 'stub' }
  }
  return {
    name: 'stub',
    async sendTemplate(to, templateName, locale) { return ok(`send template ${templateName} (${locale}) → ${to.slice(0, 4)}…`) },
    async sendText(to) { return ok(`send text → ${to.slice(0, 4)}…`) },
    async sendButtons(to, _text, buttons) { return ok(`send ${buttons.length} button(s) [${buttons.map((b) => b.id).join(', ')}] → ${to.slice(0, 4)}…`) },
    async sendMedia(to) { return ok(`send media → ${to.slice(0, 4)}…`) },
    async downloadMedia() { return { bytes: new Uint8Array(), mime: 'application/octet-stream' } },
    parseInbound(body): ParsedInbound { return meta.parseInbound(body) },
    verifySignature() { return true },
  }
}

/** Env → config. The driver is `stub` unless WHATSAPP_DRIVER + its credentials are set. */
export function whatsappConfigFromEnv(env: Record<string, string | undefined> = process.env): WhatsAppConfig {
  const requested = (env['WHATSAPP_DRIVER'] ?? 'stub') as WhatsAppDriverName
  const cfg: WhatsAppConfig = {
    driver: 'stub',
    phoneNumberId: env['WHATSAPP_PHONE_NUMBER_ID'],
    accessToken: env['WHATSAPP_ACCESS_TOKEN'],
    appSecret: env['WHATSAPP_APP_SECRET'],
    verifyToken: env['WHATSAPP_VERIFY_TOKEN'],
    graphVersion: env['WHATSAPP_GRAPH_VERSION'],
    interaktApiKey: env['INTERAKT_API_KEY'],
    interaktWebhookSecret: env['INTERAKT_WEBHOOK_SECRET'],
  }
  if (requested === 'meta_cloud' && cfg.phoneNumberId && cfg.accessToken) cfg.driver = 'meta_cloud'
  if (requested === 'interakt' && cfg.interaktApiKey) cfg.driver = 'interakt'
  return cfg
}

export function createWhatsAppProvider(cfg: WhatsAppConfig = whatsappConfigFromEnv(), fetchImpl: typeof fetch = fetch): WhatsAppProvider {
  if (cfg.driver === 'meta_cloud') return makeMetaCloudDriver(cfg, fetchImpl)
  if (cfg.driver === 'interakt') return makeInteraktDriver(cfg, fetchImpl)
  return makeStubDriver()
}

/** True when a real (billing) driver is configured. */
export function whatsappIsLive(cfg: WhatsAppConfig = whatsappConfigFromEnv()): boolean {
  return cfg.driver !== 'stub'
}
