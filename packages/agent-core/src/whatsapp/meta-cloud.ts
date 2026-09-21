import { createHmac, timingSafeEqual } from 'node:crypto'
import type {
  InboundMessage,
  MediaDownload,
  ParsedInbound,
  SendResult,
  StatusUpdate,
  WaLocale,
  WhatsAppConfig,
  WhatsAppProvider,
} from './types'

/**
 * Meta WhatsApp Cloud API driver (Graph v20+). Webhook signature is
 * X-Hub-Signature-256 = sha256=HMAC(app_secret, rawBody). Media arrives as an
 * id; downloadMedia resolves it to a URL then fetches the bytes with the token.
 */

const LANG: Record<WaLocale, string> = { en: 'en', hi: 'hi', te: 'te' }

function err(detail: string): SendResult {
  return { ok: false, vendorMessageId: null, detail: `error:${detail}` }
}

export function makeMetaCloudDriver(cfg: WhatsAppConfig, fetchImpl: typeof fetch = fetch): WhatsAppProvider {
  const version = cfg.graphVersion ?? 'v20.0'
  const base = `https://graph.facebook.com/${version}`
  const token = cfg.accessToken ?? ''
  const phoneId = cfg.phoneNumberId ?? ''

  async function send(payload: Record<string, unknown>): Promise<SendResult> {
    if (!token || !phoneId) return err('meta_cloud not configured')
    try {
      const res = await fetchImpl(`${base}/${phoneId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
      })
      const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string } }
      if (!res.ok) return err(`${res.status} ${json.error?.message ?? ''}`.trim())
      return { ok: true, vendorMessageId: json.messages?.[0]?.id ?? null, detail: 'sent' }
    } catch (e) {
      return err(e instanceof Error ? e.message : 'network')
    }
  }

  return {
    name: 'meta_cloud',
    sendTemplate(to, templateName, locale, params) {
      const components = params.length > 0 ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : []
      return send({ to, type: 'template', template: { name: templateName, language: { code: LANG[locale] }, components } })
    },
    sendText(to, text) {
      return send({ to, type: 'text', text: { preview_url: false, body: text } })
    },
    sendButtons(to, text, buttons, listLabel) {
      if (buttons.length === 0) return send({ to, type: 'text', text: { preview_url: false, body: text } })
      if (buttons.length <= 3) {
        return send({
          to,
          type: 'interactive',
          interactive: {
            type: 'button',
            body: { text },
            action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })) },
          },
        })
      }
      return send({
        to,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text },
          action: {
            button: (listLabel ?? 'Choose').slice(0, 20),
            sections: [{ title: (listLabel ?? 'Choose').slice(0, 24), rows: buttons.slice(0, 10).map((b) => ({ id: b.id.slice(0, 200), title: b.title.slice(0, 24) })) }],
          },
        },
      })
    },
    sendMedia(to, media) {
      const kind = media.mime.startsWith('image/') ? 'image' : media.mime.startsWith('audio/') ? 'audio' : 'document'
      if (!media.url) return Promise.resolve(err('meta_cloud sendMedia needs a public url (upload flow not wired)'))
      return send({ to, type: kind, [kind]: { link: media.url, ...(media.caption && kind !== 'audio' ? { caption: media.caption } : {}) } })
    },
    async downloadMedia(mediaId): Promise<MediaDownload> {
      const meta = await fetchImpl(`${base}/${mediaId}`, { headers: { Authorization: `Bearer ${token}` } })
      const info = (await meta.json()) as { url?: string; mime_type?: string }
      if (!meta.ok || !info.url) throw new Error(`meta media lookup failed (${meta.status})`)
      const bin = await fetchImpl(info.url, { headers: { Authorization: `Bearer ${token}` } })
      if (!bin.ok) throw new Error(`meta media download failed (${bin.status})`)
      return { bytes: new Uint8Array(await bin.arrayBuffer()), mime: info.mime_type ?? bin.headers.get('content-type') ?? 'application/octet-stream' }
    },
    parseInbound(body): ParsedInbound {
      const messages: InboundMessage[] = []
      const statuses: StatusUpdate[] = []
      const b = body as { entry?: { changes?: { value?: Record<string, unknown> }[] }[] } | null
      for (const entry of b?.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const v = change.value ?? {}
          for (const m of (v['messages'] as Record<string, unknown>[] | undefined) ?? []) {
            const type = String(m['type'] ?? 'unknown')
            const ts = new Date(Number(m['timestamp'] ?? 0) * 1000 || Date.now()).toISOString()
            const base: Omit<InboundMessage, 'kind' | 'body' | 'mediaRef' | 'mime' | 'buttonPayload'> = {
              vendorMessageId: String(m['id'] ?? ''),
              fromE164: String(m['from'] ?? '').replace(/\D/g, ''),
              timestamp: ts,
              raw: m,
            }
            if (type === 'text') {
              messages.push({ ...base, kind: 'text', body: String((m['text'] as { body?: string })?.body ?? ''), mediaRef: null, mime: null, buttonPayload: null })
            } else if (type === 'image' || type === 'audio' || type === 'document') {
              const media = (m[type] as { id?: string; mime_type?: string; caption?: string }) ?? {}
              messages.push({ ...base, kind: type, body: media.caption ?? null, mediaRef: media.id ?? null, mime: media.mime_type ?? null, buttonPayload: null })
            } else if (type === 'button' || type === 'interactive') {
              const btn = (m['button'] as { text?: string; payload?: string }) ?? {}
              const inter = (m['interactive'] as { button_reply?: { id?: string; title?: string }; list_reply?: { id?: string; title?: string } }) ?? {}
              const reply = inter.button_reply ?? inter.list_reply
              messages.push({ ...base, kind: 'button', body: btn.text ?? reply?.title ?? null, mediaRef: null, mime: null, buttonPayload: btn.payload ?? reply?.id ?? null })
            } else {
              messages.push({ ...base, kind: 'unknown', body: null, mediaRef: null, mime: null, buttonPayload: null })
            }
          }
          for (const s of (v['statuses'] as Record<string, unknown>[] | undefined) ?? []) {
            const st = String(s['status'] ?? '')
            if (st === 'sent' || st === 'delivered' || st === 'read' || st === 'failed') {
              statuses.push({ vendorMessageId: String(s['id'] ?? ''), status: st, timestamp: new Date(Number(s['timestamp'] ?? 0) * 1000 || Date.now()).toISOString(), raw: s })
            }
          }
        }
      }
      return { messages: messages.filter((m) => m.vendorMessageId), statuses: statuses.filter((s) => s.vendorMessageId) }
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

/** GET webhook verification handshake (hub.mode/hub.verify_token/hub.challenge). */
export function metaVerifyChallenge(query: Record<string, string | undefined>, verifyToken: string | undefined): string | null {
  if (!verifyToken) return null
  if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === verifyToken) return query['hub.challenge'] ?? ''
  return null
}
