import type { ParsedInbound, SendResult, WhatsAppConfig, WhatsAppDriverName, WhatsAppProvider } from './types'
import { makeMetaCloudDriver } from './meta-cloud'
import { makeInteraktDriver } from './interakt'

export * from './types'
export * from './templates'
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
