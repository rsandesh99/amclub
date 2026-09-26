import 'server-only'
import { fetchPages, notReady, phoneDigits, type Admin } from './common'

/**
 * ADR-030 §6 / DPDP s.11 — the "access" answer: one JSON document with the data AMClub holds about the account, built
 * on the service role for ops at /admin/privacy (download, audit-logged by the route). Sections: the account, its
 * business profiles, an orders summary, requests, consents (WhatsApp events and state, agent grants, analytics and
 * corpus choices), the WhatsApp messages of its conversations, notifications and its DPDP requests. Secrets (encrypted
 * columns, tokens, hashes) are left out; a section whose table is not migrated yet says so instead of failing.
 */

// PostgREST answers at most 1,000 rows per request; WhatsApp messages are read page by page
const LIMIT = { orders: 1000, rfqs: 500, notifications: 1000, messages: 5000, consents: 1000 } as const
const SECRET_KEY = /encrypt|secret|token|hash|password|_enc$|cipher/i

type Section = unknown[] | Record<string, unknown> | null | { not_available: string }

function strip<T extends Record<string, unknown>>(row: T | null): Record<string, unknown> | null {
  if (!row) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) if (!SECRET_KEY.test(k)) out[k] = v
  return out
}

async function rows(what: string, q: PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>): Promise<Section> {
  const { data, error } = await q
  if (error) {
    if (notReady(what, error)) return { not_available: 'not_migrated' }
    console.error('[privacy export]', what, error.message)
    return { not_available: 'read_failed' }
  }
  return (Array.isArray(data) ? data.map((r) => strip(r as Record<string, unknown>)) : strip(data as Record<string, unknown> | null)) as Section
}

export interface UserExport {
  format: 'amclub-dpdp-access-v1'
  generated_at: string
  user_id: string
  account: Section
  profiles: { msme: Section; provider: Section }
  orders: Section
  requests: Section
  consents: { whatsapp_events: Section; whatsapp_state: Section; agent_grants: Section }
  whatsapp: { conversations: Section; messages: Section }
  notifications: Section
  privacy_requests: Section
  notes: { amounts: 'paise'; times: 'utc'; orders: 'summary'; whatsapp_messages_truncated: boolean }
}

export async function buildUserExport(admin: Admin, userId: string): Promise<UserExport | null> {
  const { data: user, error: userErr } = await admin
    .from('users')
    .select('id, email, phone, full_name, preferred_locale, roles, created_at, corpus_consent_at, analytics_consent')
    .eq('id', userId)
    .maybeSingle()
  if (userErr) throw new Error(`users: ${userErr.message}`)
  if (!user) return null
  const phone = phoneDigits((user as { phone?: string | null }).phone)

  const [msme, provider] = await Promise.all([
    admin.from('msme_profiles').select('*').eq('user_id', userId).maybeSingle(),
    admin.from('provider_profiles').select('*').eq('user_id', userId).maybeSingle(),
  ])
  const msmeId = (msme.data as { id?: string } | null)?.id ?? null
  const providerId = (provider.data as { id?: string } | null)?.id ?? null
  const orderCols = 'id, order_number, title, status, total_paise, created_at'

  const [asBuyer, asProvider] = await Promise.all([
    msmeId ? rows('orders (buyer)', admin.from('orders').select(orderCols).eq('msme_id', msmeId).order('created_at', { ascending: false }).limit(LIMIT.orders)) : Promise.resolve([] as unknown[]),
    providerId ? rows('orders (provider)', admin.from('orders').select(orderCols).eq('provider_id', providerId).order('created_at', { ascending: false }).limit(LIMIT.orders)) : Promise.resolve([] as unknown[]),
  ])
  const tag = (s: Section, role: string) => (Array.isArray(s) ? s.map((r) => ({ role, ...(r as Record<string, unknown>) })) : s)

  const { data: convs } = await admin.from('wa_conversations').select('id, phone_e164, locale, created_at').eq('user_id', userId)
  const convIds = ((convs ?? []) as { id: string }[]).map((c) => c.id)

  const [requests, events, state, grants, messages, notifications, dpdp] = await Promise.all([
    msmeId ? rows('rfqs', admin.from('rfqs').select('id, title, status, details, created_at, expires_at').eq('msme_id', msmeId).order('created_at', { ascending: false }).limit(LIMIT.rfqs)) : Promise.resolve([] as unknown[]),
    rows('wa_consent_events', phone
      ? admin.from('wa_consent_events').select('phone_e164, purpose, action, source, notice_version, keyword, locale, created_at').or(`user_id.eq.${userId},phone_e164.eq.${phone}`).order('created_at', { ascending: false }).limit(LIMIT.consents)
      : admin.from('wa_consent_events').select('phone_e164, purpose, action, source, notice_version, keyword, locale, created_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(LIMIT.consents)),
    rows('wa_phone_consents', phone
      ? admin.from('wa_phone_consents').select('phone_e164, purpose, status, updated_at').or(`user_id.eq.${userId},phone_e164.eq.${phone}`)
      : admin.from('wa_phone_consents').select('phone_e164, purpose, status, updated_at').eq('user_id', userId)),
    rows('agent_grants', admin.from('agent_grants').select('persona, channel, scopes, created_at, revoked_at').eq('user_id', userId).order('created_at', { ascending: false })),
    convIds.length
      ? rows('wa_messages', fetchPages<Record<string, unknown>>((from, to) => admin.from('wa_messages').select('conversation_id, direction, kind, body, transcript, template_name, status, created_at, redacted_at').in('conversation_id', convIds).order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to), LIMIT.messages).then((r) => ({ data: r.rows, error: r.error })))
      : Promise.resolve([] as unknown[]),
    rows('notifications', admin.from('notifications').select('kind, title_i18n, body_i18n, link, created_at, read_at').eq('user_id', userId).order('created_at', { ascending: false }).limit(LIMIT.notifications)),
    rows('dpdp_requests', admin.from('dpdp_requests').select('kind, source, status, details, resolution, due_at, resolved_at, created_at').eq('user_id', userId).is('deleted_at', null).order('created_at', { ascending: false })),
  ])

  // machine-readable facts about the document (the cover message ops send is written in the user's language)
  const notes: UserExport['notes'] = {
    amounts: 'paise',
    times: 'utc',
    orders: 'summary',
    whatsapp_messages_truncated: Array.isArray(messages) && messages.length >= LIMIT.messages,
  }

  return {
    format: 'amclub-dpdp-access-v1',
    generated_at: new Date().toISOString(),
    user_id: userId,
    account: strip(user as Record<string, unknown>),
    profiles: { msme: strip(msme.data as Record<string, unknown> | null), provider: strip(provider.data as Record<string, unknown> | null) },
    orders: Array.isArray(asBuyer) && Array.isArray(asProvider) ? [...(tag(asBuyer, 'buyer') as unknown[]), ...(tag(asProvider, 'provider') as unknown[])] : { not_available: 'read_failed' },
    requests,
    consents: { whatsapp_events: events, whatsapp_state: state, agent_grants: grants },
    whatsapp: { conversations: ((convs ?? []) as Record<string, unknown>[]).map((c) => strip(c)), messages },
    notifications,
    privacy_requests: dpdp,
    notes,
  }
}
