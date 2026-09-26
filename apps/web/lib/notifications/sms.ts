import 'server-only'
import type { NotificationKind } from '@amclub/shared'
import { OUTBOUND_TIMEOUT_MS } from '@/lib/outbound'
import type { ChannelMessage, ChannelResult } from './channels'

/**
 * ADR-030 §4 — SMS through MSG91's Flow API (DLT). A kind sends SMS only when agent_settings.sms_dlt_templates holds
 * its DLT flow (template id + the value keys it takes); otherwise `skipped:no-dlt-template`, so nothing bills by
 * default. +91 mobiles only (international numbers are NOT-NOW). Without MSG91_AUTH_KEY the channel is a stub that
 * logs "would send" and makes no call. Every call carries the notify timeout.
 */

export type DltTemplate = { templateId: string; vars: string[] }
export type DltTemplates = Partial<Record<NotificationKind | string, DltTemplate>>

const MSG91_FLOW_URL = 'https://api.msg91.com/api/v5/flow/'
/** DLT caps each variable at 30 characters; a link is left whole for MSG91's shortener. */
const DLT_VAR_MAX = 30
const isUrl = (s: string) => /^https?:\/\//i.test(s)

/** 10-digit Indian mobile → 91XXXXXXXXXX; anything else (a landline, a foreign number) → null. */
export function indianMobile(phone: string | null | undefined): string | null {
  const d = String(phone ?? '').replace(/\D/g, '')
  const local = d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 11 && d.startsWith('0') ? d.slice(1) : d.length === 10 ? d : null
  return local && /^[6-9]\d{9}$/.test(local) ? `91${local}` : null
}

function authKey(): string | null {
  const k = process.env['MSG91_AUTH_KEY']
  return k && !['<msg91-auth-key>', 'placeholder'].includes(k) ? k : null
}

export function smsConfigured(): boolean {
  return authKey() !== null
}

/** The recipient object MSG91 expects: `mobiles` plus each template variable under its own name. */
export function dltRecipient(mobile: string, tpl: DltTemplate, values: Record<string, string>): { recipient: Record<string, string>; shortUrl: boolean } {
  const recipient: Record<string, string> = { mobiles: mobile }
  let shortUrl = false
  for (const key of tpl.vars) {
    const raw = String(values[key] ?? '').replace(/\s+/g, ' ').trim()
    if (isUrl(raw)) shortUrl = true
    recipient[key] = isUrl(raw) ? raw : raw.slice(0, DLT_VAR_MAX)
  }
  return { recipient, shortUrl }
}

export async function sendSms(msg: ChannelMessage, templates: DltTemplates): Promise<ChannelResult> {
  if (!msg.phone) return { channel: 'sms', outcome: 'skipped', detail: 'skipped:no-phone' }
  const mobile = indianMobile(msg.phone)
  if (!mobile) return { channel: 'sms', outcome: 'skipped', detail: 'skipped:not-indian-mobile' }
  const tpl = templates[msg.kind]
  if (!tpl) return { channel: 'sms', outcome: 'skipped', detail: 'skipped:no-dlt-template' }
  const key = authKey()
  if (!key) {
    console.warn(`[notify:sms STUB] would send ${msg.kind} (template ${tpl.templateId}) → user=${msg.userId}`)
    return { channel: 'sms', outcome: 'stub', detail: 'stub' }
  }
  const { recipient, shortUrl } = dltRecipient(mobile, tpl, { title: msg.title, body: msg.body, link: msg.absoluteLink ?? '', ...msg.values })
  const sender = process.env['MSG91_SENDER_ID']
  try {
    const res = await fetch(MSG91_FLOW_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', authkey: key },
      body: JSON.stringify({ template_id: tpl.templateId, short_url: shortUrl ? '1' : '0', ...(sender ? { sender } : {}), recipients: [recipient] }),
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS.notify),
    })
    const data = (await res.json().catch(() => ({}))) as { type?: string; message?: string }
    if (res.ok && data.type === 'success') return { channel: 'sms', outcome: 'sent', detail: 'sent' }
    const retryable = res.status === 429 || res.status >= 500
    // The vendor's words stay in our logs and the outbox row, never in a reply.
    return { channel: 'sms', outcome: 'failed', detail: `error:${res.status} ${String(data.message ?? '').slice(0, 120)}`, retryable }
  } catch (e) {
    return { channel: 'sms', outcome: 'failed', detail: `error:${(e as Error).message.slice(0, 120)}`, retryable: true }
  }
}
