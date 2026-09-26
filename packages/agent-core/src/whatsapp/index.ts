import type { ParsedInbound, SendResult, WhatsAppConfig, WhatsAppDriverName, WhatsAppProvider } from './types'
import { DEFAULT_WA_GRAPH_VERSION, DEFAULT_WA_TIMEOUT_MS, WA_GRAPH_VERSION_RE, makeMetaCloudDriver, parseMetaWebhook } from './meta-cloud'

export * from './types'
export * from './templates'
export * from './media'
export * from './send'
export * from './template-types'
export * from './errors'
export * from './pricing'

/**
 * Audit M42 — the vendor id of the message a WhatsApp reply QUOTES (Meta:
 * `messages[].context.id`, stored in wa_messages.payload as the raw message).
 * The dispatcher maps it to the outbound row it quoted, whose payload carries
 * the proposal's run id, so a quoted "yes" binds to exactly that proposal.
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
export {
  DEFAULT_WA_GRAPH_VERSION,
  DEFAULT_WA_TIMEOUT_MS,
  WA_GRAPH_VERSION_RE,
  buildTemplateComponents,
  cleanTemplateParam,
  cleanUrlSuffix,
  makeMetaCloudDriver,
  metaVerifyChallenge,
  parseMetaWebhook,
} from './meta-cloud'

/**
 * Stub driver — logs and returns ok, NEVER touches the network, so nothing
 * bills before credentials exist. parseInbound accepts the Meta shape (no phone
 * number id check) so the webhook can be exercised end-to-end with recorded fixtures.
 */
export function makeStubDriver(log: (line: string) => void = (l) => console.warn(l)): WhatsAppProvider {
  const ok = (what: string): SendResult => {
    log(`[whatsapp STUB] would ${what}`)
    return { ok: true, vendorMessageId: null, detail: 'stub' }
  }
  return {
    name: 'stub',
    async sendTemplate(to: string, tpl: { name: string; language: string } | string, b?: unknown) {
      const name = typeof tpl === 'string' ? tpl : `${tpl.name} (${tpl.language})`
      return ok(`send template ${name}${typeof tpl === 'string' && typeof b === 'string' ? ` (${b})` : ''} → ${to.slice(0, 4)}…`)
    },
    async sendText(to) { return ok(`send text → ${to.slice(0, 4)}…`) },
    async sendButtons(to, _text, buttons) { return ok(`send ${buttons.length} button(s) [${buttons.map((b) => b.id).join(', ')}] → ${to.slice(0, 4)}…`) },
    async sendCtaUrl(to, _text, label) { return ok(`send cta_url "${label}" → ${to.slice(0, 4)}…`) },
    async sendMedia(to, media) { return ok(`send media ${media.mime} → ${to.slice(0, 4)}…`) },
    async markRead() { return { ok: true, vendorMessageId: null, detail: 'stub' } },
    async downloadMedia() { return { bytes: new Uint8Array(), mime: 'application/octet-stream' } },
    parseInbound(body): ParsedInbound { return parseMetaWebhook(body, { phoneNumberId: null, wabaId: null }) },
    verifySignature() { return true },
  }
}

function intEnv(v: string | undefined, d: number, lo: number, hi: number): number {
  const n = Number(v)
  return v !== undefined && v !== '' && Number.isInteger(n) && n >= lo && n <= hi ? n : d
}

/**
 * Env → config. The driver is `stub` unless WHATSAPP_DRIVER=meta_cloud AND its phone number id + token are set (a
 * named driver without credentials is reported by `whatsappDriverState`, never silently trusted). The Graph version
 * is pinned (default v24.0; an invalid WHATSAPP_GRAPH_VERSION is replaced by the default and reported).
 */
export function whatsappConfigFromEnv(env: Record<string, string | undefined> = process.env): WhatsAppConfig {
  const gv = env['WHATSAPP_GRAPH_VERSION']
  const cfg: WhatsAppConfig = {
    driver: 'stub',
    phoneNumberId: env['WHATSAPP_PHONE_NUMBER_ID'] || undefined,
    accessToken: env['WHATSAPP_ACCESS_TOKEN'] || undefined,
    appSecret: env['WHATSAPP_APP_SECRET'] || undefined,
    verifyToken: env['WHATSAPP_VERIFY_TOKEN'] || undefined,
    graphVersion: gv && WA_GRAPH_VERSION_RE.test(gv) ? gv : DEFAULT_WA_GRAPH_VERSION,
    wabaId: env['WHATSAPP_WABA_ID'] || undefined,
    timeoutMs: intEnv(env['WHATSAPP_TIMEOUT_MS'], DEFAULT_WA_TIMEOUT_MS, 1_000, 60_000),
  }
  if (env['WHATSAPP_DRIVER'] === 'meta_cloud' && cfg.phoneNumberId && cfg.accessToken) cfg.driver = 'meta_cloud'
  return cfg
}

export function createWhatsAppProvider(cfg: WhatsAppConfig = whatsappConfigFromEnv(), fetchImpl: typeof fetch = fetch): WhatsAppProvider {
  if (cfg.driver === 'meta_cloud') return makeMetaCloudDriver(cfg, fetchImpl)
  return makeStubDriver()
}

/** True when a real (billing) driver is configured. */
export function whatsappIsLive(cfg: WhatsAppConfig = whatsappConfigFromEnv()): boolean {
  return cfg.driver !== 'stub'
}

/** What the environment asked for and whether it is complete — names only, never a value (ADR-030 §1, fail loud). */
export interface WhatsAppDriverState {
  /** The driver actually used. */
  driver: WhatsAppDriverName
  /** The driver WHATSAPP_DRIVER asked for (anything but meta_cloud reads as stub). */
  requested: WhatsAppDriverName
  /** A real (billing) driver is in use. */
  live: boolean
  /** False when meta_cloud was asked for and a credential is missing (the runtime then refuses to ingest). */
  configured: boolean
  graphVersion: string
  phoneNumberIdSet: boolean
  tokenSet: boolean
  appSecretSet: boolean
  verifyTokenSet: boolean
  wabaIdSet: boolean
  /** Env names that meta_cloud needs and are unset. */
  missing: string[]
  /** Env names set to an invalid value (replaced by the default). */
  invalid: string[]
}

export function whatsappDriverState(env: Record<string, string | undefined> = process.env): WhatsAppDriverState {
  const cfg = whatsappConfigFromEnv(env)
  const requested: WhatsAppDriverName = env['WHATSAPP_DRIVER'] === 'meta_cloud' ? 'meta_cloud' : 'stub'
  const set = {
    phoneNumberIdSet: !!cfg.phoneNumberId,
    tokenSet: !!cfg.accessToken,
    appSecretSet: !!cfg.appSecret,
    verifyTokenSet: !!cfg.verifyToken,
    wabaIdSet: !!cfg.wabaId,
  }
  const missing: string[] = []
  if (requested === 'meta_cloud') {
    if (!set.phoneNumberIdSet) missing.push('WHATSAPP_PHONE_NUMBER_ID')
    if (!set.tokenSet) missing.push('WHATSAPP_ACCESS_TOKEN')
    if (!set.appSecretSet) missing.push('WHATSAPP_APP_SECRET')
    if (!set.verifyTokenSet) missing.push('WHATSAPP_VERIFY_TOKEN')
  }
  const invalid: string[] = []
  const gv = env['WHATSAPP_GRAPH_VERSION']
  if (gv && !WA_GRAPH_VERSION_RE.test(gv)) invalid.push('WHATSAPP_GRAPH_VERSION')
  const t = env['WHATSAPP_TIMEOUT_MS']
  if (t && intEnv(t, -1, 1_000, 60_000) === -1) invalid.push('WHATSAPP_TIMEOUT_MS')
  if (env['WHATSAPP_DRIVER'] && env['WHATSAPP_DRIVER'] !== 'meta_cloud' && env['WHATSAPP_DRIVER'] !== 'stub') invalid.push('WHATSAPP_DRIVER')
  return {
    driver: cfg.driver,
    requested,
    live: cfg.driver !== 'stub',
    configured: requested === 'stub' || missing.length === 0,
    graphVersion: cfg.graphVersion ?? DEFAULT_WA_GRAPH_VERSION,
    ...set,
    missing,
    invalid,
  }
}
