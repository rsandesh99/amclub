import { timingSafeEqual } from 'node:crypto'
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
import { DEFAULT_MEDIA_LIMITS, MediaRefusedError, baseMime, fetchWithTimeout, mimeAllowed, readCappedBody } from './media'

/**
 * Interakt BSP driver. REST: POST https://api.interakt.ai/v1/public/message/
 * with Basic <api key>. Webhooks carry {type, data:{customer, message}};
 * Interakt has no HMAC by default, so we require a shared secret header
 * (x-interakt-secret = INTERAKT_WEBHOOK_SECRET) configured on their side.
 * Media arrives as a direct URL.
 */

const LANG: Record<WaLocale, string> = { en: 'en', hi: 'hi', te: 'te' }

function err(detail: string): SendResult {
  return { ok: false, vendorMessageId: null, detail: `error:${detail}` }
}

function splitE164(digits: string): { countryCode: string; phoneNumber: string } {
  const d = digits.replace(/\D/g, '')
  // India first (91 + 10 digits); otherwise a best-effort 2-digit split.
  if (d.length === 12 && d.startsWith('91')) return { countryCode: '+91', phoneNumber: d.slice(2) }
  return { countryCode: `+${d.slice(0, d.length - 10)}`, phoneNumber: d.slice(-10) }
}

export function makeInteraktDriver(cfg: WhatsAppConfig, fetchImpl: typeof fetch = fetch): WhatsAppProvider {
  const key = cfg.interaktApiKey ?? ''

  async function send(to: string, body: Record<string, unknown>): Promise<SendResult> {
    if (!key) return err('interakt not configured')
    const { countryCode, phoneNumber } = splitE164(to)
    try {
      const res = await fetchImpl('https://api.interakt.ai/v1/public/message/', {
        method: 'POST',
        headers: { Authorization: `Basic ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ countryCode, phoneNumber, callbackData: 'amclub', ...body }),
      })
      const json = (await res.json().catch(() => ({}))) as { result?: boolean; id?: string; message?: string }
      if (!res.ok || json.result === false) return err(`${res.status} ${json.message ?? ''}`.trim())
      return { ok: true, vendorMessageId: json.id ?? null, detail: 'sent' }
    } catch (e) {
      return err(e instanceof Error ? e.message : 'network')
    }
  }

  return {
    name: 'interakt',
    sendTemplate(to, templateName, locale, params) {
      return send(to, { type: 'Template', template: { name: templateName, languageCode: LANG[locale], bodyValues: params } })
    },
    sendText(to, text) {
      return send(to, { type: 'Text', data: { message: text } })
    },
    // Interakt's public message API has no interactive-button payload wired here (FOLLOWUPS S1.6):
    // the options go out as numbered lines and the onboarding machine accepts the number as the reply.
    sendButtons(to, text, buttons) {
      const lines = buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n')
      return send(to, { type: 'Text', data: { message: lines ? `${text}\n${lines}` : text } })
    },
    sendMedia(to, media) {
      if (!media.url) return Promise.resolve(err('interakt sendMedia needs a public url'))
      const type = media.mime.startsWith('image/') ? 'Image' : media.mime.startsWith('audio/') ? 'Audio' : 'Document'
      return send(to, { type, data: { message: media.caption ?? '', mediaUrl: media.url } })
    },
    async downloadMedia(url, limits = DEFAULT_MEDIA_LIMITS): Promise<MediaDownload> {
      // The URL comes from the (secret-authenticated) webhook body: https only, never an internal scheme or host.
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new MediaRefusedError('bad_ref', 'media url')
      }
      if (parsed.protocol !== 'https:' || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(parsed.hostname) || parsed.hostname.endsWith('.internal')) throw new MediaRefusedError('bad_ref', 'media url host')
      const res = await fetchWithTimeout(fetchImpl, parsed.toString(), { redirect: 'error' }, limits.timeoutMs)
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        throw new MediaRefusedError('http', `interakt media download failed (${res.status})`)
      }
      const mime = baseMime(res.headers.get('content-type'))
      if (!mimeAllowed(mime, limits)) {
        await res.body?.cancel().catch(() => undefined)
        throw new MediaRefusedError('mime_not_allowed', mime || 'unknown')
      }
      return { bytes: await readCappedBody(res, limits.maxBytes), mime }
    },
    parseInbound(body): ParsedInbound {
      const messages: InboundMessage[] = []
      const statuses: StatusUpdate[] = []
      const b = body as { type?: string; data?: Record<string, unknown> } | null
      if (!b || typeof b !== 'object') return { messages, statuses }
      const data = b.data ?? {}
      const customer = (data['customer'] as { phone_number?: string; country_code?: string }) ?? {}
      const msg = (data['message'] as Record<string, unknown>) ?? {}
      const from = `${String(customer.country_code ?? '').replace(/\D/g, '')}${String(customer.phone_number ?? '').replace(/\D/g, '')}`
      const id = String(msg['id'] ?? '')
      const ts = String(msg['received_at_utc'] ?? msg['created_at_utc'] ?? new Date().toISOString())
      if (b.type === 'message_received' && id) {
        const cmt = String(msg['chat_message_type'] ?? msg['message_content_type'] ?? 'Text').toLowerCase()
        const mediaUrl = (msg['media_url'] as string | undefined) ?? null
        const text = (msg['message'] as string | undefined) ?? null
        const kind = cmt.includes('image') ? 'image' : cmt.includes('audio') || cmt.includes('voice') ? 'audio' : cmt.includes('document') || cmt.includes('file') ? 'document' : cmt.includes('button') || cmt.includes('interactive') ? 'button' : 'text'
        messages.push({ vendorMessageId: id, fromE164: from, kind, body: text, mediaRef: mediaUrl, mime: null, buttonPayload: kind === 'button' ? text : null, timestamp: ts, raw: b })
      } else if (b.type === 'message_api_sent' || b.type === 'message_api_delivered' || b.type === 'message_api_read' || b.type === 'message_api_failed') {
        const st = b.type.replace('message_api_', '') as StatusUpdate['status']
        if (id) statuses.push({ vendorMessageId: id, status: st, timestamp: ts, raw: b })
      }
      return { messages, statuses }
    },
    verifySignature(_rawBody, headers) {
      const secret = cfg.interaktWebhookSecret
      if (!secret) return false
      const given = headers['x-interakt-secret'] ?? headers['X-Interakt-Secret'] ?? ''
      if (given.length !== secret.length) return false
      try {
        return timingSafeEqual(Buffer.from(given), Buffer.from(secret))
      } catch {
        return false
      }
    },
  }
}
