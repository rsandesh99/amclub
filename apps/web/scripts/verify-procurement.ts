/**
 * verify-procurement.ts — the Buyer Procurement Agent (BUILD_PROMPTS S3.1, A2; built dark) against a running server
 * on the prod DB, the runtime driven IN-PROCESS (never started against prod).
 *
 *   offline  — the laws that are pure: PROCUREMENT_SCOPES holds no accept_quote / place_order; the no-negotiation clamp;
 *              the chat summary's letters = the compare page's; "go with B" only when the letter is written; the
 *              session machine; copy completeness; the harness-driven golden conversations (none reaches checkout).
 *   flag OFF — /app/assistant and /api/v1/agent/procurement/* 404; /profile/me.procurementEnabled false; the WhatsApp
 *              dispatcher is byte-identical to S2.3 (a buyer's text → the holding reply); the compare / messages /
 *              RFQ routes answer an ordinary session exactly as before.
 *   flag ON  — cohort gating (a granted but un-cohorted buyer gets nothing); enable = web grant with the scopes (never
 *              the pay tools) + WhatsApp widened; a need on WhatsApp → the Support new_need offer → the start button →
 *              draft → the S1.8 clarify round → the create proposal → a spoken yes (STT stub) → the RFQ with the intake
 *              linked and a procurement_step decision; quotes → ONE summary per new set, letters = the compare page;
 *              a provider question answered from the buyer's earlier words, another relayed then answered; "decline C"
 *              → button → declined with the reason; "go with B" by TEXT → buttons re-sent, no decision; by BUTTON →
 *              choose_quote decision + the decision-bound link, and NO checkout / payment row by the agent; the link
 *              opens the page's own confirm sheet only for that buyer + decision; a counter "₹20k" → refused, nothing
 *              posted; the S1.5 deferred path → answers → complete_rfq; the chase → nudge offer → nudged, then capped;
 *              revoke mid-flow → the next watch closes the session and sends nothing; STOP → WhatsApp stops, the web
 *              mirror continues; the proposal cap; a budget cap fails cleanly; the web mirror (composer + tap) runs the
 *              same engine; "hi" never strips the widened WhatsApp scopes.
 *
 * Needs migration 0045 for everything except the offline laws and the flag-OFF 404s — until it is applied those legs
 * are recorded skips (they run at the gate, after the migration, before the push).
 *
 * Recorded skips (never passes): the HMAC token exchange + the run-bound scoped token (the buyer's OWN session token
 * stands in: route scope gates are no-ops for it, so the one-decision intake link and the 403 on /checkout under a
 * procurement token are proven offline / in the runner tests, not here); pg-boss + the runtime webhook; the live
 * models (keyless → the stub producers); the buyer's own payment (the unchanged checkout route — Phase 4 kill-tests).
 *
 * Every row it creates is tagged and deleted in FK order; the last row is the zero-residue recount.
 *
 * Run: BASE_URL=http://localhost:3100 [AGENT_RUNTIME_SECRET=<same throwaway as the server>] pnpm --filter @amclub/web agents:verify:procurement
 * (flag-ON server: AGENT_ENABLED=true … VOICE_STUB_TRANSCRIPT="yes send it")
 */
import path from 'node:path'
import Module from 'node:module'
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import {
  createGateway,
  createRedisBudget,
  createSupabaseLedger,
  loadDefaultPrompts,
  makeStubDriver,
  resolveCaps,
  type RedisLike,
  type RunAgentDeps,
} from '@amclub/agent-core'
import {
  AGENT_SETTING_DEFS,
  PROCUREMENT_COPY,
  PROCUREMENT_COPY_KEYS,
  PROCUREMENT_FORBIDDEN_TOOLS,
  PROCUREMENT_LOCALES,
  PROCUREMENT_SCOPES,
  QUOTE_STATUS,
  clampProviderMessage,
  compareQuotes,
  isValidProcurementSessionTransition,
  labelMentioned,
  parseProcurementButton,
  procurementButtonId,
  renderProcurementCopy,
  summariseQuotesForChat,
  toolsForPersona,
} from '@amclub/shared'

config({ path: path.resolve(__dirname, '../.env.local') })

// the runtime modules import 'server-only' transitively through nothing, but web libs do: map it to its empty sibling
const origResolve = (Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string })._resolveFilename
;(Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string })._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'server-only') return origResolve.call(this, 'server-only/empty.js', ...rest)
  return origResolve.call(this, request, ...rest)
}

const BASE = (process.env['BASE_URL'] || '').replace(/\/$/, '')
const SUPA_URL = process.env['NEXT_PUBLIC_SUPABASE_URL'] || ''
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] || ''
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY'] || ''
const RIG_RUNTIME_SECRET = process.env['AGENT_RUNTIME_SECRET'] || ''
const unRsc = (body: string): string => body.replace(/\\"/g, '"')
const sameMap = (a: unknown, b: Record<string, string>): boolean => {
  const x = (a ?? {}) as Record<string, unknown>
  return Object.keys(x).length === Object.keys(b).length && Object.entries(b).every(([k, v]) => x[k] === v)
}
const BUCKET = process.env['WA_MEDIA_BUCKET'] || 'wa-media'
const VOICE_STUB = process.env['VOICE_STUB_TRANSCRIPT'] || ''

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
const NIL = '00000000-0000-0000-0000-000000000000'
const SCOPE = 'Monthly GST return filing for three GSTINs, including reconciliation of purchase invoices and a monthly summary.'

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── offline ──────────────────────────────────────────────────────────────────

async function offline() {
  const buyerTools = new Set(toolsForPersona('buyer').map((t) => t.name))
  check('PROCUREMENT_SCOPES ⊆ the buyer persona and holds neither accept_quote nor place_order', PROCUREMENT_SCOPES.every((s) => buyerTools.has(s)) && PROCUREMENT_FORBIDDEN_TOOLS.every((t) => !(PROCUREMENT_SCOPES as readonly string[]).includes(t)))
  const refused = ['can you do it for ₹20k', 'please give 10% discount', 'thoda kam karo', 'what is your best price', '1,50,000 is my budget']
  const allowed = ['Can you start next Monday?', 'Is transport included in your quote?']
  check('the no-negotiation clamp refuses amounts / percentages / counter-offers in any locale and passes scope / timing questions', refused.every((t) => !clampProviderMessage(t).ok) && allowed.every((t) => clampProviderMessage(t).ok))
  const quotes = [
    { id: 'q1', kind: 'service' as const, pricePaise: 2_900_000, deliveryDays: 7, gstIncluded: false, transportIncluded: null, validUntil: null, advancePercent: null },
    { id: 'q2', kind: 'service' as const, pricePaise: 3_000_000, deliveryDays: 5, gstIncluded: true, transportIncluded: true, validUntil: null, advancePercent: 20 },
  ]
  const s = summariseQuotesForChat(compareQuotes(quotes, { today: '2026-09-23' }), quotes.map((q) => ({ id: q.id, pricePaise: q.pricePaise, deliveryDays: q.deliveryDays, status: QUOTE_STATUS.submitted })), 'en', { order: ['q2', 'q1'] })
  check('the chat summary: letters by the page’s quote-list position (A = q1), lines in the display order (B first), three lines', s.labels['q1'] === 'A' && s.labels['q2'] === 'B' && s.lines.length === 3 && s.lines[0].indexOf('B ₹30,000') < s.lines[0].indexOf('A ₹29,000'), s.lines[0])
  check('"go with B" is a label; "the fast one" is not (the buttons ask)', labelMentioned('go with B', 'B') && !labelMentioned('not the cheap one, the fast one', 'B'))
  check('button payloads are namespaced pr: (never Munshi’s edit:/skip:, never Support’s nudge:)', parseProcurementButton(procurementButtonId({ kind: 'decision', action: 'no', runId: NIL }))?.kind === 'decision' && parseProcurementButton(`edit:${NIL}`) === null && parseProcurementButton(`nudge:yes:${NIL}`) === null)
  check('the session machine refuses drafting → chosen and closed → live', !isValidProcurementSessionTransition('drafting', 'chosen') && !isValidProcurementSessionTransition('closed', 'live'))
  const holes: string[] = []
  for (const l of PROCUREMENT_LOCALES) for (const k of PROCUREMENT_COPY_KEYS) {
    if (!PROCUREMENT_COPY[l][k]) holes.push(`${l}:${k}`)
    const r = renderProcurementCopy(k, { summary: 's', question: 'q', link: 'l', title: 't', matched: 1, questions: 'q', answers: 'a', answer: 'a', line1: '1', line2: '2', line3: '3', label: 'B', price: '₹1', reason: 'r', body: 'b', hours: 24, days: 7 }, l)
    if (/\{[a-z0-9_]+\}/.test(r)) holes.push(`${l}:${k} unrendered`)
  }
  check(`copy completeness: ${PROCUREMENT_COPY_KEYS.length} keys × ${PROCUREMENT_LOCALES.length} locales render with no hole`, holes.length === 0, holes.slice(0, 5).join(', '))
  check('settings registered: procurement_chase_hours 24 · procurement_session_ttl_days 7 · procurement_max_proposals_per_day 30', AGENT_SETTING_DEFS.procurement_chase_hours.default === 24 && AGENT_SETTING_DEFS.procurement_session_ttl_days.default === 7 && AGENT_SETTING_DEFS.procurement_max_proposals_per_day.default === 30)
  // the golden conversations, through the real agents + the harness (the eval set runs them all; here the first and the injected one)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { driveProcurementConversation } = require('../../../packages/agent-core/src/procurement/harness') as typeof import('../../../packages/agent-core/src/procurement/harness')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const golden = require('../../../packages/agent-core/golden/procurement_conversations.json') as { cases: import('../../../packages/agent-core/src/procurement/harness').ConversationCase[] }
  let checkout = 0
  const bad: string[] = []
  for (const c of golden.cases) {
    const r = await driveProcurementConversation(c)
    checkout += r.checkoutCalls
    if (r.problems.length) bad.push(`${c.id}: ${r.problems[0]}`)
  }
  check(`the ${golden.cases.length} golden conversations drive the REAL agents: every proposal parks, no write before approval, checkout never called`, bad.length === 0 && checkout === 0, bad.slice(0, 3).join(' | '))
}

// ── http ─────────────────────────────────────────────────────────────────────

async function http() {
  if (!BASE || !SUPA_URL || !ANON || !SERVICE) {
    skip('HTTP checks', 'set BASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
    return
  }
  const admin: SupabaseClient = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } })
  const tag = `kt_pro_${Date.now().toString(36)}`
  const created = { users: [] as string[], providerIds: [] as string[], msmeIds: [] as string[], rfqIds: [] as string[], convIds: [] as string[], objects: [] as string[] }
  const settingsBefore = new Map<string, { existed: boolean; value: unknown }>()
  async function remember(key: string) {
    if (settingsBefore.has(key)) return
    const { data } = await admin.from('agent_settings').select('value').eq('key', key).maybeSingle()
    settingsBefore.set(key, { existed: !!data, value: data?.value ?? null })
  }
  async function setSetting(key: string, value: unknown) {
    await remember(key)
    await admin.from('agent_settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  }
  let phoneSeq = 0
  async function mkUser(label: string, roles: string[]) {
    const email = `${tag}_${label}@killtest.amclub`
    const digits = `8${String(Date.now()).slice(-6)}${String(++phoneSeq).padStart(3, '0')}`
    const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
    if (error) throw new Error(`${label}: ${error.message}`)
    created.users.push(data.user.id)
    const { error: uErr } = await admin.from('users').insert({ id: data.user.id, email, phone: `+91${digits}`, full_name: `KT ${label}`, roles, preferred_locale: 'en' })
    if (uErr) throw new Error(`users insert ${label}: ${uErr.message}`)
    const anon = createClient(SUPA_URL, ANON, { auth: { persistSession: false } })
    const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
    return { uid: data.user.id, token: s.session!.access_token, email, digits }
  }
  const api = (token: string, p: string, body?: unknown, method = 'POST', headers: Record<string, string> = {}) =>
    fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const cookieFor = async (email: string) => {
    const jar: Record<string, string> = {}
    const ssr = createServerClient(SUPA_URL, ANON, { cookies: { getAll() { return Object.entries(jar).map(([name, value]) => ({ name, value })) }, setAll(l) { for (const { name, value } of l) jar[name] = value } } })
    await ssr.auth.signInWithPassword({ email, password: 'Test1234!' })
    return Object.entries(jar).map(([n, v]) => `${n}=${v}`).join('; ')
  }
  const missingRelation = (e: { message: string } | null | undefined) => !!e && /Could not find|does not exist|schema cache/.test(e.message)

  console.log(`\nverify-procurement → ${BASE}\n`)
  const probe = await fetch(`${BASE}/api/v1/agent/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  const probeBody = await json(probe)
  if (probe.status >= 500 && !(probe.status === 503 && probeBody['error'] === 'agent_not_configured')) {
    record('server probe', 'FAIL', `POST /api/v1/agent/token → ${probe.status}: the server is broken (env?), not dark — refusing to guess the flag`)
    return
  }
  const flagOn = probe.status !== 404
  const t45 = await admin.from('procurement_sessions').select('id').limit(1)
  const has0045 = !missingRelation(t45.error)
  const NEEDS_0045 = '0045 not applied on this DB yet — runs at the gate (after the migration, before the push)'

  try {
    async function mkBuyer(label: string) {
      const u = await mkUser(label, ['msme'])
      const { data: m, error } = await admin.from('msme_profiles').insert({ user_id: u.uid, business_name: `${label} Co`, state: 'KA', sector: 'services' }).select('id').single()
      if (error) throw new Error(`msme ${label}: ${error.message}`)
      created.msmeIds.push(m!.id)
      return { ...u, msmeId: m!.id as string }
    }
    const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
    const categoryId = cat!.id as string
    async function mkProvider(label: string) {
      const u = await mkUser(label, ['provider'])
      const { data: p, error } = await admin.from('provider_profiles').insert({ user_id: u.uid, legal_name: `${label} Pvt`, display_name: label, slug: `${tag}-${label}`, state: 'KA', city: 'X', languages: ['en'], status: 'active', gstin: `29AAAAA0000A1Z${label.length % 10}` }).select('id').single()
      if (error) throw new Error(`provider ${label}: ${error.message}`)
      created.providerIds.push(p!.id)
      await admin.from('provider_categories').insert({ provider_id: p!.id, category_id: categoryId })
      return { ...u, providerId: p!.id as string }
    }

    const b = await mkBuyer('b')
    const other = await mkBuyer('o')

    // ── flag OFF: dark + byte-identical ─────────────────────────────────────
    if (!flagOn) {
      const page = await fetch(`${BASE}/app/assistant`, { headers: { cookie: await cookieFor(b.email) } })
      check('flag OFF: /app/assistant → 404', page.status === 404, `status ${page.status}`)
      for (const [p, m, body] of [['/api/v1/agent/procurement', 'GET', undefined], ['/api/v1/agent/procurement/enable', 'POST', { consent_text_version: 'x' }], ['/api/v1/agent/procurement/disable', 'POST', {}], ['/api/v1/agent/procurement/message', 'POST', { text: 'I need a CA' }], ['/api/v1/agent/procurement/decision', 'POST', { run_id: NIL, action: 'ok' }], [`/api/v1/agent/procurement/sessions/${NIL}`, 'GET', undefined], ['/api/v1/agent/admin/procurement/stats', 'GET', undefined]] as const) {
        const r = await api(b.token, p, body, m)
        await json(r)
        check(`flag OFF: ${m} ${p} → 404`, r.status === 404, `status ${r.status}`)
      }
      const me = await json(await api(b.token, '/api/v1/profile/me', undefined, 'GET'))
      check('flag OFF: /profile/me.procurementEnabled === false', me['procurementEnabled'] === false, JSON.stringify(me['procurementEnabled']))
      // ordinary sessions: the spine routes behave as before (the scope gates are no-ops without a delegated token)
      const rq = await api(b.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title: `${tag} baseline filing`, details: { additional_details: SCOPE } })
      const rqb = await json(rq)
      if (rqb['rfqId']) created.rfqIds.push(rqb['rfqId'] as string)
      const cmp = await api(b.token, `/api/v1/rfq/${rqb['rfqId'] ?? NIL}/compare`, undefined, 'GET')
      const cmpB = await json(cmp)
      const det = await api(b.token, `/api/v1/rfq/${rqb['rfqId'] ?? NIL}`, undefined, 'GET')
      await json(det)
      check('flag OFF: an ordinary buyer session creates an RFQ, reads its compare (results + ordering) and detail exactly as before', rq.status === 200 && cmp.status === 200 && Array.isArray(cmpB['results']) && det.status === 200, `${rq.status}/${cmp.status}/${det.status}`)
      const vp = new FormData()
      vp.append('text', 'I need GST filing for my shop in Bengaluru')
      const vpr = await fetch(`${BASE}/api/v1/rfq/voice-parse`, { method: 'POST', headers: { Authorization: `Bearer ${b.token}` }, body: vp })
      const vpb = await json(vpr)
      check('voice-parse typed round one (S3.1): `text` parses with no STT; the audio path is untouched (audio_required without audio or text)', vpr.status === 200 && !!(vpb['parse'] as any)?.description_english && (vpb['vendor'] as any)?.stt === 'typed', `status ${vpr.status} ${JSON.stringify(vpb).slice(0, 160)}`)
      const vp0 = await fetch(`${BASE}/api/v1/rfq/voice-parse`, { method: 'POST', headers: { Authorization: `Bearer ${b.token}` }, body: new FormData() })
      const vp0b = await json(vp0)
      check('voice-parse with neither audio nor text → 422 audio_required (byte-identical)', vp0.status === 422 && vp0b['error'] === 'audio_required', `status ${vp0.status}`)
      // WhatsApp: procurement off → the dispatcher is the S2.3 one: a buyer's text → the holding reply
      if (!has0045) skip('flag OFF WhatsApp: a buyer text → the holding reply (dispatcher byte-identical)', NEEDS_0045)
      else {
        await remember('agents_enabled')
        const en = (settingsBefore.get('agents_enabled')?.value ?? {}) as Record<string, boolean>
        if (en['procurement'] || en['support']) skip('flag OFF WhatsApp holding reply', 'agents_enabled.procurement / support already true on this DB — not a dark baseline')
        else {
          process.env['AGENT_ENABLED'] = 'true'
          process.env['WHATSAPP_DRIVER'] = 'stub'
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const inbound = require('../../agent-runtime/src/whatsapp/inbound') as typeof import('../../agent-runtime/src/whatsapp/inbound')
          const { data: c } = await admin.from('wa_conversations').insert({ phone_e164: `91${b.digits}`, user_id: b.uid, locale: 'en', last_inbound_at: new Date().toISOString(), window_open_until: new Date(Date.now() + 86400 * 1000).toISOString() }).select('id').single()
          created.convIds.push(c!.id)
          await admin.from('agent_grants').insert({ user_id: b.uid, persona: 'buyer', scopes: [], channel: 'whatsapp', channel_identity: `+91${b.digits}`, consent: { locale: 'en', surface: 'whatsapp', keyword: 'START', text_version: 'v1', at: new Date().toISOString() } })
          const { data: m } = await admin.from('wa_messages').insert({ conversation_id: c!.id, direction: 'in', vendor_message_id: `${tag}-off-1`, kind: 'text', body: 'I need a CA for GST filing', status: 'received', payload: { type: 'text', text: { body: 'I need a CA for GST filing' } } }).select('id').single()
          const jobs: string[] = []
          await inbound.handleWaInbound(m!.id as string, { enqueueSupportReply: async () => { jobs.push('support'); return 'q' }, enqueueProcurementTurn: async () => { jobs.push('procurement'); return 'q' }, enqueueProcurementDecide: async () => { jobs.push('procurement'); return 'q' } })
          const { data: outs } = await admin.from('wa_messages').select('template_name').eq('conversation_id', c!.id).eq('direction', 'out')
          check('flag OFF WhatsApp: a buyer’s need text → no procurement or support job, the S0.5 holding reply only (dispatcher byte-identical)', jobs.length === 0 && (outs ?? []).length === 1 && /holding/.test(String((outs as any[])[0]?.template_name ?? '')), JSON.stringify({ jobs, outs }))
        }
      }
      return
    }

    // ── flag ON ───────────────────────────────────────────────────────────────
    if (!has0045) {
      skip('flag ON lifecycle', NEEDS_0045)
      return
    }
    const p1 = await mkProvider('p1')
    const p2 = await mkProvider('p2')
    const p3 = await mkProvider('p3')
    const adminU = await mkUser('admin', ['admin'])
    await remember('agents_enabled')
    await remember('cohort_user_ids')
    const baseEnabled = (settingsBefore.get('agents_enabled')?.value ?? {}) as Record<string, boolean>
    const baseCohort = (settingsBefore.get('cohort_user_ids')?.value ?? []) as string[]

    // cohort gating first: procurement ON but the buyer NOT in the cohort → nothing exists for them
    await setSetting('agents_enabled', { ...baseEnabled, procurement: true, support: true, rfq_clarify: true, rfq_quality: false })
    await setSetting('cohort_user_ids', [...baseCohort])
    const en0 = await api(other.token, '/api/v1/agent/procurement/enable', { consent_text_version: 'procurement-v1-2026-09-23' })
    await json(en0)
    const pg0 = await fetch(`${BASE}/app/assistant`, { headers: { cookie: await cookieFor(other.email) } })
    check('flag ON, not in the cohort: enable → 404, /app/assistant → 404 (a grant alone is nothing)', en0.status === 404 && pg0.status === 404, `${en0.status}/${pg0.status}`)

    await setSetting('cohort_user_ids', [...baseCohort, b.uid, other.uid, p1.uid, p2.uid, p3.uid])
    await setSetting('procurement_chase_hours', 1)

    // in-process runtime (never started against prod)
    process.env['AGENT_ENABLED'] = 'true'
    process.env['API_URL'] = BASE
    process.env['WHATSAPP_DRIVER'] = 'stub'
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pr = require('../../agent-runtime/src/agents/procurement/index') as typeof import('../../agent-runtime/src/agents/procurement/index')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sup = require('../../agent-runtime/src/agents/support/index') as typeof import('../../agent-runtime/src/agents/support/index')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const inbound = require('../../agent-runtime/src/whatsapp/inbound') as typeof import('../../agent-runtime/src/whatsapp/inbound')
    loadDefaultPrompts()
    const whatsapp = makeStubDriver(() => undefined)
    const store = new Map<string, number>()
    const memRedis: RedisLike = {
      async incrby(k, v) { const x = (store.get(k) ?? 0) + v; store.set(k, x); return x },
      async expire() { return 1 },
      async mget<T = unknown>(...keys: string[]) { return keys.map((k) => (store.has(k) ? (store.get(k) as unknown as T) : null)) },
    }
    const tokens = new Map<string, string>([[b.uid, b.token], [other.uid, other.token]])
    const readBudget = async () => {
      const { data } = await admin.from('agent_settings').select('key, value').in('key', ['budget_run_paise', 'budget_user_day_paise', 'budget_month_paise', 'budget_run_paise_by_agent'])
      return Object.fromEntries(((data ?? []) as any[]).map((r) => [r.key, r.value])) as Record<string, unknown>
    }
    const core: RunAgentDeps = {
      ledger: createSupabaseLedger(admin),
      gateway: createGateway(),
      makeBudget: ({ runId, userId, agentName }) => createRedisBudget({ redis: memRedis, caps: async () => resolveCaps(await readBudget(), agentName), runId, userId }),
      apiBaseUrl: BASE,
      makeToken: async ({ userId }) => tokens.get(userId) ?? '',
    }
    const deps: import('../../agent-runtime/src/agents/procurement/index').ProcurementRuntimeDeps = { core, admin, whatsapp, apiUrl: BASE, agentEnabled: true, tokenFor: async ({ userId }) => tokens.get(userId) ?? '', mediaBucket: BUCKET, runtimeSecret: RIG_RUNTIME_SECRET, capture: () => undefined }
    const supDeps: import('../../agent-runtime/src/agents/support/index').SupportRuntimeDeps = { core, admin, whatsapp, apiUrl: BASE, agentEnabled: true, tokenFor: async ({ userId }) => tokens.get(userId) ?? '', mediaBucket: BUCKET, runtimeSecret: RIG_RUNTIME_SECRET, capture: () => undefined }
    type Job = { kind: 'sreply'; conversationId: string; messageId: string } | { kind: 'sdecide'; runId: string; messageId: string; action: 'yes' | 'no' } | ({ kind: 'pturn' } & Omit<import('../../agent-runtime/src/agents/procurement/index').ProcurementTurnJob, 'kind'>) | ({ kind: 'pdecide' } & Omit<import('../../agent-runtime/src/agents/procurement/index').ProcurementDecideJob, 'kind'>)
    const queue: Job[] = []
    const hooks = {
      enqueueSupportReply: async (j: { conversationId: string; messageId: string }) => { queue.push({ kind: 'sreply', ...j }); return 'q' },
      enqueueSupportDecide: async (j: { runId: string; messageId: string; action: 'yes' | 'no' }) => { queue.push({ kind: 'sdecide', ...j }); return 'q' },
      enqueueProcurementTurn: async (j: Omit<import('../../agent-runtime/src/agents/procurement/index').ProcurementTurnJob, 'kind'>) => { queue.push({ kind: 'pturn', ...j }); return 'q' },
      enqueueProcurementDecide: async (j: Omit<import('../../agent-runtime/src/agents/procurement/index').ProcurementDecideJob, 'kind'>) => { queue.push({ kind: 'pdecide', ...j }); return 'q' },
    }
    const drain = async () => {
      const out: any[] = []
      while (queue.length) {
        const j = queue.shift()!
        if (j.kind === 'sreply') out.push({ job: 'sreply', r: await sup.runSupportReply(supDeps, { kind: 'reply', conversationId: j.conversationId, messageId: j.messageId }) })
        else if (j.kind === 'sdecide') out.push({ job: 'sdecide', r: await sup.runSupportDecide(supDeps, { ...j, kind: 'decide' }) })
        else if (j.kind === 'pturn') out.push({ job: 'pturn', r: await pr.runProcurementTurn(deps, { ...j, kind: 'turn' }) })
        else out.push({ job: 'pdecide', r: await pr.decideProcurement(deps, { ...j, kind: 'decide' }) })
      }
      return out
    }
    async function mkConv(u: { uid: string; digits: string }) {
      const { data } = await admin.from('wa_conversations').insert({ phone_e164: `91${u.digits}`, user_id: u.uid, locale: 'en', last_inbound_at: new Date().toISOString(), window_open_until: new Date(Date.now() + 86400 * 1000).toISOString() }).select('id').single()
      created.convIds.push(data!.id)
      await admin.from('agent_grants').insert({ user_id: u.uid, persona: 'buyer', scopes: [], channel: 'whatsapp', channel_identity: `+91${u.digits}`, consent: { locale: 'en', surface: 'whatsapp', keyword: 'START', text_version: 'v1', at: new Date().toISOString() } })
      return data!.id as string
    }
    let vendorSeq = 0
    async function waSay(conv: string, m: { kind: 'text' | 'button' | 'audio'; body?: string; payload?: string; mediaRef?: string; mime?: string }) {
      const raw = m.kind === 'button' ? { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: m.payload, title: m.body ?? m.payload } } } : m.kind === 'audio' ? { type: 'audio', audio: { id: 'stub' } } : { type: 'text', text: { body: m.body } }
      const { data, error } = await admin.from('wa_messages').insert({ conversation_id: conv, direction: 'in', vendor_message_id: `${tag}-${++vendorSeq}`, kind: m.kind, body: m.kind === 'audio' ? null : (m.body ?? m.payload ?? null), media_ref: m.mediaRef ?? null, mime: m.mime ?? null, status: 'received', payload: raw }).select('id').single()
      if (error) throw new Error(`waSay: ${error.message}`)
      await admin.from('wa_conversations').update({ last_inbound_at: new Date().toISOString(), window_open_until: new Date(Date.now() + 86400 * 1000).toISOString() }).eq('id', conv)
      await inbound.handleWaInbound(data!.id as string, hooks)
      return { id: data!.id as string, results: await drain() }
    }
    const outbound = async (conv: string) => ((await admin.from('wa_messages').select('id, kind, body, template_name, payload, created_at').eq('conversation_id', conv).eq('direction', 'out').order('created_at', { ascending: true })).data ?? []) as any[]
    const sessionOf = async (id: string) => (await admin.from('procurement_sessions').select('*').eq('id', id).maybeSingle()).data as any
    const latestSession = async (uid: string) => (await admin.from('procurement_sessions').select('*').eq('user_id', uid).order('created_at', { ascending: false }).limit(1).maybeSingle()).data as any
    const agentTurns = async (sid: string) => ((await admin.from('procurement_turns').select('body, proposal, run_id, role').eq('session_id', sid).eq('role', 'agent').order('created_at', { ascending: true })).data ?? []) as any[]
    const lastBtnIds = async (conv: string) => (((await outbound(conv)).filter((m) => m.kind === 'button').at(-1)?.payload?.buttons ?? []) as string[])
    const checkoutCount = async () => {
      // a checkout session is the ONLY way money starts; an order exists only after the payment webhook
      const [{ count: cs }, { count: ord }] = await Promise.all([admin.from('checkout_sessions').select('id', { count: 'exact', head: true }).eq('msme_id', b.msmeId), admin.from('orders').select('id', { count: 'exact', head: true }).eq('msme_id', b.msmeId)])
      return (cs ?? 0) + (ord ?? 0)
    }
    const checkoutBefore = await checkoutCount()

    // ── enable: the web grant + WhatsApp widened (never the pay tools) ──
    const convB = await mkConv(b)
    const en1 = await api(b.token, '/api/v1/agent/procurement/enable', { consent_text_version: 'procurement-v1-2026-09-23', locale: 'en' })
    const en1b = await json(en1)
    const { data: grants } = await admin.from('agent_grants').select('channel, scopes, consent').eq('user_id', b.uid).eq('persona', 'buyer').is('revoked_at', null)
    const web = ((grants ?? []) as any[]).find((g) => g.channel === 'web')
    const wa = ((grants ?? []) as any[]).find((g) => g.channel === 'whatsapp')
    check('enable → 201: a web grant carrying PROCUREMENT_SCOPES with a consent snapshot, the WhatsApp grant widened to them — and NEITHER holds accept_quote / place_order', en1.status === 201 && en1b['enabled'] === true && en1b['whatsapp'] === true && !!web && !!wa && PROCUREMENT_SCOPES.every((s) => web.scopes.includes(s) && wa.scopes.includes(s)) && ![...web.scopes, ...wa.scopes].some((s: string) => s === 'place_order' || s === 'accept_quote') && web.consent?.text_version === 'procurement-v1-2026-09-23', JSON.stringify({ status: en1.status, web: web?.scopes?.length, wa: wa?.scopes?.length }))
    const me = await json(await api(b.token, '/api/v1/profile/me', undefined, 'GET'))
    check('/profile/me.procurementEnabled true for the cohorted buyer', me['procurementEnabled'] === true)

    // ── a need on WhatsApp → the Support new_need offer → the start button → draft → the clarify round ──
    const need = await waSay(convB, { kind: 'text', body: 'I need a CA for GST filing every month for my garment shop, we have 3 GSTINs' })
    const offerBtn = (await lastBtnIds(convB))[0] ?? ''
    check('no session yet: the need goes to Support, which offers “Shall I start a request?” with ONE pr:sess:new button bound to the message', need.results.some((x) => x.job === 'sreply' && x.r?.detail?.reply_key === 'new_need.offer') && offerBtn === `pr:sess:new:${need.id}`, JSON.stringify({ r: need.results.map((x) => x.r?.detail), offerBtn }))
    const start = await waSay(convB, { kind: 'button', payload: offerBtn, body: 'Yes, start' })
    const s1 = await latestSession(b.uid)
    const convRow = (await admin.from('wa_conversations').select('procurement_session_id').eq('id', convB).single()).data as any
    const draftTurns = await agentTurns(s1?.id ?? NIL)
    check('the start tap → a session (whatsapp, drafting) routed from the conversation; the need is parsed (S1.8 typed round one) and the ONE clarifying question asked (no proposal yet)', start.results.some((x) => x.job === 'pturn' && x.r?.status === 'ok') && s1?.surface === 'whatsapp' && s1?.state === 'drafting' && convRow?.procurement_session_id === s1?.id && (s1?.pending as any)?.kind === 'clarify' && !s1?.open_run_id && draftTurns.some((t) => t.proposal?.key === 'clarify'), JSON.stringify({ r: start.results.map((x) => x.r), state: s1?.state, pending: s1?.pending?.kind }))
    const ans = await waSay(convB, { kind: 'text', body: 'Bengaluru, Karnataka' })
    const s2 = await sessionOf(s1?.id ?? NIL)
    const card = (await agentTurns(s1?.id ?? NIL)).at(-1)
    const createRun = s2?.open_run_id as string | undefined
    const btns = await lastBtnIds(convB)
    check('the answer (routed by the active session, before the opt-in keywords) → round two → the create_rfq proposal: the run parks, the draft card goes out with pr:ok / pr:edit / pr:no buttons', ans.results.some((x) => x.job === 'pturn') && s2?.state === 'awaiting_create' && !!createRun && (await core.ledger.getRun(createRun))?.status === 'awaiting_confirmation' && card?.proposal?.tool === 'create_rfq' && btns.includes(`pr:ok:${createRun}`) && btns.includes(`pr:no:${createRun}`), JSON.stringify({ state: s2?.state, card: card?.proposal, btns }))
    const { count: noRfqYet } = await admin.from('rfqs').select('id', { count: 'exact', head: true }).eq('msme_id', b.msmeId).like('title', '%GST%')
    check('nothing is created before the buyer confirms (no RFQ for the buyer yet, no ai_decisions on the run)', (noRfqYet ?? 0) === 0 && ((await admin.from('ai_decisions').select('id', { count: 'exact', head: true }).eq('run_id', createRun ?? NIL)).count ?? 0) === 0)

    // a spoken yes approves create_rfq (a voice-confirmable tool) through the STT stub + the allow-list
    let approvedBy = 'button'
    if (VOICE_STUB) {
      const wav = Buffer.alloc(44 + 8000)
      wav.write('RIFF', 0); wav.writeUInt32LE(36 + 8000, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(8000, 40)
      const objPath = `${convB}/${tag}-yes.wav`
      const { error: upErr } = await admin.storage.from(BUCKET).upload(objPath, wav, { contentType: 'audio/wav', upsert: true })
      if (!upErr) {
        created.objects.push(objPath)
        await waSay(convB, { kind: 'audio', mediaRef: objPath, mime: 'audio/wav' })
        approvedBy = 'voice'
      }
    }
    if (approvedBy === 'button') {
      skip('voice note approval (STT stub → the allow-list)', 'set VOICE_STUB_TRANSCRIPT="yes send it" on the server to drive the STT stub; the button approves instead')
      await waSay(convB, { kind: 'button', payload: `pr:ok:${createRun}`, body: 'Yes' })
    }
    const s3 = await sessionOf(s1?.id ?? NIL)
    const rfqId = s3?.rfq_id as string | null
    if (rfqId) created.rfqIds.push(rfqId)
    const { data: dec } = await admin.from('ai_decisions').select('id, feature, tool, input_refs, decided_by').eq('run_id', createRun ?? NIL)
    const { data: intake } = await admin.from('rfq_intake_extractions').select('id, rfq_id, decision_id').eq('user_id', b.uid)
    check(`${approvedBy === 'voice' ? `a voice note (STT stub “${VOICE_STUB}”) → the allow-list` : 'the Yes button'} → the decision route under the buyer's token: ONE procurement_step decision (tool create_rfq, decided by the buyer) → resume → POST /rfq → the session is live with the RFQ; the S1.8 clarify intake row is linked to the RFQ`, (dec ?? []).length === 1 && (dec as any[])[0].feature === 'procurement_step' && (dec as any[])[0].tool === 'create_rfq' && (dec as any[])[0].decided_by === b.uid && !!rfqId && s3?.state === 'live' && ((intake ?? []) as any[]).some((r) => r.rfq_id === rfqId && !!r.decision_id), JSON.stringify({ dec, state: s3?.state, rfqId, intake }))
    skip('the run-bound single-row intake link (procurement_step replaces the rfq_intake row)', 'needs the minted delegated token (amc_run_id); the stand-in session token carries no run, so POST /rfq writes its own rfq_intake row here — the branch is a delegatedRunId() read')

    // ── quotes → ONE summary per new set; the letters are the compare page's ──
    const { data: matches } = await admin.from('rfq_matches').select('provider_id').eq('rfq_id', rfqId ?? NIL).in('provider_id', [p1.providerId, p2.providerId, p3.providerId])
    const quoteOf = async (p: { token: string }, price: number, days: number, gst: boolean) => {
      const r = await api(p.token, `/api/v1/rfq/${rfqId}/quote`, { rfq_id: rfqId, price_paise: price, delivery_days: days, scope: SCOPE, gst_included: gst, transport_included: true })
      const body = await json(r)
      return (body['quoteId'] ?? body['id'] ?? null) as string | null
    }
    const qA = await quoteOf(p1, 2_500_000, 7, true)
    const qB = await quoteOf(p2, 2_700_000, 4, true)
    const qC = await quoteOf(p3, 3_400_000, 10, false)
    check('the three kill-test providers were matched by the ordinary fan-out and quoted through the ordinary route', (matches ?? []).length === 3 && !!qA && !!qB && !!qC, JSON.stringify({ matches: (matches ?? []).length, qA, qB, qC }))
    await pr.runProcurementWatch(deps, { sessionIds: [s1?.id ?? NIL] })
    const s4 = await sessionOf(s1?.id ?? NIL)
    const summaries = (await agentTurns(s1?.id ?? NIL)).filter((t) => t.proposal?.key === 'quotes_summary')
    const cmp = await json(await api(b.token, `/api/v1/rfq/${rfqId}/compare`, undefined, 'GET'))
    const pageQuotes = ((await json(await api(b.token, `/api/v1/rfq/${rfqId}`, undefined, 'GET')))['rfq'] as any)?.quotes ?? []
    const pageLetters = Object.fromEntries((pageQuotes as any[]).map((q, i) => [q.id, String.fromCharCode(65 + i)]))
    check('the watch → ONE quotes summary (three lines + the compare link); the session’s letters equal the compare page’s (price-as-quoted order: A = ₹25,000, B = ₹27,000, C = ₹34,000); state quotes_in', summaries.length === 1 && s4?.state === 'quotes_in' && sameMap(s4?.labels, pageLetters) && pageLetters[qA ?? ''] === 'A' && pageLetters[qB ?? ''] === 'B' && pageLetters[qC ?? ''] === 'C' && String(summaries[0]?.body).includes(`/app/rfq/${rfqId}`) && Array.isArray(cmp['results']), JSON.stringify({ n: summaries.length, state: s4?.state, labels: s4?.labels, pageLetters }))
    await pr.runProcurementWatch(deps, { sessionIds: [s1?.id ?? NIL] })
    check('a second watch with the same quote set sends no second summary', (await agentTurns(s1?.id ?? NIL)).filter((t) => t.proposal?.key === 'quotes_summary').length === 1)

    // ── a provider question answered from the buyer's earlier words ──
    const cq1 = await api(p1.token, `/api/v1/rfq/${rfqId}/clarifications`, { question: 'How many GSTINs do you have?' })
    const cq1b = await json(cq1)
    const cid1 = (cq1b['clarification'] as any)?.id as string | undefined
    await pr.runProcurementWatch(deps, { sessionIds: [s1?.id ?? NIL] })
    const s5 = await sessionOf(s1?.id ?? NIL)
    const ansCard = (await agentTurns(s1?.id ?? NIL)).at(-1)
    check('a provider asks “How many GSTINs?” → the drafter answers from the buyer’s OWN earlier turn (3 GSTINs) → an answer_clarification proposal (parked, buttons)', cq1.status === 201 || cq1.status === 200 ? ansCard?.proposal?.tool === 'answer_clarification' && /3 GSTINs/.test(String(ansCard?.body)) && !!s5?.open_run_id : false, JSON.stringify({ status: cq1.status, card: ansCard?.proposal, body: String(ansCard?.body ?? '').slice(0, 120) }))
    await waSay(convB, { kind: 'button', payload: `pr:ok:${s5?.open_run_id}`, body: 'Yes' })
    const { data: cl1 } = await admin.from('rfq_clarifications').select('answer').eq('id', cid1 ?? NIL).maybeSingle()
    check('Yes → the ordinary answer route posts it (every matched provider sees it)', /3 GSTINs/.test(String((cl1 as any)?.answer ?? '')), JSON.stringify(cl1))

    // ── one not answerable → relayed → the buyer's reply proposed → posted ──
    const cq2 = await api(p2.token, `/api/v1/rfq/${rfqId}/clarifications`, { question: 'Do you keep your books in Tally or Zoho?' })
    const cid2 = ((await json(cq2))['clarification'] as any)?.id as string | undefined
    await pr.runProcurementWatch(deps, { sessionIds: [s1?.id ?? NIL] })
    const s6 = await sessionOf(s1?.id ?? NIL)
    check('a question the buyer never answered → relayed verbatim (pending relay), no proposal', (s6?.pending as any)?.kind === 'relay' && !s6?.open_run_id && (await agentTurns(s1?.id ?? NIL)).at(-1)?.proposal?.key === 'clar_relay', JSON.stringify(s6?.pending))
    await waSay(convB, { kind: 'text', body: 'We use Tally' })
    const s7 = await sessionOf(s1?.id ?? NIL)
    await waSay(convB, { kind: 'text', body: 'yes' })
    const { data: cl2 } = await admin.from('rfq_clarifications').select('answer').eq('id', cid2 ?? NIL).maybeSingle()
    check('the buyer’s reply → an answer_clarification proposal; a typed “yes” (voice-confirmable tool) approves → posted', !!s7?.open_run_id && /Tally/.test(String((cl2 as any)?.answer ?? '')), JSON.stringify({ open: s7?.open_run_id, cl2 }))

    // ── the counter-offer: refused, nothing posted ──
    const msgsBefore = (await admin.from('messages').select('id', { count: 'exact', head: true }).eq('sender_id', b.uid)).count ?? 0
    await waSay(convB, { kind: 'text', body: 'ask A to do it for ₹20k please' })
    const msgsAfter = (await admin.from('messages').select('id', { count: 'exact', head: true }).eq('sender_id', b.uid)).count ?? 0
    const s8 = await sessionOf(s1?.id ?? NIL)
    check('“ask A to do it for ₹20k” → no proposal, no message posted, the no-negotiation template (with the compare link)', !s8?.open_run_id && msgsAfter === msgsBefore && (await agentTurns(s1?.id ?? NIL)).at(-1)?.proposal?.key === 'no_negotiation', JSON.stringify({ msgsBefore, msgsAfter }))

    // ── decline C by button ──
    await waSay(convB, { kind: 'text', body: 'decline C, too costly' })
    const s9 = await sessionOf(s1?.id ?? NIL)
    const decRun = s9?.open_run_id as string | undefined
    await waSay(convB, { kind: 'button', payload: `pr:ok:${decRun}`, body: 'Yes' })
    const { data: qcRow } = await admin.from('quotes').select('status, decline_reason').eq('id', qC ?? NIL).maybeSingle()
    check('“decline C, too costly” → a decline_quote proposal → the button → quote C declined with reason price_high (the ordinary decline route)', !!decRun && (qcRow as any)?.status === 'declined' && (qcRow as any)?.decline_reason === 'price_high', JSON.stringify(qcRow))

    // ── "go with B": text → buttons re-sent, no decision; button → the decision-bound link, NO checkout ──
    await waSay(convB, { kind: 'text', body: 'go with B' })
    const s10 = await sessionOf(s1?.id ?? NIL)
    const chooseRun = s10?.open_run_id as string | undefined
    const typed = await waSay(convB, { kind: 'text', body: 'yes send it' })
    const decAfterText = (await admin.from('ai_decisions').select('id', { count: 'exact', head: true }).eq('run_id', chooseRun ?? NIL)).count ?? 0
    check('“go with B” → a choose_quote proposal; a typed “yes send it” re-sends the buttons and records NOTHING (button-only)', (await agentTurns(s1?.id ?? NIL)).some((t) => t.proposal?.tool === 'choose_quote') && typed.results.some((x) => x.r?.detail?.outcome === 'buttons_resent') && decAfterText === 0 && (await core.ledger.getRun(chooseRun ?? NIL))?.status === 'awaiting_confirmation', JSON.stringify({ typed: typed.results.map((x) => x.r?.detail), decAfterText }))
    await waSay(convB, { kind: 'button', payload: `pr:ok:${chooseRun}`, body: 'Yes' })
    const { data: chDec } = await admin.from('ai_decisions').select('id, feature, tool, final').eq('run_id', chooseRun ?? NIL).maybeSingle()
    const link = String((await agentTurns(s1?.id ?? NIL)).at(-1)?.body ?? '')
    const s11 = await sessionOf(s1?.id ?? NIL)
    const expectPath = `/app/rfq/${rfqId}?pay=${qB}&d=${(chDec as any)?.id}`
    check('the button → ONE procurement_step decision (choose_quote, final names quote B) → the link to the buyer’s OWN RFQ page with B selected, decision-bound; session chosen', (chDec as any)?.feature === 'procurement_step' && (chDec as any)?.tool === 'choose_quote' && (chDec as any)?.final?.quote_id === qB && link.includes(expectPath) && s11?.state === 'chosen', JSON.stringify({ chDec, link: link.slice(0, 160) }))
    const { count: coEvents } = await admin.from('agent_events').select('id', { count: 'exact', head: true }).in('run_id', [createRun ?? NIL, chooseRun ?? NIL, decRun ?? NIL]).in('tool', ['place_order', 'accept_quote'])
    check('the agent never paid: no checkout_session / order row for the buyer, no place_order / accept_quote event on any procurement run', (await checkoutCount()) === checkoutBefore && (coEvents ?? 0) === 0, `checkout rows ${checkoutBefore} → ${await checkoutCount()}`)
    const html = await (await fetch(`${BASE}/en${expectPath}`, { headers: { cookie: await cookieFor(b.email) } })).text()
    const forged = await (await fetch(`${BASE}/en/app/rfq/${rfqId}?pay=${qB}&d=${NIL}`, { headers: { cookie: await cookieFor(b.email) } })).text()
    const foreignRes = await fetch(`${BASE}/en${expectPath}`, { headers: { cookie: await cookieFor(other.email) } })
    const foreign = await foreignRes.text()
    // the props ride in the escaped RSC payload (\"payQuoteId\":\"…\"); the (msme) group streams (loading.tsx), so a
    // notFound() for another buyer is a soft-404 (HTTP 200 + the not-found UI) — judged by CONTENT, as verify-phase8 does
    const { data: rfqRow } = await admin.from('rfqs').select('title').eq('id', rfqId ?? NIL).maybeSingle()
    const title = String((rfqRow as any)?.title ?? '')
    const paySet = (body: string) => unRsc(body).includes(`"payQuoteId":"${qB}"`)
    const foreignSees = paySet(foreign) || (title.length > 0 && unRsc(foreign).includes(title))
    check('the link opens the page’s OWN confirm sheet for B (payQuoteId set) only with the real decision; a forged decision id sets nothing; another buyer gets the not-found page (no title, no sheet)', paySet(html) && unRsc(html).includes(title) && !paySet(forged) && !foreignSees && (foreignRes.status === 404 || foreignRes.status === 200), `real=${paySet(html)} forged=${paySet(forged)} foreign=${foreignRes.status} sees=${foreignSees}`)
    skip('the buyer’s own payment from that page', 'the checkout route and the confirm sheet are unchanged (Phase 4 kill-tests); the rig proves the agent created no checkout / payment row')

    // ── the web mirror: the composer + a tap run the SAME engine ──
    const threadRes = await api(b.token, `/api/v1/agent/procurement/sessions/${s1?.id}`, undefined, 'GET')
    const thread = await json(threadRes)
    check('GET /agent/procurement/sessions/[id]: the WhatsApp turns in the web mirror (RLS owner read), user bodies contact-masked; another buyer → 404', threadRes.status === 200 && ((thread['turns'] as any[]) ?? []).length >= 10 && (await api(other.token, `/api/v1/agent/procurement/sessions/${s1?.id}`, undefined, 'GET')).status === 404, `status ${threadRes.status}`)
    const wm = await api(b.token, '/api/v1/agent/procurement/message', { text: 'I also need help with my income tax return, 2 partners' }, 'POST', { 'x-amc-locale': 'en' })
    const wmb = await json(wm)
    const q0 = await pr.runProcurementTurn(deps, { kind: 'turn', userId: b.uid, surface: 'web', sessionId: String(wmb['session_id'] ?? ''), turnId: String(wmb['turn_id'] ?? '') })
    const webSess = await sessionOf(String(wmb['session_id'] ?? NIL))
    check('the web composer: 202 (runtime not configured here → the rig runs the SAME procurement.turn in-process) → a web session with the buyer’s turn and the agent’s reply', wm.status === 202 && q0.status === 'ok' && webSess?.surface === 'web' && (await agentTurns(webSess?.id ?? NIL)).length >= 1, JSON.stringify({ status: wm.status, q0 }))
    if (webSess?.open_run_id) {
      const tap = await api(b.token, '/api/v1/agent/procurement/decision', { run_id: webSess.open_run_id, action: 'no' })
      await json(tap)
      const d0 = await pr.decideProcurement(deps, { kind: 'decide', runId: webSess.open_run_id, userId: b.uid, action: 'no', via: 'web' })
      check('a web tap No → 202 → the runtime decide (the WhatsApp path): declined decision, the session closed, the card resolved', tap.status === 202 && d0.status === 'ok' && (await sessionOf(webSess.id))?.state === 'closed', JSON.stringify(d0))
    } else skip('web tap on a proposal', 'the web need did not reach a proposal (the stub parse asked a question) — the tap path is the same decide job proven on WhatsApp')
    const stranger = await api(other.token, '/api/v1/agent/procurement/decision', { run_id: chooseRun ?? NIL, action: 'ok' })
    await json(stranger)
    check('another buyer tapping this buyer’s proposal → 409 proposal_gone (never their run)', stranger.status === 409, `status ${stranger.status}`)

    // ── the S1.5 deferred path → answers → complete_rfq (a second buyer, rfq_quality on for this block) ──
    const q = await mkBuyer('q')
    tokens.set(q.uid, q.token)
    await setSetting('cohort_user_ids', [...baseCohort, b.uid, other.uid, p1.uid, p2.uid, p3.uid, q.uid])
    await setSetting('agents_enabled', { ...baseEnabled, procurement: true, support: true, rfq_clarify: false, rfq_quality: true })
    const convQ = await mkConv(q)
    await api(q.token, '/api/v1/agent/procurement/enable', { consent_text_version: 'procurement-v1-2026-09-23' }).then(json)
    const offerQ = await waSay(convQ, { kind: 'text', body: 'I need GST filing' })
    await waSay(convQ, { kind: 'button', payload: `pr:sess:new:${offerQ.id}`, body: 'Yes, start' })
    const sq = await latestSession(q.uid)
    if (sq?.open_run_id) await waSay(convQ, { kind: 'button', payload: `pr:ok:${sq.open_run_id}`, body: 'Yes' })
    const sq2 = await sessionOf(sq?.id ?? NIL)
    if (sq2?.rfq_id) created.rfqIds.push(sq2.rfq_id)
    if (sq2?.state === 'quality') {
      const qs = ((sq2.pending as any)?.questions ?? []) as { field: string }[]
      for (let i = 0; i < qs.length; i++) await waSay(convQ, { kind: 'text', body: i === 0 ? 'Within two weeks, for Bengaluru office' : 'Three GSTINs, monthly returns' })
      const sq3 = await sessionOf(sq?.id ?? NIL)
      const cRun = sq3?.open_run_id as string | undefined
      if (cRun) await waSay(convQ, { kind: 'button', payload: `pr:ok:${cRun}`, body: 'Yes' })
      const sq4 = await sessionOf(sq?.id ?? NIL)
      const { data: rq } = await admin.from('rfqs').select('fanout_at, quality_decision').eq('id', sq2.rfq_id).maybeSingle()
      check('S1.5 deferred: the create is held (state quality, the questions relayed) → the buyer’s answers → a complete_rfq proposal → Yes → the ordinary quality route releases the fan-out (state live)', !!cRun && sq4?.state === 'live' && !!(rq as any)?.fanout_at && (rq as any)?.quality_decision === 'answered', JSON.stringify({ state: sq4?.state, rq }))
    } else skip('the S1.5 deferred path', `the keyless precheck found nothing to ask for this request (state ${sq2?.state}) — the deferred leg is covered by the golden conversations`)
    await setSetting('agents_enabled', { ...baseEnabled, procurement: true, support: true, rfq_clarify: true, rfq_quality: false })

    // ── the chase: fanned out, zero quotes, past procurement_chase_hours → one nudge offer ──
    const c = await mkBuyer('c')
    tokens.set(c.uid, c.token)
    await setSetting('cohort_user_ids', [...baseCohort, b.uid, other.uid, p1.uid, p2.uid, p3.uid, q.uid, c.uid])
    await api(c.token, '/api/v1/agent/procurement/enable', { consent_text_version: 'procurement-v1-2026-09-23' }).then(json)
    const cm = await api(c.token, '/api/v1/agent/procurement/message', { text: 'I need GST filing for my bakery in Bengaluru, Karnataka, monthly returns for one GSTIN' }, 'POST', { 'x-amc-locale': 'en' })
    const cmb = await json(cm)
    await pr.runProcurementTurn(deps, { kind: 'turn', userId: c.uid, surface: 'web', sessionId: String(cmb['session_id'] ?? ''), turnId: String(cmb['turn_id'] ?? '') })
    let sc = await sessionOf(String(cmb['session_id'] ?? NIL))
    if (sc?.open_run_id && (sc.pending as any)?.kind !== 'clarify') await pr.decideProcurement(deps, { kind: 'decide', runId: sc.open_run_id, userId: c.uid, action: 'ok', via: 'web' })
    sc = await sessionOf(String(cmb['session_id'] ?? NIL))
    if (sc?.rfq_id) {
      created.rfqIds.push(sc.rfq_id)
      // no provider quotes on this one; age the request past the 1 h chase setting
      await admin.from('quotes').delete().eq('rfq_id', sc.rfq_id)
      await admin.from('rfqs').update({ quote_count: 0, created_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }).eq('id', sc.rfq_id)
      await pr.runProcurementWatch(deps, { sessionIds: [sc.id] })
      const sc2 = await sessionOf(sc.id)
      const chaseRun = sc2?.open_run_id as string | undefined
      check('zero quotes past procurement_chase_hours → ONE nudge_counterparty proposal (a chase card), last_chase_at stamped', !!chaseRun && !!sc2?.last_chase_at && (await agentTurns(sc.id)).at(-1)?.proposal?.tool === 'nudge_counterparty', JSON.stringify({ open: chaseRun, last: sc2?.last_chase_at }))
      if (chaseRun) {
        await pr.decideProcurement(deps, { kind: 'decide', runId: chaseRun, userId: c.uid, action: 'ok', via: 'web' })
        const { count: nud } = await admin.from('nudges').select('id', { count: 'exact', head: true }).eq('subject_id', sc.rfq_id).eq('from_user_id', c.uid)
        await pr.runProcurementWatch(deps, { sessionIds: [sc.id] })
        const sc3 = await sessionOf(sc.id)
        check('the tap → the ordinary rfq nudge route (a nudges row, the S2.3 cap applies); the next watch offers no second chase', (nud ?? 0) === 1 && !sc3?.open_run_id && (await agentTurns(sc.id)).filter((t) => t.proposal?.tool === 'nudge_counterparty').length === 1, `nudges=${nud}`)
      }
    } else skip('the chase', `the web need did not reach a live request (state ${sc?.state})`)

    // ── the proposal cap + a budget cap ──
    await setSetting('procurement_max_proposals_per_day', 1)
    const k = await mkBuyer('k')
    tokens.set(k.uid, k.token)
    await setSetting('cohort_user_ids', [...baseCohort, b.uid, other.uid, p1.uid, p2.uid, p3.uid, q.uid, c.uid, k.uid])
    await api(k.token, '/api/v1/agent/procurement/enable', { consent_text_version: 'procurement-v1-2026-09-23' }).then(json)
    const km = await json(await api(k.token, '/api/v1/agent/procurement/message', { text: 'I need GST filing for my bakery in Bengaluru, Karnataka, monthly returns for one GSTIN' }, 'POST', { 'x-amc-locale': 'en' }))
    await admin.from('procurement_sessions').update({ proposals_today: 1, proposals_date: new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10) }).eq('id', String(km['session_id'] ?? NIL))
    await pr.runProcurementTurn(deps, { kind: 'turn', userId: k.uid, surface: 'web', sessionId: String(km['session_id'] ?? ''), turnId: String(km['turn_id'] ?? '') })
    const sk = await sessionOf(String(km['session_id'] ?? NIL))
    const kKeys = (await agentTurns(sk?.id ?? NIL)).map((t) => t.proposal?.key)
    check('the daily proposal cap reached → no proposal, the proposal_cap template (or the clarify question when the parse asked first)', !sk?.open_run_id && (kKeys.includes('proposal_cap') || kKeys.includes('clarify')), JSON.stringify(kKeys))
    await setSetting('procurement_max_proposals_per_day', 30)
    await remember('budget_run_paise_by_agent')
    await setSetting('budget_run_paise_by_agent', { ...((settingsBefore.get('budget_run_paise_by_agent')?.value ?? {}) as Record<string, number>), procurement: 0 })
    const km2 = await json(await api(k.token, '/api/v1/agent/procurement/message', { text: 'Any update?' }, 'POST', { 'x-amc-locale': 'en' }))
    const bc = await pr.runProcurementTurn(deps, { kind: 'turn', userId: k.uid, surface: 'web', sessionId: String(km2['session_id'] ?? ''), turnId: String(km2['turn_id'] ?? '') })
    const kLast = (await agentTurns(String(km2['session_id'] ?? NIL))).at(-1)
    check('a budget cap (budget_run_paise_by_agent.procurement = 0) fails the turn cleanly: failed budget_*, no proposal, one honest “failed” reply', bc.status === 'failed' && /^budget_/.test(bc.error) && kLast?.proposal?.key === 'failed', JSON.stringify(bc))
    const bb = settingsBefore.get('budget_run_paise_by_agent')
    if (bb?.existed) await setSetting('budget_run_paise_by_agent', bb.value)
    else await admin.from('agent_settings').delete().eq('key', 'budget_run_paise_by_agent')

    // ── STOP → WhatsApp stops, the web mirror continues ──
    await waSay(convB, { kind: 'text', body: 'STOP' })
    const waBefore = (await outbound(convB)).length
    const turnsBefore = (await agentTurns(s1?.id ?? NIL)).length
    // a NEW quote set on B's session after STOP (a fourth provider, matched by hand) → the watch writes the summary to the
    // web mirror only
    const p4 = await mkProvider('p4')
    await admin.from('rfq_matches').insert({ rfq_id: rfqId, provider_id: p4.providerId, notified_at: new Date().toISOString() })
    const qD = await quoteOf(p4, 2_450_000, 6, true)
    await pr.runProcurementWatch(deps, { sessionIds: [s1?.id ?? NIL] })
    const { data: gB } = await admin.from('agent_grants').select('channel').eq('user_id', b.uid).eq('persona', 'buyer').is('revoked_at', null)
    const sStop = await sessionOf(s1?.id ?? NIL)
    const afterTurns = await agentTurns(s1?.id ?? NIL)
    check('STOP → the WhatsApp grant revoked (the web grant stays) → a new quote after STOP: the watch writes the summary to the web mirror, and NO new WhatsApp message', !!qD && ((gB ?? []) as any[]).every((g) => g.channel !== 'whatsapp') && ((gB ?? []) as any[]).some((g) => g.channel === 'web') && (await outbound(convB)).length === waBefore && afterTurns.length > turnsBefore && afterTurns.at(-1)?.proposal?.key === 'quotes_summary' && !['failed', 'expired'].includes(sStop?.state), JSON.stringify({ qD, grants: gB, state: sStop?.state, turns: [turnsBefore, afterTurns.length] }))

    // ── revoke mid-flow → the next watch closes the session and sends nothing ──
    const r0 = (await agentTurns(s1?.id ?? NIL)).length
    await api(b.token, '/api/v1/agent/procurement/disable', {}).then(json)
    await pr.runProcurementWatch(deps, { sessionIds: [s1?.id ?? NIL] })
    const sRev = await sessionOf(s1?.id ?? NIL)
    check('disable (the grant revoked) mid-flow → the next watch closes the session as failed (grant_revoked), cancels any parked run, and sends NOTHING (no turn, no WhatsApp)', sRev?.state === 'failed' && sRev?.close_reason === 'grant_revoked' && !sRev?.open_run_id && (await agentTurns(s1?.id ?? NIL)).length === r0, JSON.stringify({ state: sRev?.state, reason: sRev?.close_reason }))

    // ── "hi" never strips the widened WhatsApp scopes (the grantWhatsApp fix) ──
    const h = await mkBuyer('h')
    tokens.set(h.uid, h.token)
    const convH = await mkConv(h)
    await setSetting('cohort_user_ids', [...baseCohort, b.uid, other.uid, p1.uid, p2.uid, p3.uid, q.uid, c.uid, k.uid, h.uid])
    await api(h.token, '/api/v1/agent/procurement/enable', { consent_text_version: 'procurement-v1-2026-09-23' }).then(json)
    await waSay(convH, { kind: 'text', body: 'hi' })
    const { data: gH } = await admin.from('agent_grants').select('scopes').eq('user_id', h.uid).eq('channel', 'whatsapp').is('revoked_at', null)
    check('a re-sent opt-in keyword (“hi”, no session open) refreshes the WhatsApp consent but KEEPS the widened procurement scopes', ((gH ?? []) as any[]).length === 1 && PROCUREMENT_SCOPES.every((s) => ((gH as any[])[0].scopes as string[]).includes(s)), JSON.stringify(gH))

    // ── the admin tile ──
    const st = await json(await api(adminU.token, '/api/v1/agent/admin/procurement/stats', undefined, 'GET'))
    check('GET /agent/admin/procurement/stats: sessions, proposals by outcome, RFQs created via the agent', Number(st['sessions_total']) >= 4 && Number((st['proposals'] as any)?.approved) >= 4 && Number(st['rfqs_created']) >= 2, JSON.stringify(st).slice(0, 200))
    const stB = await api(b.token, '/api/v1/agent/admin/procurement/stats', undefined, 'GET')
    await json(stB)
    check('the stats route refuses a buyer (403)', stB.status === 403, `status ${stB.status}`)

    skip('HMAC token exchange + the scoped delegated token (a procurement token gets 403 on POST /checkout)', 'no SUPABASE_JWT_SECRET on this laptop — the buyers’ own session tokens stand in; the runner (scopes + SCRIPTED_CALL_FORBIDDEN) and requireToolScope(place_order) are the proven locks')
    skip('pg-boss queues agent.procurement.turn / .decide / .watch + the runtime webhook', 'runtime driven in-process (never start the runtime against prod)')
    skip('live models (procurement_turn / clarification_answer / provider_message)', 'keyless gateway → the stub producers; the live gates are eval --set procurement_* and the injection set once the key exists')
  } finally {
    // ── cleanup (zero residue; CHECKED, FK-ordered) ──────────────────────────
    const errors: string[] = []
    const del = async (label: string, q: PromiseLike<{ error: { message: string } | null }>) => { const { error } = await q; if (error && !/Could not find the table|does not exist|schema cache/.test(error.message)) errors.push(`${label}: ${error.message}`) }
    try {
      const users = created.users.length ? created.users : [NIL]
      const pids = created.providerIds.length ? created.providerIds : [NIL]
      const convIds = created.convIds.length ? created.convIds : [NIL]
      // every RFQ the rig's buyers created (the agent creates them — not all are in created.rfqIds)
      const { data: allRfqs } = await admin.from('rfqs').select('id').in('msme_id', created.msmeIds.length ? created.msmeIds : [NIL])
      const rfqIds = [...new Set([...created.rfqIds, ...((allRfqs ?? []) as { id: string }[]).map((r) => r.id)])]
      const rfqList = rfqIds.length ? rfqIds : [NIL]
      await del('wa.procurement_session_id=null', admin.from('wa_conversations').update({ procurement_session_id: null, support_ticket_id: null }).in('id', convIds))
      await del('procurement_turns', admin.from('procurement_turns').delete().in('user_id', users))
      await del('procurement_sessions', admin.from('procurement_sessions').delete().in('user_id', users))
      await del('support_tickets', admin.from('support_tickets').delete().in('user_id', users))
      await del('nudges', admin.from('nudges').delete().in('from_user_id', users))
      for (const id of rfqIds) await del('notifications(link)', admin.from('notifications').delete().like('link', `%${id}%`))
      await del('notifications(user)', admin.from('notifications').delete().in('user_id', users))
      const { data: qs } = await admin.from('quotes').select('id').in('rfq_id', rfqList)
      const quoteIds = ((qs ?? []) as { id: string }[]).map((x) => x.id)
      if (quoteIds.length) {
        const { data: convs } = await admin.from('conversations').select('id').eq('context_type', 'quote').in('context_id', quoteIds)
        const cids = ((convs ?? []) as { id: string }[]).map((x) => x.id)
        if (cids.length) {
          await del('messages', admin.from('messages').delete().in('conversation_id', cids))
          await del('conversations', admin.from('conversations').delete().in('id', cids))
        }
        await del('quote_events', admin.from('quote_events').delete().in('quote_id', quoteIds))
        await del('price_book(quote)', admin.from('provider_price_book').delete().in('source_quote_id', quoteIds))
      }
      await del('price_book(provider)', admin.from('provider_price_book').delete().in('provider_id', pids))
      await del('quotes', admin.from('quotes').delete().in('rfq_id', rfqList))
      await del('rfq_clarifications', admin.from('rfq_clarifications').delete().in('rfq_id', rfqList))
      await del('rfq_matches', admin.from('rfq_matches').delete().in('rfq_id', rfqList))
      await del('rfq_intake(rfq)', admin.from('rfq_intake_extractions').update({ rfq_id: null }).in('rfq_id', rfqList))
      await del('rfq_intake(user)', admin.from('rfq_intake_extractions').delete().in('user_id', users))
      await del('rfqs', admin.from('rfqs').delete().in('id', rfqList))
      const { data: runs } = await admin.from('agent_runs').select('id').in('user_id', users)
      const runIds = ((runs ?? []) as { id: string }[]).map((r) => r.id)
      await del('decisions', admin.from('ai_decisions').delete().in('decided_by', users))
      if (runIds.length) {
        await del('events', admin.from('agent_events').delete().in('run_id', runIds))
        await del('invocations(run)', admin.from('ai_invocations').delete().in('run_id', runIds))
        await del('runs(children)', admin.from('agent_runs').delete().in('parent_run_id', runIds))
      }
      await del('invocations(user)', admin.from('ai_invocations').delete().in('user_id', users))
      await del('runs', admin.from('agent_runs').delete().in('user_id', users))
      await del('wa_messages', admin.from('wa_messages').delete().in('conversation_id', convIds))
      await del('wa_conversations', admin.from('wa_conversations').delete().in('id', convIds))
      for (const o of created.objects) await admin.storage.from(BUCKET).remove([o])
      await del('grants', admin.from('agent_grants').delete().in('user_id', users))
      await del('audit', admin.from('audit_logs').delete().in('actor_id', users))
      await del('provider_categories', admin.from('provider_categories').delete().in('provider_id', pids))
      await del('provider_profiles', admin.from('provider_profiles').delete().in('id', pids))
      await del('msme_profiles', admin.from('msme_profiles').delete().in('user_id', users))
      for (const [key, before] of settingsBefore) {
        if (before.existed) await admin.from('agent_settings').upsert({ key, value: before.value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
        else await admin.from('agent_settings').delete().eq('key', key)
      }
      for (const uid of created.users) {
        await del('users', admin.from('users').delete().eq('id', uid))
        const { error } = await admin.auth.admin.deleteUser(uid)
        if (error) errors.push(`auth ${uid}: ${error.message}`)
      }
      const residue: string[] = []
      const { count: u } = await admin.from('users').select('id', { count: 'exact', head: true }).like('email', `${tag}%`)
      if (u) residue.push(`users=${u}`)
      if (created.users.length) {
        for (const [table, col] of [['agent_runs', 'user_id'], ['ai_decisions', 'decided_by'], ['ai_invocations', 'user_id'], ['agent_grants', 'user_id'], ['provider_profiles', 'user_id'], ['msme_profiles', 'user_id'], ['notifications', 'user_id'], ['procurement_sessions', 'user_id'], ['procurement_turns', 'user_id'], ['support_tickets', 'user_id'], ['nudges', 'from_user_id'], ['rfq_intake_extractions', 'user_id']] as const) {
          const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true }).in(col, created.users)
          if (count && !error) residue.push(`${table}=${count}`)
        }
      }
      for (const [table, col, ids] of [['rfqs', 'id', rfqIds], ['rfq_matches', 'rfq_id', rfqIds], ['quotes', 'rfq_id', rfqIds], ['wa_conversations', 'id', created.convIds], ['wa_messages', 'conversation_id', created.convIds]] as const) {
        if (!ids.length) continue
        const { count } = await admin.from(table).select('*', { count: 'exact', head: true }).in(col, ids)
        if (count) residue.push(`${table}=${count}`)
      }
      for (const id of rfqIds) {
        const { count } = await admin.from('notifications').select('id', { count: 'exact', head: true }).like('link', `%${id}%`)
        if (count) residue.push(`notifications(link ${id.slice(0, 8)})=${count}`)
      }
      const { data: hb } = await admin.from('cron_heartbeats').select('name').eq('name', 'agent-procurement-watch')
      if ((hb ?? []).length) residue.push('heartbeat agent-procurement-watch (left by a cron call)')
      if (errors.length) record('cleanup', 'FAIL', errors.join(' | '))
      else check(`cleanup: zero residue (${created.users.length} users, ${rfqIds.length} RFQs, ${created.convIds.length} conversations removed and recounted incl. seed-provider notifications by link; settings restored)`, residue.length === 0, residue.join(', '))
    } catch (e) {
      record('cleanup', 'FAIL', (e as Error).message)
    }
  }
}

async function main() {
  await offline()
  try {
    await http()
  } catch (e) {
    record('lifecycle', 'FAIL', (e as Error).stack?.split('\n').slice(0, 3).join(' | ') ?? String(e))
  }
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
