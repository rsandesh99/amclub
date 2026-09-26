import { createHmac, timingSafeEqual } from 'node:crypto'
import { waPhoneFromVendor } from '@amclub/shared'
import type {
  AccountChange,
  InboundKind,
  InboundMessage,
  MediaDownload,
  ParsedInbound,
  SendResult,
  StatusUpdate,
  WaGraphError,
  WaLocale,
  WaMediaInput,
  WaPricing,
  WaReferral,
  WaTemplateComponents,
  WaTemplateRef,
  WhatsAppConfig,
  WhatsAppProvider,
} from './types'
import { parseGraphError } from './errors'
import { DEFAULT_MEDIA_LIMITS, MediaRefusedError, baseMime, fetchWithTimeout, mimeAllowed, readCappedBody } from './media'

/**
 * Meta WhatsApp Cloud API driver (ADR-030 §1: direct, no BSP). Every Graph call carries a timeout
 * (WHATSAPP_TIMEOUT_MS, default 10 s) and a pinned API version (WHATSAPP_GRAPH_VERSION, default v24.0 — audit B5).
 * A failed call returns the PARSED Graph error (code, subcode, title), which the send path classifies (audit B6).
 * Webhook signature is X-Hub-Signature-256 = sha256=HMAC(app_secret, rawBody). Media arrives as an id; downloadMedia
 * resolves it to a URL then fetches the bytes with the token.
 */

export const DEFAULT_WA_GRAPH_VERSION = 'v24.0'
/** Graph versions are `vNN.0`; anything else is refused by env validation and replaced by the default. */
export const WA_GRAPH_VERSION_RE = /^v\d{2}\.0$/
export const DEFAULT_WA_TIMEOUT_MS = 10_000

const LANG: Record<WaLocale, string> = { en: 'en', hi: 'hi', te: 'te', ta: 'ta' }
const MAX_PARAM = 1024

function fail(detail: string, error?: WaGraphError): SendResult {
  return { ok: false, vendorMessageId: null, detail: `error:${detail}`, ...(error ? { error } : {}) }
}

/** Cut to at most `max` characters without splitting a surrogate pair (emoji). */
function cut(s: string, max: number): string {
  const chars = Array.from(s)
  return chars.length <= max ? s : chars.slice(0, max - 1).join('') + '…'
}

/**
 * Meta refuses template parameters with newlines, tabs or more than four consecutive spaces, and an empty parameter
 * (audit "smaller must-fix": support replies are multi-line). Newlines / tabs → a space, runs of 4+ spaces → one,
 * ≤ 1024 characters, never empty ('-').
 */
export function cleanTemplateParam(value: unknown): string {
  const s = String(value ?? '')
    .replace(/[\r\n\t\v\f]+/g, ' ')
    .replace(/ {4,}/g, ' ')
    .trim()
  return s ? cut(s, MAX_PARAM) : '-'
}

/** A URL-button suffix: the path after our fixed https://<domain>/ prefix (no leading slash, no whitespace). */
export function cleanUrlSuffix(value: unknown): string {
  const s = String(value ?? '').trim().replace(/^\/+/, '').replace(/\s+/g, '%20')
  return s.slice(0, 2000) || '-'
}

/** The template's language from a registry name `<stem>_<locale>` (the deprecated positional sendTemplate form). */
function languageOfName(name: string, locale: WaLocale): string {
  const m = /_(en|hi|te|ta)$/.exec(name)
  return m ? m[1]! : LANG[locale]
}

export function buildTemplateComponents(c: WaTemplateComponents | undefined): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const body = (c?.body ?? []).map(cleanTemplateParam)
  if (body.length) out.push({ type: 'body', parameters: body.map((text) => ({ type: 'text', text })) })
  if (c?.urlButton) {
    out.push({ type: 'button', sub_type: 'url', index: String(c.urlButton.index ?? 0), parameters: [{ type: 'text', text: cleanUrlSuffix(c.urlButton.suffix) }] })
  }
  const offset = c?.urlButton ? 1 : 0
  for (const [i, q] of (c?.quickReplies ?? []).entries()) {
    out.push({ type: 'button', sub_type: 'quick_reply', index: String(q.index ?? i + offset), parameters: [{ type: 'payload', payload: String(q.payload).slice(0, 256) }] })
  }
  return out
}

function mediaType(mime: string): 'image' | 'audio' | 'video' | 'document' {
  const m = baseMime(mime)
  return m.startsWith('image/') ? 'image' : m.startsWith('audio/') ? 'audio' : m.startsWith('video/') ? 'video' : 'document'
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const isoOf = (ts: unknown): string => new Date(Number(ts ?? 0) * 1000 || Date.now()).toISOString()

function referralOf(r: unknown): WaReferral | null {
  if (!r || typeof r !== 'object') return null
  const o = r as Record<string, unknown>
  return {
    sourceUrl: str(o['source_url']),
    sourceId: str(o['source_id']),
    sourceType: str(o['source_type']),
    headline: str(o['headline']),
    body: str(o['body']),
    mediaType: str(o['media_type']),
    ctwaClid: str(o['ctwa_clid']),
  }
}

function pricingOf(p: unknown): WaPricing | null {
  if (!p || typeof p !== 'object') return null
  const o = p as Record<string, unknown>
  return {
    billable: typeof o['billable'] === 'boolean' ? (o['billable'] as boolean) : null,
    category: str(o['category']),
    pricingModel: str(o['pricing_model']),
    type: str(o['type']),
  }
}

/** A business-scoped user id is an opaque string; keep it bounded and printable. */
function bsuidOf(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : ''
  return s && s.length <= 128 && /^[\x21-\x7e]+$/.test(s) ? s : null
}

export function makeMetaCloudDriver(cfg: WhatsAppConfig, fetchImpl: typeof fetch = fetch): WhatsAppProvider {
  const version = cfg.graphVersion && WA_GRAPH_VERSION_RE.test(cfg.graphVersion) ? cfg.graphVersion : DEFAULT_WA_GRAPH_VERSION
  const base = `https://graph.facebook.com/${version}`
  const token = cfg.accessToken ?? ''
  const phoneId = cfg.phoneNumberId ?? ''
  const timeoutMs = cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_WA_TIMEOUT_MS

  /** One Graph POST with a timeout; the error body is parsed, never flattened. */
  async function post(path: string, body: NonNullable<RequestInit['body']>, json: boolean): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: WaGraphError }> {
    try {
      const res = await fetchImpl(`${base}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) return { ok: false, error: parseGraphError(data, res.status) }
      return { ok: true, data }
    } catch (e) {
      const name = (e as { name?: string }).name
      const message = name === 'TimeoutError' || name === 'AbortError' ? `timeout ${timeoutMs}ms` : e instanceof Error ? e.message : 'network'
      return { ok: false, error: { code: null, subcode: null, title: message.slice(0, 200), message: message.slice(0, 500), httpStatus: null } }
    }
  }

  async function send(payload: Record<string, unknown>): Promise<SendResult> {
    if (!token || !phoneId) return fail('meta_cloud not configured')
    const r = await post(`${phoneId}/messages`, JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }), true)
    if (!r.ok) return fail(`${r.error.code ?? r.error.httpStatus ?? 'network'} ${r.error.title}`.trim(), r.error)
    const id = (r.data['messages'] as { id?: string }[] | undefined)?.[0]?.id ?? null
    return { ok: true, vendorMessageId: id, detail: 'sent' }
  }

  /** POST /{phone-number-id}/media (multipart) → the media id a message can reference. */
  async function upload(bytes: Uint8Array, mime: string, filename: string | undefined): Promise<{ id: string } | SendResult> {
    if (!token || !phoneId) return fail('meta_cloud not configured')
    const form = new FormData()
    form.append('messaging_product', 'whatsapp')
    form.append('type', baseMime(mime))
    form.append('file', new Blob([Uint8Array.from(bytes)], { type: baseMime(mime) }), filename ?? `file.${baseMime(mime).split('/')[1] ?? 'bin'}`)
    const r = await post(`${phoneId}/media`, form, false)
    if (!r.ok) return fail(`upload ${r.error.code ?? r.error.httpStatus ?? 'network'} ${r.error.title}`.trim(), r.error)
    const id = str(r.data['id'])
    return id ? { id } : fail('upload returned no id')
  }

  function templateSend(to: string, template: WaTemplateRef, components: WaTemplateComponents | undefined): Promise<SendResult> {
    const comps = buildTemplateComponents(components)
    return send({ to, type: 'template', template: { name: template.name, language: { code: template.language }, ...(comps.length ? { components: comps } : {}) } })
  }

  return {
    name: 'meta_cloud',
    sendTemplate(to: string, a: WaTemplateRef | string, b?: WaTemplateComponents | WaLocale, c?: string[]): Promise<SendResult> {
      if (typeof a === 'string') return templateSend(to, { name: a, language: languageOfName(a, (b as WaLocale) ?? 'en') }, { body: c ?? [] })
      return templateSend(to, a, b as WaTemplateComponents | undefined)
    },
    sendText(to, text) {
      return send({ to, type: 'text', text: { preview_url: false, body: cut(text, 4096) } })
    },
    sendButtons(to, text, buttons, listLabel) {
      if (buttons.length === 0) return send({ to, type: 'text', text: { preview_url: false, body: cut(text, 4096) } })
      const body = { text: cut(text, 1024) }
      if (buttons.length <= 3) {
        return send({
          to,
          type: 'interactive',
          interactive: { type: 'button', body, action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })) } },
        })
      }
      return send({
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body,
          action: {
            button: (listLabel ?? 'Choose').slice(0, 20),
            sections: [{ title: (listLabel ?? 'Choose').slice(0, 24), rows: buttons.slice(0, 10).map((b) => ({ id: b.id.slice(0, 200), title: b.title.slice(0, 24) })) }],
          },
        },
      })
    },
    sendCtaUrl(to, text, label, url) {
      if (!/^https:\/\//i.test(url)) return Promise.resolve(fail('cta_url needs an https url'))
      return send({ to, type: 'interactive', interactive: { type: 'cta_url', body: { text: cut(text, 1024) }, action: { name: 'cta_url', parameters: { display_text: label.slice(0, 20), url } } } })
    },
    async sendMedia(to, media: WaMediaInput) {
      const kind = mediaType(media.mime)
      let ref: Record<string, unknown>
      if (media.bytes && media.bytes.byteLength > 0) {
        const up = await upload(media.bytes, media.mime, media.filename)
        if (!('id' in up)) return up
        ref = { id: up.id }
      } else if (media.url && /^https:\/\//i.test(media.url)) {
        ref = { link: media.url }
      } else {
        return fail('sendMedia needs bytes or an https url')
      }
      const extra = {
        ...(media.caption && kind !== 'audio' ? { caption: cut(media.caption, 1024) } : {}),
        ...(media.filename && kind === 'document' ? { filename: media.filename.slice(0, 240) } : {}),
      }
      return send({ to, type: kind, [kind]: { ...ref, ...extra } })
    },
    async markRead(vendorMessageId, withTyping = false) {
      if (!token || !phoneId) return fail('meta_cloud not configured')
      const r = await post(`${phoneId}/messages`, JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: vendorMessageId, ...(withTyping ? { typing_indicator: { type: 'text' } } : {}) }), true)
      return r.ok ? { ok: true, vendorMessageId: null, detail: 'read' } : fail(`${r.error.code ?? r.error.httpStatus ?? 'network'} ${r.error.title}`.trim(), r.error)
    },
    async downloadMedia(mediaId, limits = DEFAULT_MEDIA_LIMITS): Promise<MediaDownload> {
      // A Graph media id is digits; anything else never reaches a URL.
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(mediaId)) throw new MediaRefusedError('bad_ref', 'media id')
      const meta = await fetchWithTimeout(fetchImpl, `${base}/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } }, limits.timeoutMs)
      const info = (await meta.json().catch(() => ({}))) as { url?: string; mime_type?: string; file_size?: number }
      if (!meta.ok || !info.url) throw new MediaRefusedError('http', `meta media lookup failed (${meta.status})`)
      // Refuse before a byte is downloaded: the declared type and size.
      if (!mimeAllowed(info.mime_type, limits)) throw new MediaRefusedError('mime_not_allowed', baseMime(info.mime_type) || 'unknown')
      if (typeof info.file_size === 'number' && info.file_size > limits.maxBytes) throw new MediaRefusedError('too_large', `declared ${info.file_size} > ${limits.maxBytes}`)
      if (!/^https:\/\//i.test(info.url)) throw new MediaRefusedError('bad_ref', 'media url scheme')
      const bin = await fetchWithTimeout(fetchImpl, info.url, { headers: { Authorization: `Bearer ${token}` } }, limits.timeoutMs)
      if (!bin.ok) {
        await bin.body?.cancel().catch(() => undefined)
        throw new MediaRefusedError('http', `meta media download failed (${bin.status})`)
      }
      const bytes = await readCappedBody(bin, limits.maxBytes)
      return { bytes, mime: baseMime(info.mime_type) }
    },
    parseInbound(body): ParsedInbound {
      return parseMetaWebhook(body, { phoneNumberId: phoneId || null, wabaId: cfg.wabaId || null })
    },
    verifySignature(rawBody, headers) {
      const secret = cfg.appSecret
      if (!secret) return false
      const header = headers['x-hub-signature-256'] ?? headers['X-Hub-Signature-256']
      if (!header || !header.startsWith('sha256=')) return false
      const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
      const given = header.slice('sha256='.length)
      if (given.length !== expected.length) return false
      try {
        return timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))
      } catch {
        return false
      }
    },
  }
}

const MEDIA_TYPES = new Set(['image', 'audio', 'document', 'video', 'sticker'])

/**
 * Parse a Meta webhook body. `messages` changes yield messages and statuses — but only for OUR phone number id when
 * one is configured (a second number on the same Meta app is never ingested as ours; the count is returned as
 * `dropped`). Every other field (template status / category / quality, phone quality, account updates / alerts) is an
 * account change, dropped when it names another WABA than the configured one.
 */
export function parseMetaWebhook(body: unknown, expect: { phoneNumberId: string | null; wabaId: string | null }): ParsedInbound {
  const messages: InboundMessage[] = []
  const statuses: StatusUpdate[] = []
  const account: AccountChange[] = []
  let dropped = 0
  const b = body as { entry?: { id?: unknown; changes?: { field?: string; value?: Record<string, unknown> }[] }[] } | null
  for (const entry of b?.entry ?? []) {
    const entryId = entry.id == null ? null : String(entry.id)
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {}
      const field = change.field ?? 'messages'
      if (field !== 'messages') {
        if (expect.wabaId && entryId && entryId !== expect.wabaId) {
          dropped++
          continue
        }
        account.push({ field, entryId, value: v })
        continue
      }
      const msgs = (v['messages'] as Record<string, unknown>[] | undefined) ?? []
      const sts = (v['statuses'] as Record<string, unknown>[] | undefined) ?? []
      const pnid = (v['metadata'] as { phone_number_id?: unknown } | undefined)?.phone_number_id
      if (expect.phoneNumberId && String(pnid ?? '') !== expect.phoneNumberId) {
        dropped += msgs.length + sts.length
        continue
      }
      const contacts = (v['contacts'] as Record<string, unknown>[] | undefined) ?? []
      for (const m of msgs) {
        const parsed = parseMessage(m, contacts)
        if (parsed) messages.push(parsed)
      }
      for (const s of sts) {
        const st = String(s['status'] ?? '')
        if (st !== 'sent' && st !== 'delivered' && st !== 'read' && st !== 'failed') continue
        const id = String(s['id'] ?? '')
        if (!id) continue
        const e0 = ((s['errors'] as Record<string, unknown>[] | undefined) ?? [])[0]
        const code = e0 ? Number(e0['code']) : NaN
        statuses.push({
          vendorMessageId: id,
          status: st,
          timestamp: isoOf(s['timestamp']),
          errorCode: Number.isFinite(code) ? code : null,
          errorTitle: e0 ? (str(e0['title']) ?? str(e0['message']))?.slice(0, 200) ?? null : null,
          pricing: pricingOf(s['pricing']),
          recipientId: str(s['recipient_id']),
          raw: s,
        })
      }
    }
  }
  return { messages, statuses, account, dropped }
}

function parseMessage(m: Record<string, unknown>, contacts: Record<string, unknown>[]): InboundMessage | null {
  const vendorMessageId = String(m['id'] ?? '')
  if (!vendorMessageId) return null
  const from = String(m['from'] ?? '').trim()
  const phone = waPhoneFromVendor(from)
  const contact = contacts.find((c) => c['wa_id'] === from) ?? (contacts.length === 1 ? contacts[0] : undefined)
  // audit 2.9: a non-numeric `from` is a business-scoped user id — kept as is, never reduced to digits
  const bsuid = bsuidOf(m['user_id']) ?? bsuidOf(m['from_user_id']) ?? bsuidOf(contact?.['user_id']) ?? (phone ? null : bsuidOf(from))
  if (!phone && !bsuid) return null
  const type = String(m['type'] ?? 'unknown')
  const ctx = m['context'] as { id?: unknown } | undefined
  const base: InboundMessage = {
    vendorMessageId,
    fromE164: phone,
    bsuid,
    kind: 'unknown',
    body: null,
    mediaRef: null,
    mime: null,
    buttonPayload: null,
    timestamp: isoOf(m['timestamp']),
    referral: referralOf(m['referral']),
    contextId: str(ctx?.id),
    newWaId: null,
    flowResponse: null,
    raw: m,
  }
  if (type === 'text') return { ...base, kind: 'text', body: String((m['text'] as { body?: string } | undefined)?.body ?? '') }
  if (MEDIA_TYPES.has(type)) {
    const media = (m[type] as { id?: string; mime_type?: string; caption?: string } | undefined) ?? {}
    return { ...base, kind: type as InboundKind, body: media.caption ?? null, mediaRef: media.id ?? null, mime: media.mime_type ?? null }
  }
  if (type === 'button') {
    const btn = (m['button'] as { text?: string; payload?: string } | undefined) ?? {}
    return { ...base, kind: 'button', body: btn.text ?? null, buttonPayload: btn.payload ?? null }
  }
  if (type === 'interactive') {
    const inter = (m['interactive'] as {
      type?: string
      button_reply?: { id?: string; title?: string }
      list_reply?: { id?: string; title?: string }
      nfm_reply?: { response_json?: string; body?: string; name?: string }
    } | undefined) ?? {}
    if (inter.type === 'nfm_reply' || inter.nfm_reply) {
      let flowResponse: Record<string, unknown> | null = null
      try {
        const parsed = JSON.parse(String(inter.nfm_reply?.response_json ?? 'null')) as unknown
        flowResponse = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
      } catch {
        flowResponse = null
      }
      return { ...base, kind: 'flow_reply', body: inter.nfm_reply?.body ?? null, flowResponse }
    }
    const reply = inter.button_reply ?? inter.list_reply
    return { ...base, kind: 'button', body: reply?.title ?? null, buttonPayload: reply?.id ?? null }
  }
  if (type === 'reaction') {
    const r = (m['reaction'] as { message_id?: string; emoji?: string } | undefined) ?? {}
    return { ...base, kind: 'reaction', body: r.emoji || null, contextId: r.message_id ?? base.contextId }
  }
  if (type === 'location') {
    const l = (m['location'] as { name?: string; address?: string } | undefined) ?? {}
    return { ...base, kind: 'location', body: [l.name, l.address].filter(Boolean).join(', ') || null }
  }
  if (type === 'contacts') return { ...base, kind: 'contacts' }
  if (type === 'order') return { ...base, kind: 'order', body: str((m['order'] as { text?: unknown } | undefined)?.text) }
  if (type === 'system') {
    const s = (m['system'] as { body?: string; new_wa_id?: string; wa_id?: string; type?: string } | undefined) ?? {}
    return { ...base, kind: 'system', body: s.body ?? null, newWaId: waPhoneFromVendor(s.new_wa_id ?? s.wa_id ?? null) }
  }
  return base
}

/** GET webhook verification handshake (hub.mode/hub.verify_token/hub.challenge). */
export function metaVerifyChallenge(query: Record<string, string | undefined>, verifyToken: string | undefined): string | null {
  if (!verifyToken) return null
  if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === verifyToken) return query['hub.challenge'] ?? ''
  return null
}
