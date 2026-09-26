import 'server-only'
import { createWhatsAppProvider, sendWhatsApp, whatsappConfigFromEnv, type WaSendResult } from '@amclub/agent-core'
import { kindSpec, waLocaleFor, type ExternalChannel } from '@amclub/shared'
import { OUTBOUND_TIMEOUT_MS, fetchWithTimeout } from '@/lib/outbound'
import { notifyText } from '@/lib/i18n/notify'
import { sendSms, type DltTemplates } from './sms'
import type { Admin, TextLocale } from './store'

/**
 * The channel handlers (§5.9 `notification.dispatch`, ADR-030 §3–§4). The outbox processor (and, before 0087, the
 * direct fan-out) calls one per external channel; each returns what happened and never throws:
 *   email    — Resend, with an Idempotency-Key so a retried row is never delivered twice; a stub without the key.
 *   sms      — MSG91 Flow (DLT), lib/notifications/sms.ts.
 *   whatsapp — agent-core `sendWhatsApp`, the ONE send path: consent (a STOPped phone gets nothing), suppression,
 *              template by kind + locale, the wa_messages ledger row under `${notificationId}:whatsapp`. There is no
 *              kind that skips consent any more (WA_ALWAYS_ALLOWED_KINDS is gone, ADR-030 §2).
 *   push     — no subscription store in V1; never queued.
 * Transactional only: nothing here sends marketing.
 */

export interface ChannelMessage {
  notificationId: string | null
  userId: string
  kind: string
  email: string | null
  phone: string | null
  locale: TextLocale
  title: string
  body: string
  /** App-relative, e.g. /app/orders/<id>. */
  link: string | null
  absoluteLink: string | null
  /** The kind's typed values (ref, amount, deadline …), already in the recipient's locale. */
  values: Record<string, string>
  /** `${notificationId}:${channel}` — the vendor-side idempotency key where the vendor has one. */
  idempotencyKey: string
}

export type ChannelOutcome = 'sent' | 'stub' | 'skipped' | 'failed'

export interface ChannelResult {
  channel: ExternalChannel
  outcome: ChannelOutcome
  /** 'sent' | 'stub' | 'duplicate' | 'skipped:<reason>' | 'error:<status> <text>' */
  detail: string
  /** A failure worth another attempt (rate limit, 5xx, network). */
  retryable?: boolean
  /** WhatsApp: the message did not reach the user there, so the fallback channels may go. */
  fallback?: boolean
  /** The vendor's error code when there is one (Graph codes for WhatsApp). */
  errorCode?: string | null
}

export interface ChannelContext {
  admin: Admin
  dltTemplates: DltTemplates
}

export type ChannelHandler = (msg: ChannelMessage, ctx: ChannelContext) => Promise<ChannelResult>

export function appBaseUrl(): string {
  const configured = process.env['NEXT_PUBLIC_APP_URL']
  if (configured) return configured.replace(/\/+$/, '')
  const prod = process.env['VERCEL_PROJECT_PRODUCTION_URL']
  if (prod) return `https://${prod}`
  return 'https://amclub-web.vercel.app'
}

export function absoluteLink(link: string | null | undefined): string | null {
  if (!link) return null
  return /^https?:\/\//i.test(link) ? link : `${appBaseUrl()}${link.startsWith('/') ? '' : '/'}${link}`
}

/** A URL button's dynamic suffix: the app path without its leading slash (`app/orders/<id>`), our domain only. */
export function linkSuffix(link: string | null | undefined): string | null {
  if (!link) return null
  if (/^https?:\/\//i.test(link)) {
    const base = appBaseUrl()
    if (!link.startsWith(base)) return null
    link = link.slice(base.length)
  }
  return link.replace(/^\/+/, '') || null
}

const pick = (m: { en: string; hi: string; te?: string; ta?: string }, l: TextLocale) => m[l] ?? m.en

// ── email (Resend) ───────────────────────────────────────────────────────────

const emailHandler: ChannelHandler = async (msg) => {
  if (!msg.email) return { channel: 'email', outcome: 'skipped', detail: 'skipped:no-address' }
  const key = process.env['RESEND_API_KEY']
  if (!key) {
    console.warn(`[notify:email STUB] would send → user=${msg.userId} kind=${msg.kind} (no-key)`)
    return { channel: 'email', outcome: 'stub', detail: 'stub' }
  }
  const from = process.env['RESEND_FROM'] ?? 'AMClub <onboarding@resend.dev>'
  const href = msg.absoluteLink
  const open = pick(notifyText('email.open'), msg.locale)
  const footer = pick(notifyText('email.footer'), msg.locale)
  const html =
    `<div style="font-family:system-ui,sans-serif;max-width:480px">` +
    `<h2 style="color:#1B4D3E;margin:0 0 8px">${escapeHtml(msg.title)}</h2>` +
    `<p style="color:#1f2937;font-size:15px;line-height:1.5">${escapeHtml(msg.body)}</p>` +
    (href ? `<p><a href="${escapeHtml(href)}" style="display:inline-block;background:#1B4D3E;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">${escapeHtml(open)}</a></p>` : '') +
    `<p style="color:#9ca3af;font-size:12px;margin-top:24px">${escapeHtml(footer)}</p>` +
    `</div>`
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': msg.idempotencyKey.slice(0, 256) },
      body: JSON.stringify({ from, to: [msg.email], subject: msg.title, html }),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS.notify),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      return { channel: 'email', outcome: 'failed', detail: `error:${res.status} ${t.slice(0, 120)}`, retryable: res.status === 429 || res.status >= 500 }
    }
    return { channel: 'email', outcome: 'sent', detail: 'sent' }
  } catch (e) {
    return { channel: 'email', outcome: 'failed', detail: `error:${(e as Error).message.slice(0, 120)}`, retryable: true }
  }
}

// ── SMS (MSG91) ──────────────────────────────────────────────────────────────

const smsHandler: ChannelHandler = (msg, ctx) => sendSms(msg, ctx.dltTemplates)

// ── WhatsApp (agent-core sendWhatsApp) ───────────────────────────────────────

/** What the WhatsApp ledger said, as a channel result. Any skip (no consent, STOP, suppressed, not on WhatsApp, no
 *  template, not live …) and any final failure lets the fallback channels go. */
export function waResult(r: WaSendResult): ChannelResult {
  switch (r.outcome) {
    case 'sent':
      return { channel: 'whatsapp', outcome: 'sent', detail: 'sent' }
    case 'duplicate':
      return { channel: 'whatsapp', outcome: 'sent', detail: 'duplicate' }
    case 'stub':
      return { channel: 'whatsapp', outcome: 'stub', detail: 'stub' }
    case 'skipped':
      return { channel: 'whatsapp', outcome: 'skipped', detail: `skipped:${r.reason ?? 'unknown'}`, fallback: true }
    default:
      return {
        channel: 'whatsapp',
        outcome: 'failed',
        detail: `error:${r.error?.kind ?? 'unknown'} ${String(r.error?.title ?? '').slice(0, 100)}`.trim(),
        retryable: r.error?.retryable ?? true,
        fallback: true,
        errorCode: r.error?.code != null ? String(r.error.code) : null,
      }
  }
}

const whatsappHandler: ChannelHandler = async (msg, ctx) => {
  if (!msg.phone) return { channel: 'whatsapp', outcome: 'skipped', detail: 'skipped:no-phone', fallback: true }
  try {
    const provider = createWhatsAppProvider(whatsappConfigFromEnv(), fetchWithTimeout(OUTBOUND_TIMEOUT_MS.notify))
    const r = await sendWhatsApp(
      { db: ctx.admin, provider },
      {
        phoneE164: msg.phone,
        userId: msg.userId,
        purpose: kindSpec(msg.kind).waPurpose,
        initiation: 'business',
        kind: msg.kind,
        body: {
          type: 'template',
          kind: msg.kind,
          locale: waLocaleFor(msg.locale),
          values: { title: msg.title, body: msg.body, link: msg.absoluteLink, path: linkSuffix(msg.link), ...msg.values },
        },
        idempotencyKey: msg.idempotencyKey,
        notificationId: msg.notificationId,
      },
    )
    return waResult(r)
  } catch (e) {
    // sendWhatsApp classifies vendor errors itself; a throw here is ours (DB, config) — retry it.
    return { channel: 'whatsapp', outcome: 'failed', detail: `error:${(e as Error).message.slice(0, 120)}`, retryable: true, fallback: true }
  }
}

const pushHandler: ChannelHandler = async () => ({ channel: 'push', outcome: 'skipped', detail: 'skipped:not-implemented' })

export const CHANNEL_HANDLERS: Record<ExternalChannel, ChannelHandler> = {
  email: emailHandler,
  sms: smsHandler,
  whatsapp: whatsappHandler,
  push: pushHandler,
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}
