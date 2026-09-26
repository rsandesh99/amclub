import type { SupabaseClient } from '@supabase/supabase-js'
import {
  WA_CONSENT_PURPOSES,
  WA_NOTICE_VERSION,
  type AgentPersona,
  type WaConsentAction,
  type WaConsentPurpose,
  type WaConsentSource,
  type WaConsentStatus,
} from '@amclub/shared'
import { channelIdentityOf, phoneDigits } from './binding'

/**
 * ADR-030 §2 — consent on WhatsApp, the runtime side. Consent belongs to a PHONE and a PURPOSE and is written only by
 * `record_wa_consent()` (0086, service role): one append-only event per purpose plus the current state. Delegation is
 * separate: START creates a WhatsApp `agent_grants` row for EACH persona the user holds (audit B3: msme → buyer,
 * provider → provider; ops / admin never), STOP revokes them all.
 *
 * Until 0086 is applied the RPC and tables are missing: every function here reports `not_ready` (logged once) and
 * the dispatcher falls back to the grant-only behaviour it had before (START = grants, STOP = revoke).
 *
 * The web has its own copy of the persona grant logic (apps/web/lib/whatsapp/consent.ts) for the settings toggle.
 */

/** Postgres / PostgREST "that relation / column / function does not exist" — a migration not applied yet. */
export function isMissingSchemaError(e: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!e) return false
  const code = String(e.code ?? '')
  if (['42P01', '42703', '42883', 'PGRST205', 'PGRST204', 'PGRST202'].includes(code)) return true
  return /does not exist|Could not find/i.test(String(e.message ?? ''))
}

const logged = new Set<string>()
export function logMissingOnce(what: string, detail: string): void {
  if (logged.has(what)) return
  logged.add(what)
  console.error(`[wa] ${what} unavailable (apply migration 0086 / 0087) — falling back:`, detail.slice(0, 200))
}

// ── recording ────────────────────────────────────────────────────────────────

export interface RecordConsentArgs {
  phone: string
  userId: string | null
  purposes: readonly WaConsentPurpose[]
  action: WaConsentAction
  source: WaConsentSource
  /** The keyword actually typed, or `button:<payload>` for a tap. */
  keyword?: string | null
  vendorMessageId?: string | null
  locale?: string | null
}

export type RecordConsentResult =
  | { ok: true; changed: number }
  | { ok: false; reason: 'not_ready' | 'bad_phone' | 'error'; error?: string }

/** One call of record_wa_consent (the ONE writer). `changed` = purposes whose state moved. */
export async function recordWaConsent(db: SupabaseClient, a: RecordConsentArgs): Promise<RecordConsentResult> {
  const digits = phoneDigits(a.phone)
  if (!/^\d{8,15}$/.test(digits)) return { ok: false, reason: 'bad_phone' }
  const { data, error } = await db.rpc('record_wa_consent', {
    p_phone: digits,
    p_user_id: a.userId,
    p_purposes: [...a.purposes],
    p_action: a.action,
    p_source: a.source,
    p_notice_version: WA_NOTICE_VERSION,
    p_keyword: a.keyword ? a.keyword.slice(0, 60) : null,
    p_vendor_message_id: a.vendorMessageId ?? null,
    p_locale: a.locale ?? null,
  })
  if (error) {
    if (isMissingSchemaError(error)) {
      logMissingOnce('record_wa_consent', error.message)
      return { ok: false, reason: 'not_ready' }
    }
    console.error('[wa] record_wa_consent failed', error.message)
    return { ok: false, reason: 'error', error: error.message }
  }
  const n = typeof data === 'number' ? data : Number(data ?? 0)
  return { ok: true, changed: Number.isFinite(n) ? n : 0 }
}

// ── reading ──────────────────────────────────────────────────────────────────

export interface PhoneConsent {
  /** False until 0086 is applied. */
  ready: boolean
  purposes: Record<WaConsentPurpose, WaConsentStatus>
}

const NONE = (): Record<WaConsentPurpose, WaConsentStatus> => ({ transactional: 'none', assistant: 'none', marketing: 'none' })

export async function phoneConsentState(db: SupabaseClient, phone: string): Promise<PhoneConsent> {
  const digits = phoneDigits(phone)
  if (!digits) return { ready: true, purposes: NONE() }
  const { data, error } = await db.from('wa_phone_consents').select('purpose, status').eq('phone_e164', digits)
  if (error) {
    if (isMissingSchemaError(error)) logMissingOnce('wa_phone_consents', error.message)
    else console.error('[wa] wa_phone_consents read failed', error.message)
    return { ready: false, purposes: NONE() }
  }
  const purposes = NONE()
  for (const r of (data as { purpose: string; status: string }[] | null) ?? []) {
    if ((WA_CONSENT_PURPOSES as readonly string[]).includes(r.purpose) && (r.status === 'opted_in' || r.status === 'opted_out')) purposes[r.purpose as WaConsentPurpose] = r.status
  }
  return { ready: true, purposes }
}

/**
 * A STOPped phone: it opted out of transactional AND assistant messages (STOP opts out of every purpose; the same two
 * switches off in settings mean the same). After STOP nothing answers on WhatsApp except the one opt-out confirmation
 * and a later START.
 */
export function isStopped(purposes: Record<WaConsentPurpose, WaConsentStatus>): boolean {
  return purposes.transactional === 'opted_out' && purposes.assistant === 'opted_out'
}

// ── recycled numbers ─────────────────────────────────────────────────────────

/**
 * ADR-030 recycled / shared numbers: the account bound to this phone has not signed in for `dormantDays` (last_seen_at,
 * else its creation), or Meta said the number changed hands after the account last signed in → ask the person to
 * sign in first and do nothing else for the account. `dormantDays = 0` turns the dormancy half off.
 */
export function needsRebindConfirmation(
  user: { lastSeenAt: string | null; createdAt: string | null },
  now: Date,
  dormantDays: number,
  numberChangedAt: string | null = null,
): boolean {
  const seen = user.lastSeenAt ?? user.createdAt
  const seenMs = seen ? new Date(seen).getTime() : NaN
  if (numberChangedAt) {
    const changedMs = new Date(numberChangedAt).getTime()
    if (Number.isFinite(changedMs) && (!Number.isFinite(seenMs) || changedMs > seenMs)) return true
  }
  if (!dormantDays || dormantDays <= 0) return false
  if (!Number.isFinite(seenMs)) return true
  return now.getTime() - seenMs > dormantDays * 24 * 3600 * 1000
}

// ── delegation (audit B3) ────────────────────────────────────────────────────

/** The agent personas a user's roles hold: msme → buyer, provider → provider. ops / admin never get a WhatsApp grant. */
export function personasForRoles(roles: readonly string[] | null | undefined): AgentPersona[] {
  const r = roles ?? []
  const out: AgentPersona[] = []
  if (r.includes('msme')) out.push('buyer')
  if (r.includes('provider')) out.push('provider')
  return out
}

export interface GrantSnapshot {
  locale: string
  source: WaConsentSource
  keyword: string | null
  vendorMessageId: string | null
}

/**
 * START (or the settings opt-in to the assistant): a WhatsApp grant from THIS phone for each persona the user holds.
 * Grants are immutable except revoke (0085): any active WhatsApp grant of the persona is revoked and a fresh one
 * inserted, KEEPING the scopes already consented from this phone (a Munshi / procurement enable widened them) — a grant
 * from another phone is revoked, never inherited (audit M41). A first opt-in grants no tools ([]).
 */
export async function grantWhatsAppPersonas(db: SupabaseClient, userId: string, phone: string, snap: GrantSnapshot, now: Date = new Date()): Promise<AgentPersona[]> {
  const digits = phoneDigits(phone)
  if (!digits) return []
  const { data: user } = await db.from('users').select('roles').eq('id', userId).maybeSingle()
  const personas = personasForRoles((user as { roles?: string[] | null } | null)?.roles)
  const at = now.toISOString()
  const consent = {
    locale: snap.locale,
    surface: 'whatsapp',
    ip: null,
    user_agent: 'whatsapp',
    text_version: WA_NOTICE_VERSION,
    notice_version: WA_NOTICE_VERSION,
    source: snap.source,
    keyword: snap.keyword,
    vendor_message_id: snap.vendorMessageId,
    purposes: ['transactional', 'assistant'],
    at,
  }
  const granted: AgentPersona[] = []
  for (const persona of personas) {
    const { data: prior } = await db.from('agent_grants').select('scopes, channel_identity').eq('user_id', userId).eq('persona', persona).eq('channel', 'whatsapp').is('revoked_at', null)
    const keep = [...new Set(((prior as { scopes: string[] | null; channel_identity: string | null }[] | null) ?? []).filter((g) => phoneDigits(g.channel_identity) === digits).flatMap((g) => g.scopes ?? []))]
    await db.from('agent_grants').update({ revoked_at: at }).eq('user_id', userId).eq('persona', persona).eq('channel', 'whatsapp').is('revoked_at', null)
    const { error } = await db.from('agent_grants').insert({ user_id: userId, persona, scopes: keep, channel: 'whatsapp', channel_identity: channelIdentityOf(digits), consent })
    if (error) console.error('[wa] WhatsApp grant insert failed', persona, error.message)
    else granted.push(persona)
  }
  return granted
}

/** STOP: every WhatsApp grant of the owner, whichever phone it came from (a withdrawal is never narrowed). */
export async function revokeWhatsAppGrants(db: SupabaseClient, userId: string, now: Date = new Date()): Promise<number> {
  const { data } = await db.from('agent_grants').update({ revoked_at: now.toISOString() }).eq('user_id', userId).eq('channel', 'whatsapp').is('revoked_at', null).select('id')
  return Array.isArray(data) ? data.length : 0
}
