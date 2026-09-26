/**
 * verify-whatsapp-consent.ts — ADR-030 §2 consent, keywords and the dispatcher (audit B1 / B3 / B4 / B8) against a
 * running web server and a disposable database (CI: the :3001 server with AGENT_ENABLED on).
 *
 *   offline  — the HELP-menu contact line agrees with lib/legal/grievance.ts; the keyword laws (greetings are never
 *              consent, "no" / "cancel" are never STOP, STOP / START in en / hi / te / ta).
 *   runtime  — the WhatsApp dispatcher driven IN-PROCESS (handleWaInbound, as the other agent rigs do; its own replies
 *              recorded through a wrapper around sendSystem):
 *                · a dual-role user's START → consent events for transactional + assistant (keyword, message id, notice
 *                  version) and a WhatsApp grant for buyer AND provider from this phone; the confirmation;
 *                · STOP → opt-out for all three purposes, every WhatsApp grant revoked, the conversation's pointers
 *                  cleared, the procurement session delivering there failed (wa_stop), one confirmation — then "hi"
 *                  gets nothing;
 *                · "no" / "cancel" revoke nothing; "hi" creates nothing and gets the menu;
 *                · an unknown number's STOP is recorded with user_id null;
 *                · cohort_mode 'all' lets an enabled agent serve a user outside cohort_user_ids.
 *   web      — GET/POST /api/v1/me/whatsapp: the state, the right source + ip on the event, assistant grants per persona
 *              on opt-in and revoked on opt-out, transactional opt-out only that purpose, a delegated agent token → 403
 *              (hand-signed like verify-authz §10), a wrong notice version → 409 notice_changed, no phone → 422,
 *              a WhatsApp source from a client → 422.
 *
 * Needs migration 0086 for the ledger legs; without it they are recorded skips and the web API must answer
 * 503 not_ready / ready:false. wa_consent_events is append-only evidence (0086): its rows stay (user_id nulled when the
 * rig's users are deleted); everything else is deleted and recounted.
 *
 * Run: BASE_URL=http://localhost:3001 [AUTHZ_JWT_SECRET=<the stack's JWT secret>] pnpm exec tsx scripts/verify-whatsapp-consent.ts
 */
import path from 'node:path'
import { createHmac, randomInt } from 'node:crypto'
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { WA_HELP_CONTACT, WA_MENU_KNOWN, WA_NOTICE_VERSION, classifyWaKeyword, waMenuPayload } from '@amclub/shared'
import { GRIEVANCE_OFFICER, GRIEVANCE_SLA, SUPPORT_CONTACT } from '../lib/legal/grievance'

config({ path: path.resolve(__dirname, '../.env.local') })

const BASE = (process.env['BASE_URL'] || '').replace(/\/$/, '')
const SUPA_URL = process.env['NEXT_PUBLIC_SUPABASE_URL'] || ''
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] || ''
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY'] || ''
const JWT_SECRET = process.env['AUTHZ_JWT_SECRET'] || ''
const NIL = '00000000-0000-0000-0000-000000000000'

type Status = 'pass' | 'FAIL' | 'skip'
const rows: { name: string; status: Status; detail?: string }[] = []
let failed = 0
function record(name: string, status: Status, detail?: string) {
  rows.push({ name, status, ...(detail ? { detail } : {}) })
  if (status === 'FAIL') failed++
}
const check = (name: string, cond: boolean, detail?: string) => record(name, cond ? 'pass' : 'FAIL', detail)
const skip = (name: string, why: string) => record(name, 'skip', why)
const json = (r: Response) => r.json().catch(() => ({})) as Promise<Record<string, unknown>>

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── offline ──────────────────────────────────────────────────────────────────

function offline() {
  check('the WhatsApp "talk to a person" contact is the grievance module\'s (email, phone, 24 h acknowledgement, grievance email)', WA_HELP_CONTACT.email === SUPPORT_CONTACT.email && WA_HELP_CONTACT.phone === SUPPORT_CONTACT.whatsapp && WA_HELP_CONTACT.acknowledgeHours === GRIEVANCE_SLA.acknowledgeHours && WA_HELP_CONTACT.grievanceEmail === GRIEVANCE_OFFICER.email, JSON.stringify(WA_HELP_CONTACT))
  const greet = ['hi', 'Hello!', 'ok', 'yes', 'namaste', 'नमस्ते', 'నమస్తే', 'வணக்கம்'].filter((t) => classifyWaKeyword(t)?.intent === 'start')
  check('greetings are never consent (hi / ok / yes / namaste in en / hi / te / ta)', greet.length === 0, greet.join(','))
  const noStop = ['no', 'No', 'cancel', 'नहीं', 'వద్దు'].filter((t) => classifyWaKeyword(t)?.intent === 'stop')
  check('"no" / "cancel" (and their hi / te forms) are never STOP', noStop.length === 0, noStop.join(','))
  const stops = ['STOP', 'stop please', 'Unsubscribe', 'बंद करो', 'ఆపండి', 'நிறுத்து'].filter((t) => classifyWaKeyword(t)?.intent !== 'stop')
  check('STOP / UNSUBSCRIBE in en / hi / te / ta, tolerant of "please" and punctuation', stops.length === 0, stops.join(','))
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** A delegated agent token as lib/agent/token.ts mints it (verify-authz §10). The guard reads the claims first. */
function delegatedToken(sub: string, persona: string): string {
  const b64u = (v: string) => Buffer.from(v).toString('base64url')
  const iat = Math.floor(Date.now() / 1000)
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64u(JSON.stringify({ sub, role: 'authenticated', aud: 'authenticated', iat, exp: iat + 600, amc_persona: persona }))
  return `${head}.${body}.${createHmac('sha256', JWT_SECRET || 'verify-whatsapp-consent-throwaway').update(`${head}.${body}`).digest('base64url')}`
}

async function http() {
  if (!BASE || !SUPA_URL || !ANON || !SERVICE) {
    skip('runtime + web checks', 'set BASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
    return
  }
  const admin: SupabaseClient = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } })
  const tag = `kt_wac_${Date.now().toString(36)}`
  const created = { users: [] as string[], convIds: [] as string[], phones: [] as string[], msmeIds: [] as string[], providerIds: [] as string[] }
  const settingsBefore = new Map<string, { existed: boolean; value: unknown }>()
  async function remember(key: string) {
    if (settingsBefore.has(key)) return
    const { data } = await admin.from('agent_settings').select('value').eq('key', key).maybeSingle()
    settingsBefore.set(key, { existed: !!data, value: data?.value ?? null })
  }
  const setSetting = async (key: string, value: unknown) => { await admin.from('agent_settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' }) }
  const phoneFor = () => `9${String(Date.now()).slice(-5)}${String(randomInt(0, 10_000)).padStart(4, '0')}`
  async function mkUser(label: string, roles: string[], opts: { phone?: boolean } = {}) {
    const email = `${tag}_${label}@killtest.amclub`
    const digits = phoneFor()
    const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
    if (error) throw new Error(`${label}: ${error.message}`)
    created.users.push(data.user.id)
    const { error: uErr } = await admin.from('users').insert({ id: data.user.id, email, phone: opts.phone === false ? null : `+91${digits}`, full_name: `KT ${label}`, roles, preferred_locale: 'en' })
    if (uErr) throw new Error(`users insert ${label}: ${uErr.message}`)
    if (opts.phone !== false) created.phones.push(`91${digits}`)
    const anon = createClient(SUPA_URL, ANON, { auth: { persistSession: false } })
    const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
    return { uid: data.user.id, token: s.session!.access_token, digits, phone: `91${digits}` }
  }
  const api = (token: string, p: string, body?: unknown, method = 'POST') =>
    fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  const missingRelation = (e: { message: string } | null | undefined) => !!e && /Could not find|does not exist|schema cache/.test(e.message)

  console.log(`\nverify-whatsapp-consent → ${BASE}\n`)
  const probe = await admin.from('wa_phone_consents').select('phone_e164').limit(1)
  const has0086 = !missingRelation(probe.error)
  const NEEDS_0086 = '0086 not applied on this DB — the consent ledger legs run once it is'

  try {
    // ── the runtime dispatcher, in-process ──────────────────────────────────
    process.env['AGENT_ENABLED'] = 'true'
    process.env['WHATSAPP_DRIVER'] = 'stub'
    process.env['API_URL'] = BASE
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const inbound = require('../../agent-runtime/src/whatsapp/inbound') as typeof import('../../agent-runtime/src/whatsapp/inbound')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const outboundMod = require('../../agent-runtime/src/whatsapp/outbound') as typeof import('../../agent-runtime/src/whatsapp/outbound')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rtSettings = require('../../agent-runtime/src/settings') as typeof import('../../agent-runtime/src/settings')
    const sent: Array<{ conv: string; kind: string; buttons: string[] }> = []
    const send: typeof outboundMod.sendSystem = async (conv, kind, locale, opts) => { sent.push({ conv: conv.id, kind, buttons: (opts.buttons ?? []).map((b) => b.id) }); return outboundMod.sendSystem(conv, kind, locale, opts) }
    const kindsOf = (conv: string) => sent.filter((s) => s.conv === conv).map((s) => s.kind)
    async function mkConv(phone: string, userId: string | null) {
      const { data, error } = await admin.from('wa_conversations').insert({ phone_e164: phone, user_id: userId, locale: 'en', last_inbound_at: new Date().toISOString(), window_open_until: new Date(Date.now() + 86400_000).toISOString() }).select('id').single()
      if (error) throw new Error(`conversation: ${error.message}`)
      created.convIds.push(data!.id)
      if (!created.phones.includes(phone)) created.phones.push(phone)
      return data!.id as string
    }
    let seq = 0
    async function say(conv: string, m: { body?: string; button?: string }) {
      const raw = m.button ? { type: 'interactive', timestamp: String(Math.floor(Date.now() / 1000)), interactive: { type: 'button_reply', button_reply: { id: m.button, title: m.body ?? m.button } } } : { type: 'text', timestamp: String(Math.floor(Date.now() / 1000)), text: { body: m.body } }
      const vendor = `${tag}-${++seq}`
      const { data, error } = await admin.from('wa_messages').insert({ conversation_id: conv, direction: 'in', vendor_message_id: vendor, kind: m.button ? 'button' : 'text', body: m.body ?? m.button ?? null, status: 'received', payload: raw }).select('id').single()
      if (error) throw new Error(`wa_messages: ${error.message}`)
      await inbound.handleWaInbound(data!.id as string, {}, { db: admin, send, capture: () => undefined })
      return vendor
    }
    const events = async (phone: string, since: string) => ((await admin.from('wa_consent_events').select('purpose, action, source, keyword, vendor_message_id, notice_version, user_id, ip, created_at').eq('phone_e164', phone).gte('created_at', since).order('created_at', { ascending: true })).data ?? []) as any[]
    const activeWa = async (uid: string) => ((await admin.from('agent_grants').select('id, persona, scopes, channel_identity').eq('user_id', uid).eq('channel', 'whatsapp').is('revoked_at', null)).data ?? []) as any[]

    const dual = await mkUser('dual', ['msme', 'provider'])
    const { data: m } = await admin.from('msme_profiles').insert({ user_id: dual.uid, business_name: `${tag} Co`, state: 'KA', sector: 'services' }).select('id').single()
    if (m) created.msmeIds.push(m.id)
    const convD = await mkConv(dual.phone, dual.uid)

    if (!has0086) {
      skip('START / STOP consent ledger (runtime)', NEEDS_0086)
      const v0 = await say(convD, { body: 'START' })
      const g0 = await activeWa(dual.uid)
      check('without 0086: START falls back to the grants — one WhatsApp grant per persona held (buyer + provider)', JSON.stringify(g0.map((g) => g.persona).sort()) === '["buyer","provider"]', `${v0} ${JSON.stringify(g0)}`)
    } else {
      // START
      const t0 = new Date(Date.now() - 1000).toISOString()
      const vStart = await say(convD, { body: 'START' })
      const ev = await events(dual.phone, t0)
      const g1 = await activeWa(dual.uid)
      check('a dual-role user\'s START → consent events for transactional + assistant (opt_in, whatsapp_keyword, keyword "START", the message id, the notice version, the user)', ev.length === 2 && JSON.stringify(ev.map((e) => e.purpose).sort()) === '["assistant","transactional"]' && ev.every((e) => e.action === 'opt_in' && e.source === 'whatsapp_keyword' && e.keyword === 'START' && e.vendor_message_id === vStart && e.notice_version === WA_NOTICE_VERSION && e.user_id === dual.uid), JSON.stringify(ev))
      check('… and a WhatsApp grant for buyer AND provider from this phone (audit B3), then the confirmation', JSON.stringify(g1.map((g) => g.persona).sort()) === '["buyer","provider"]' && g1.every((g) => g.channel_identity === `+${dual.phone}`) && kindsOf(convD).at(-1) === 'wa_opt_in_confirmed', JSON.stringify({ g1, sent: kindsOf(convD) }))

      // "no" / "cancel" / a nudge "No" button revoke nothing and record nothing
      const t1 = new Date(Date.now() - 1000).toISOString()
      await say(convD, { body: 'no' })
      await say(convD, { body: 'cancel' })
      await say(convD, { button: `nudge:no:${NIL}`, body: 'No' })
      check('"no", "cancel" and a nudge "No" button (payload nudge:no:…) record nothing and revoke nothing', (await events(dual.phone, t1)).length === 0 && (await activeWa(dual.uid)).length === 2)

      // STOP: pointers set first (an onboarding session, a support ticket, a procurement session delivering here)
      const exp = new Date(Date.now() + 3 * 86400_000).toISOString()
      const { data: onb } = await admin.from('onboarding_sessions').insert({ user_id: dual.uid, conversation_id: convD, surface: 'whatsapp', locale: 'en', state: 'language', expires_at: exp }).select('id').single()
      const { data: tk } = await admin.from('support_tickets').insert({ user_id: dual.uid, role: 'buyer', channel: 'whatsapp', conversation_id: convD, reason: 'rig', summary: 'rig' }).select('id').single()
      const { data: ps } = m ? await admin.from('procurement_sessions').insert({ user_id: dual.uid, msme_id: m.id, conversation_id: convD, surface: 'whatsapp', state: 'drafting', locale: 'en', expires_at: exp }).select('id').single() : { data: null }
      await admin.from('wa_conversations').update({ active_session_id: (onb as any)?.id ?? null, support_ticket_id: (tk as any)?.id ?? null }).eq('id', convD)
      await admin.from('wa_conversations').update({ procurement_session_id: (ps as any)?.id ?? null }).eq('id', convD)
      const t2 = new Date(Date.now() - 1000).toISOString()
      const sentBefore = kindsOf(convD).length
      const vStop = await say(convD, { body: 'STOP' })
      const ev2 = await events(dual.phone, t2)
      const { data: states } = await admin.from('wa_phone_consents').select('purpose, status').eq('phone_e164', dual.phone)
      const { data: cv } = await admin.from('wa_conversations').select('active_session_id, support_ticket_id, procurement_session_id').eq('id', convD).single()
      const { data: psAfter } = await admin.from('procurement_sessions').select('state, close_reason').eq('id', (ps as any)?.id ?? NIL).maybeSingle()
      check('STOP → opt_out for transactional + assistant + marketing (whatsapp_keyword, "STOP", the message id); the phone\'s state is opted_out for all three', ev2.length === 3 && ev2.every((e) => e.action === 'opt_out' && e.keyword === 'STOP' && e.vendor_message_id === vStop) && ((states ?? []) as any[]).length === 3 && ((states ?? []) as any[]).every((s) => s.status === 'opted_out'), JSON.stringify({ ev2, states }))
      check('STOP → every WhatsApp grant revoked; the conversation\'s onboarding / support / procurement pointers cleared; the procurement session delivering here failed (wa_stop); ONE confirmation', (await activeWa(dual.uid)).length === 0 && (cv as any)?.active_session_id === null && (cv as any)?.support_ticket_id === null && (cv as any)?.procurement_session_id === null && (!ps || ((psAfter as any)?.state === 'failed' && (psAfter as any)?.close_reason === 'wa_stop')) && JSON.stringify(kindsOf(convD).slice(sentBefore)) === '["wa_opt_out_confirmed"]', JSON.stringify({ cv, psAfter, sent: kindsOf(convD).slice(sentBefore) }))
      const after = kindsOf(convD).length
      await say(convD, { body: 'hi' })
      await say(convD, { body: 'where is my order' })
      await say(convD, { body: 'STOP' })
      check('after STOP: "hi" / free text get NOTHING (no menu, no model); a second STOP is recorded but not confirmed again', kindsOf(convD).length === after, JSON.stringify(kindsOf(convD).slice(after)))
      await admin.from('support_tickets').update({ status: 'resolved', resolved_at: new Date().toISOString() }).eq('id', (tk as any)?.id ?? NIL)

      // an unknown number's STOP
      const stranger = `91${phoneFor()}`
      const convX = await mkConv(stranger, null)
      const t3 = new Date(Date.now() - 1000).toISOString()
      await say(convX, { body: 'STOP' })
      const evX = await events(stranger, t3)
      check('an unknown number\'s STOP is recorded (3 opt_out events, user_id null) and confirmed', evX.length === 3 && evX.every((e) => e.action === 'opt_out' && e.user_id === null) && JSON.stringify(kindsOf(convX)) === '["wa_opt_out_confirmed"]', JSON.stringify({ evX, sent: kindsOf(convX) }))
    }

    // "hi" from a fresh user creates nothing and gets the menu
    const fresh = await mkUser('fresh', ['msme'])
    const convF = await mkConv(fresh.phone, fresh.uid)
    const t4 = new Date(Date.now() - 1000).toISOString()
    await say(convF, { body: 'hi' })
    const evF = has0086 ? await events(fresh.phone, t4) : []
    const menu = sent.filter((s) => s.conv === convF)
    check('"hi" creates no consent event and no grant — it gets the HELP menu (Track · Requests · Person · Language · Stop)', evF.length === 0 && (await activeWa(fresh.uid)).length === 0 && menu.length === 1 && menu[0]!.kind === 'wa_menu' && JSON.stringify(menu[0]!.buttons) === JSON.stringify(WA_MENU_KNOWN.map(waMenuPayload)), JSON.stringify({ evF, menu }))

    // cohort_mode (audit B8): 'all' serves a user outside cohort_user_ids; 'list' does not
    for (const k of ['agents_enabled', 'cohort_user_ids', 'cohort_mode']) await remember(k)
    const enabledBefore = (settingsBefore.get('agents_enabled')?.value ?? {}) as Record<string, boolean>
    await setSetting('agents_enabled', { ...enabledBefore, support: true })
    await setSetting('cohort_user_ids', ((settingsBefore.get('cohort_user_ids')?.value ?? []) as string[]).filter((u) => u !== fresh.uid))
    await setSetting('cohort_mode', 'list')
    const offList = await rtSettings.isAgentEnabledForUser(admin, 'support', fresh.uid)
    await setSetting('cohort_mode', 'all')
    const onAll = await rtSettings.isAgentEnabledForUser(admin, 'support', fresh.uid)
    await setSetting('agents_enabled', { ...enabledBefore, support: false })
    const offSwitch = await rtSettings.isAgentEnabledForUser(admin, 'support', fresh.uid)
    check("cohort_mode: 'list' keeps a user outside cohort_user_ids out; 'all' lets them in; the agent's own switch still wins", offList === false && onAll === true && offSwitch === false, JSON.stringify({ offList, onAll, offSwitch }))

    // ── the web consent API ────────────────────────────────────────────────
    const web = await mkUser('web', ['msme', 'provider'])
    const g0 = await api(web.token, '/api/v1/me/whatsapp', undefined, 'GET')
    const g0b = await json(g0)
    if (!has0086) {
      const p0 = await api(web.token, '/api/v1/me/whatsapp', { purpose: 'transactional', optIn: true, source: 'web_settings', noticeVersion: WA_NOTICE_VERSION })
      const p0b = await json(p0)
      check('without 0086: GET → ready:false; POST → 503 not_ready', g0.status === 200 && g0b['ready'] === false && p0.status === 503 && p0b['error'] === 'not_ready', JSON.stringify({ g0b, p0: p0.status, p0b }))
    } else {
      check('GET /me/whatsapp → ready, the phone masked to its last four digits, every purpose none, the notice version', g0.status === 200 && g0b['ready'] === true && String(g0b['phoneMasked'] ?? '').endsWith(web.digits.slice(-4)) && (String(g0b['phoneMasked'] ?? '').match(/\d/g) ?? []).length === 4 && JSON.stringify(g0b['purposes']) === JSON.stringify({ transactional: 'none', assistant: 'none', marketing: 'none' }) && g0b['noticeVersion'] === WA_NOTICE_VERSION, JSON.stringify(g0b))
      const t5 = new Date(Date.now() - 1000).toISOString()
      const p1 = await api(web.token, '/api/v1/me/whatsapp', { purpose: 'transactional', optIn: true, source: 'web_settings', noticeVersion: WA_NOTICE_VERSION })
      const p1b = await json(p1)
      const e1 = await events(web.phone, t5)
      check('POST transactional opt-in (web_settings) → 200, one event with source web_settings, the ip and the notice version; the state reads opted_in', p1.status === 200 && (p1b['purposes'] as any)?.transactional === 'opted_in' && e1.length === 1 && e1[0].source === 'web_settings' && e1[0].action === 'opt_in' && !!e1[0].ip && e1[0].notice_version === WA_NOTICE_VERSION && e1[0].user_id === web.uid, JSON.stringify({ status: p1.status, p1b, e1 }))
      const p2 = await api(web.token, '/api/v1/me/whatsapp', { purpose: 'assistant', optIn: true, source: 'mobile_settings', noticeVersion: WA_NOTICE_VERSION })
      await json(p2)
      const gw = await activeWa(web.uid)
      const e2 = (await events(web.phone, t5)).at(-1)
      check('POST assistant opt-in (mobile_settings) → the event carries mobile_settings; a WhatsApp grant per persona held (buyer + provider) from the account\'s phone', p2.status === 200 && e2?.source === 'mobile_settings' && e2?.purpose === 'assistant' && JSON.stringify(gw.map((g) => g.persona).sort()) === '["buyer","provider"]' && gw.every((g) => g.channel_identity === `+${web.phone}`), JSON.stringify({ status: p2.status, e2, gw }))
      const p3 = await api(web.token, '/api/v1/me/whatsapp', { purpose: 'transactional', optIn: false, source: 'web_settings', noticeVersion: WA_NOTICE_VERSION })
      const p3b = await json(p3)
      check('POST transactional opt-out → that purpose only (assistant stays opted in, the grants stay): not a full STOP', p3.status === 200 && (p3b['purposes'] as any)?.transactional === 'opted_out' && (p3b['purposes'] as any)?.assistant === 'opted_in' && (await activeWa(web.uid)).length === 2, JSON.stringify(p3b['purposes']))
      const p4 = await api(web.token, '/api/v1/me/whatsapp', { purpose: 'assistant', optIn: false, source: 'web_settings', noticeVersion: WA_NOTICE_VERSION })
      const p4b = await json(p4)
      check('POST assistant opt-out → every WhatsApp grant revoked', p4.status === 200 && (p4b['purposes'] as any)?.assistant === 'opted_out' && (await activeWa(web.uid)).length === 0, JSON.stringify(p4b['purposes']))
    }
    const stale = await api(web.token, '/api/v1/me/whatsapp', { purpose: 'transactional', optIn: true, source: 'web_settings', noticeVersion: 'wa-2020-01-01' })
    const staleB = await json(stale)
    check('a notice version other than the current one → 409 notice_changed (with the current version)', stale.status === 409 && staleB['error'] === 'notice_changed' && staleB['noticeVersion'] === WA_NOTICE_VERSION, `status ${stale.status} ${JSON.stringify(staleB)}`)
    const waSource = await api(web.token, '/api/v1/me/whatsapp', { purpose: 'transactional', optIn: true, source: 'whatsapp_keyword', noticeVersion: WA_NOTICE_VERSION })
    await json(waSource)
    check('a client cannot claim a WhatsApp source (whatsapp_keyword) → 422', waSource.status === 422, `status ${waSource.status}`)
    const del = await api(delegatedToken(web.uid, 'buyer'), '/api/v1/me/whatsapp', { purpose: 'assistant', optIn: true, source: 'web_settings', noticeVersion: WA_NOTICE_VERSION })
    const delB = await json(del)
    check(`a delegated agent token → exactly 403 (requireNotDelegated)${JWT_SECRET ? '' : ' — signed with a throwaway key: the guard reads the claims before any verification'}`, del.status === 403 && delB['error'] === 'tool_out_of_scope', `status ${del.status} ${JSON.stringify(delB)}`)
    const nophone = await mkUser('nophone', ['msme'], { phone: false })
    const np = await api(nophone.token, '/api/v1/me/whatsapp', { purpose: 'transactional', optIn: true, source: 'web_settings', noticeVersion: WA_NOTICE_VERSION })
    const npB = await json(np)
    check('an account with no phone → 422 phone_required (consent belongs to a phone)', np.status === 422 && npB['error'] === 'phone_required', `status ${np.status} ${JSON.stringify(npB)}`)
    const anonGet = await fetch(`${BASE}/api/v1/me/whatsapp`)
    await json(anonGet)
    check('GET /me/whatsapp without a session → 401', anonGet.status === 401, `status ${anonGet.status}`)
  } finally {
    // ── cleanup (FK order; wa_consent_events stay — append-only evidence) ─────
    const errors: string[] = []
    const del = async (label: string, q: PromiseLike<{ error: { message: string } | null }>) => { const { error } = await q; if (error && !/Could not find|does not exist|schema cache/.test(error.message)) errors.push(`${label}: ${error.message}`) }
    const users = created.users.length ? created.users : [NIL]
    const convIds = created.convIds.length ? created.convIds : [NIL]
    const phones = created.phones.length ? created.phones : ['0']
    await del('wa.pointers=null', admin.from('wa_conversations').update({ support_ticket_id: null, active_session_id: null }).in('id', convIds))
    await del('wa.procurement=null', admin.from('wa_conversations').update({ procurement_session_id: null }).in('id', convIds))
    await del('support_tickets', admin.from('support_tickets').delete().in('user_id', users))
    await del('procurement_sessions', admin.from('procurement_sessions').delete().in('user_id', users))
    await del('onboarding_sessions', admin.from('onboarding_sessions').delete().in('user_id', users))
    await del('wa_messages', admin.from('wa_messages').delete().in('conversation_id', convIds))
    await del('wa_conversations', admin.from('wa_conversations').delete().in('id', convIds))
    await del('agent_grants', admin.from('agent_grants').delete().in('user_id', users))
    await del('wa_phone_consents', admin.from('wa_phone_consents').delete().in('phone_e164', phones))
    await del('msme_profiles', admin.from('msme_profiles').delete().in('user_id', users))
    for (const [key, before] of settingsBefore) {
      if (before.existed) await setSetting(key, before.value)
      else await admin.from('agent_settings').delete().eq('key', key)
    }
    for (const uid of created.users) {
      await del('users', admin.from('users').delete().eq('id', uid))
      const { error } = await admin.auth.admin.deleteUser(uid)
      if (error) errors.push(`auth ${uid}: ${error.message}`)
    }
    const residue: string[] = []
    for (const [table, col, ids] of [['users', 'id', created.users], ['agent_grants', 'user_id', created.users], ['wa_conversations', 'id', created.convIds], ['wa_phone_consents', 'phone_e164', created.phones], ['support_tickets', 'user_id', created.users], ['procurement_sessions', 'user_id', created.users]] as const) {
      if (!ids.length) continue
      const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true }).in(col, [...ids])
      if (count && !error) residue.push(`${table}=${count}`)
    }
    check('cleanup: zero residue (the consent events stay as append-only evidence, their user_id nulled)', errors.length === 0 && residue.length === 0, [...errors, ...residue].join('; '))
  }
}

async function main() {
  offline()
  await http()
  for (const r of rows) console.log(`${r.status === 'pass' ? '✓' : r.status === 'skip' ? '⏭' : '✗'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
  const passed = rows.filter((r) => r.status === 'pass').length
  const skipped = rows.filter((r) => r.status === 'skip').length
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
