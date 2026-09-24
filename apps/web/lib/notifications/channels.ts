import 'server-only'
import { createWhatsAppProvider, templateFor, WA_ALWAYS_ALLOWED_KINDS, whatsappConfigFromEnv, whatsappIsLive } from '@amclub/agent-core'
import { OUTBOUND_TIMEOUT_MS, fetchWithTimeout } from '@/lib/outbound'

/**
 * Notification CHANNELS registry (§5.5 / §5.9 `notification.dispatch`).
 *
 * One place to flip a channel from STUB to LIVE: replace the channel's handler
 * body below. In-app + email (Resend) are live; SMS (MSG91) and WhatsApp
 * (Gupshup/Interakt) are stubs that LOG "would send" and make NO paid API call
 * until credentials are wired — swap the `return stub(...)` for the real call.
 *
 * Transactional only — there is no marketing path here (§5.5).
 */

export interface ChannelMessage {
  toUserId: string
  /** S0.5 — an active agent_grants row with channel=whatsapp (resolved by the dispatcher). */
  whatsappOptIn?: boolean
  email: string | null
  phone: string | null
  locale: 'en' | 'hi' | 'te'
  title: string
  body: string
  /** App-relative link, e.g. /app/orders/123. */
  link: string | null
  kind: string
}

export interface ChannelResult {
  channel: string
  ok: boolean
  /** 'sent' | 'stub' | 'skipped:<reason>' | 'error:<msg>' */
  detail: string
}

export type ChannelHandler = (msg: ChannelMessage) => Promise<ChannelResult>

function absoluteLink(link: string | null): string | null {
  if (!link) return null
  const base = process.env['NEXT_PUBLIC_APP_URL'] ?? 'https://amclub-web.vercel.app'
  return link.startsWith('http') ? link : `${base}${link}`
}

function stub(channel: string, msg: ChannelMessage, reason = 'no-credentials'): ChannelResult {
  // Visible, greppable, and free — never a paid call until flipped to live.
  console.warn(`[notify:${channel} STUB] would send → user=${msg.toUserId} kind=${msg.kind} title="${msg.title}" (${reason})`)
  return { channel, ok: true, detail: 'stub' }
}

/** LIVE — Resend transactional email. No-ops to a stub when RESEND_API_KEY unset. */
const emailHandler: ChannelHandler = async (msg) => {
  if (!msg.email) return { channel: 'email', ok: true, detail: 'skipped:no-address' }
  const key = process.env['RESEND_API_KEY']
  if (!key) return stub('email', msg, 'no-key')

  const from = process.env['RESEND_FROM'] ?? 'AMClub <onboarding@resend.dev>'
  const href = absoluteLink(msg.link)
  const html =
    `<div style="font-family:system-ui,sans-serif;max-width:480px">` +
    `<h2 style="color:#1B4D3E;margin:0 0 8px">${escapeHtml(msg.title)}</h2>` +
    `<p style="color:#1f2937;font-size:15px;line-height:1.5">${escapeHtml(msg.body)}</p>` +
    (href ? `<p><a href="${href}" style="display:inline-block;background:#1B4D3E;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open AMClub</a></p>` : '') +
    `<p style="color:#9ca3af;font-size:12px;margin-top:24px">You receive this because it concerns your AMClub order or request. Transactional message — not marketing.</p>` +
    `</div>`

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [msg.email], subject: msg.title, html }),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS.notify),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return { channel: 'email', ok: false, detail: `error:${res.status} ${t.slice(0, 120)}` }
    }
    return { channel: 'email', ok: true, detail: 'sent' }
  } catch (e) {
    return { channel: 'email', ok: false, detail: `error:${(e as Error).message}` }
  }
}

/** STUB — MSG91 SMS. Flip to live: build the MSG91 request here using msg.phone. */
const smsHandler: ChannelHandler = async (msg) => {
  if (!msg.phone) return { channel: 'sms', ok: true, detail: 'skipped:no-phone' }
  if (!process.env['MSG91_AUTH_KEY']) return stub('sms', msg)
  // TODO(go-live): MSG91 transactional flow call. Until then, never bill:
  return stub('sms', msg, 'live-not-enabled')
}

/**
 * WhatsApp (S0.5) — approved transactional templates via the agent-core adapter.
 * Sends ONLY when (a) a real driver + credentials are configured, (b) the kind
 * has a registered template, and (c) the recipient has an active whatsapp grant
 * OR the kind is in the always-allowed transactional set (order/payment events
 * to a party of the order). Otherwise 'stub' / 'skipped:no-opt-in' — never a bill.
 */
const whatsappHandler: ChannelHandler = async (msg) => {
  if (!msg.phone) return { channel: 'whatsapp', ok: true, detail: 'skipped:no-phone' }
  const tpl = templateFor(msg.kind, msg.locale)
  if (!tpl) return { channel: 'whatsapp', ok: true, detail: 'skipped:no-template' }
  if (!WA_ALWAYS_ALLOWED_KINDS.has(msg.kind) && !msg.whatsappOptIn) return { channel: 'whatsapp', ok: true, detail: 'skipped:no-opt-in' }
  const cfg = whatsappConfigFromEnv()
  if (!whatsappIsLive(cfg)) return stub('whatsapp', msg)
  // The drivers catch their own fetch errors, so a timed-out send comes back as { ok: false }.
  const provider = createWhatsAppProvider(cfg, fetchWithTimeout(OUTBOUND_TIMEOUT_MS.notify))
  const to = msg.phone.replace(/\D/g, '')
  const r = await provider.sendTemplate(to, tpl.name, msg.locale, tpl.spec.params({ title: msg.title, body: msg.body, link: absoluteLink(msg.link) }))
  return { channel: 'whatsapp', ok: r.ok, detail: r.detail }
}

/** STUB — Web Push. Optional; needs a subscription store (not in V1 scope). */
const webPushHandler: ChannelHandler = async (msg) => stub('web_push', msg, 'not-implemented')

export const CHANNELS: Record<string, ChannelHandler> = {
  email: emailHandler,
  sms: smsHandler,
  whatsapp: whatsappHandler,
  web_push: webPushHandler,
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
