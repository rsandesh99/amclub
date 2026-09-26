import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  WA_CONSENT_PURPOSES,
  WA_NOTICE_VERSION,
  WA_SUPPRESSION_REASONS,
  maskWaPhone,
  type AgentPersona,
  type WaConsentPurpose,
  type WaConsentSource,
  type WaConsentState,
  type WaConsentStatus,
  type WaSuppressionReason,
} from '@amclub/shared'

/**
 * ADR-030 §2 — WhatsApp consent, the web side (the settings toggles and the signup / checkout checkbox; the UI is
 * elsewhere). Consent belongs to a PHONE and a PURPOSE: the account's own `users.phone`, never a number from the body.
 * Every write goes through `record_wa_consent()` (0086, service role only) after the route's own checks. Opting in to
 * `assistant` also creates the WhatsApp agent grant for EACH persona the user holds (audit B3), as START does on
 * WhatsApp (the runtime has its own copy: apps/agent-runtime/src/whatsapp/consent.ts); opting out of it revokes them.
 *
 * Until 0086 is applied the tables and the function are missing: reads report `ready: false` and writes `not_ready`.
 */

export function isMissingSchemaError(e: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!e) return false
  if (['42P01', '42703', '42883', 'PGRST205', 'PGRST204', 'PGRST202'].includes(String(e.code ?? ''))) return true
  return /does not exist|Could not find/i.test(String(e.message ?? ''))
}

const phoneDigits = (p: string | null | undefined): string => String(p ?? '').replace(/\D/g, '')

/** The official AMClub WhatsApp number (E.164 digits) for wa.me links, or null when not configured. */
export function waBusinessNumber(): string | null {
  const d = phoneDigits(process.env['NEXT_PUBLIC_WHATSAPP_NUMBER'])
  return /^\d{8,15}$/.test(d) ? d : null
}

export type WaConsentView = WaConsentState & { ready: boolean }

/** The account's phone digits ('' when none). */
export async function accountPhoneDigits(admin: SupabaseClient, userId: string): Promise<string> {
  const { data } = await admin.from('users').select('phone').eq('id', userId).maybeSingle()
  return phoneDigits((data as { phone?: string | null } | null)?.phone)
}

/**
 * The state for the settings screen. A purpose whose current state was set for ANOTHER account (a number that
 * changed hands) reads `none`: an earlier holder's consent never speaks for this person.
 */
export async function readWaConsentState(admin: SupabaseClient, userId: string, now: Date = new Date()): Promise<WaConsentView> {
  const digits = await accountPhoneDigits(admin, userId)
  const purposes = Object.fromEntries(WA_CONSENT_PURPOSES.map((p) => [p, 'none'])) as Record<WaConsentPurpose, WaConsentStatus>
  const base: WaConsentView = { ready: true, phoneMasked: maskWaPhone(digits), purposes, suppressed: null, noticeVersion: WA_NOTICE_VERSION, businessNumber: waBusinessNumber() }
  if (!digits) return base
  const { data, error } = await admin.from('wa_phone_consents').select('purpose, status, user_id').eq('phone_e164', digits)
  if (error) {
    if (!isMissingSchemaError(error)) console.error('[wa-consent] read failed', error.message)
    return { ...base, ready: false }
  }
  for (const r of (data as { purpose: string; status: string; user_id: string | null }[] | null) ?? []) {
    if (!(WA_CONSENT_PURPOSES as readonly string[]).includes(r.purpose)) continue
    if (r.user_id && r.user_id !== userId) continue
    if (r.status === 'opted_in' || r.status === 'opted_out') purposes[r.purpose as WaConsentPurpose] = r.status
  }
  const { data: sup } = await admin.from('wa_suppressions').select('reason, until').eq('phone_e164', digits).maybeSingle()
  const s = sup as { reason?: string; until?: string | null } | null
  if (s?.reason && (WA_SUPPRESSION_REASONS as readonly string[]).includes(s.reason) && (!s.until || new Date(s.until).getTime() > now.getTime())) {
    base.suppressed = s.reason as WaSuppressionReason
  }
  return base
}

export interface WebConsentArgs {
  userId: string
  phoneDigits: string
  purpose: WaConsentPurpose
  optIn: boolean
  source: WaConsentSource
  locale: string | null
  ip: string | null
  userAgent: string | null
}

/** One call of record_wa_consent for one purpose. */
export async function recordWebWaConsent(admin: SupabaseClient, a: WebConsentArgs): Promise<'ok' | 'not_ready' | 'error'> {
  const { error } = await admin.rpc('record_wa_consent', {
    p_phone: a.phoneDigits,
    p_user_id: a.userId,
    p_purposes: [a.purpose],
    p_action: a.optIn ? 'opt_in' : 'opt_out',
    p_source: a.source,
    p_notice_version: WA_NOTICE_VERSION,
    p_keyword: null,
    p_vendor_message_id: null,
    p_locale: a.locale,
    p_ip: a.ip,
    p_user_agent: a.userAgent,
  })
  if (!error) return 'ok'
  if (isMissingSchemaError(error)) return 'not_ready'
  console.error('[wa-consent] record_wa_consent failed', error.message)
  return 'error'
}

/** msme → buyer, provider → provider; ops / admin never get a WhatsApp grant. */
export function personasForRoles(roles: readonly string[] | null | undefined): AgentPersona[] {
  const r = roles ?? []
  return [...(r.includes('msme') ? (['buyer'] as const) : []), ...(r.includes('provider') ? (['provider'] as const) : [])]
}

/**
 * A WhatsApp grant from the account's phone for EACH persona the user holds. Grants are immutable except revoke
 * (0085): the active WhatsApp grant of the persona is revoked and a fresh one inserted, KEEPING the scopes already
 * consented from this phone (Munshi / procurement widened them); a grant from another phone is never inherited.
 */
export async function grantWhatsAppPersonas(admin: SupabaseClient, userId: string, phone: string, consentSnapshot: Record<string, unknown>): Promise<AgentPersona[]> {
  const digits = phoneDigits(phone)
  if (!digits) return []
  const { data: user } = await admin.from('users').select('roles').eq('id', userId).maybeSingle()
  const personas = personasForRoles((user as { roles?: string[] | null } | null)?.roles)
  const at = new Date().toISOString()
  const granted: AgentPersona[] = []
  for (const persona of personas) {
    const { data: prior } = await admin.from('agent_grants').select('scopes, channel_identity').eq('user_id', userId).eq('persona', persona).eq('channel', 'whatsapp').is('revoked_at', null)
    const keep = [...new Set(((prior as { scopes: string[] | null; channel_identity: string | null }[] | null) ?? []).filter((g) => phoneDigits(g.channel_identity) === digits).flatMap((g) => g.scopes ?? []))]
    await admin.from('agent_grants').update({ revoked_at: at }).eq('user_id', userId).eq('persona', persona).eq('channel', 'whatsapp').is('revoked_at', null)
    const { error } = await admin.from('agent_grants').insert({ user_id: userId, persona, scopes: keep, channel: 'whatsapp', channel_identity: `+${digits}`, consent: { ...consentSnapshot, at } })
    if (error) console.error('[wa-consent] grant insert failed', persona, error.message)
    else granted.push(persona)
  }
  return granted
}

/** Every active WhatsApp grant of the user (a withdrawal is never narrowed to one phone or persona). */
export async function revokeWhatsAppGrants(admin: SupabaseClient, userId: string): Promise<number> {
  const { data } = await admin.from('agent_grants').update({ revoked_at: new Date().toISOString() }).eq('user_id', userId).eq('channel', 'whatsapp').is('revoked_at', null).select('id')
  return Array.isArray(data) ? data.length : 0
}
