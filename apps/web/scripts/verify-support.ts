/**
 * verify-support.ts — the Support agent (BUILD_PROMPTS S2.3) against a running server on the prod DB.
 *
 *   offline  — the laws that are pure: the reply matrix (resolveSupportReply), copy completeness in every locale,
 *              the numbers rule on every reply key with a fixture payload, supportIntentSchema strict (no reply field).
 *   flag OFF — /app/support, /partner/support, /admin/support and /api/v1/agent/support/* + admin routes 404;
 *              /profile/me.supportEnabled false; WhatsApp (runtime in-process, support not enabled) → the S0.5
 *              holding reply only; the nudge routes work as spine (party check, notification, `nudged` event,
 *              cooldown 429 on the second call, stranger 403, RFQ bulk + provider → buyer).
 *   flag ON  — web: order status naming the latest order (numbers rule against the order GET), how-to, a masked
 *              phone number, nudge confirm → ai_decisions support_nudge, second nudge capped, a forged message id
 *              never reaches the ledger, a dual-role user's quote question wears the provider hat, two unclear turns
 *              → ticket (summary, ops + user notifications), the third message stored with NO model call,
 *              "talk to a person" → immediate ticket, another user's order never resolves (RLS);
 *              WhatsApp (runtime in-process): one ai_invocations row per turn, nudge buttons → decide → the nudge
 *              route under the token, the cap through the resume (429), out-of-window template, escalation via the
 *              runtime-credential route → quiet → admin resolve → answered again, no grant / STOP → holding reply;
 *              admin: acknowledge / assign / resolve + audit, stats (self-serve rate from the returned counts).
 *
 * Needs migration 0041 for everything except the offline laws and the flag-OFF 404s — until it is applied those
 * legs are recorded skips (they run at the gate, after the migration, before the push).
 *
 * Recorded skips (never passes): the HMAC token exchange (the users' OWN session tokens stand in for the delegated
 * one, so the route scope gates are no-ops — requireToolScope on the reads is the S0.1-proven lock), pg-boss and
 * the runtime webhook, a voice note (the S1.6 STT leg), the live model (keyless gateway → the deterministic stub
 * classifier). The runtime-credential ticket route runs when AGENT_RUNTIME_SECRET is set to the SAME throwaway
 * value on this rig and the local server (never a real secret); otherwise the runtime fallback ticket is checked.
 *
 * Every row it creates is tagged and deleted in FK order; the last row is the zero-residue recount.
 *
 * Run: BASE_URL=http://localhost:3100 [AGENT_RUNTIME_SECRET=<same as the server>] pnpm --filter @amclub/web agents:verify:support
 */
import path from 'node:path'
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
  runSupportTurn,
  type RedisLike,
  type RunAgentDeps,
} from '@amclub/agent-core'
import {
  ORDER_STATUS_LABELS,
  SUPPORT_COPY,
  SUPPORT_LOCALES,
  SUPPORT_REPLY_KEYS,
  numbersAccountedFor,
  renderSupportReply,
  resolveSupportReply,
  supportIntentSchema,
  type SupportLookupResult,
  type SupportOrderView,
  type SupportReplyKey,
  type SupportRfqView,
} from '@amclub/shared'
import { GRIEVANCE_SLA, SUPPORT_CONTACT } from '../lib/legal/grievance'

config({ path: path.resolve(__dirname, '../.env.local') })

const BASE = (process.env['BASE_URL'] || '').replace(/\/$/, '')
const SUPA_URL = process.env['NEXT_PUBLIC_SUPABASE_URL'] || ''
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] || ''
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY'] || ''
const RIG_RUNTIME_SECRET = process.env['AGENT_RUNTIME_SECRET'] || ''
const BUCKET = process.env['WA_MEDIA_BUCKET'] || 'wa-media'

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
const SLA = { acknowledge_hours: GRIEVANCE_SLA.acknowledgeHours, resolve_days: GRIEVANCE_SLA.resolveDays }
const CONTACT = `${SUPPORT_CONTACT.email} / ${SUPPORT_CONTACT.whatsapp}`
const SCOPE = 'Monthly GST return filing for one GSTIN, including reconciliation of purchase invoices and a monthly summary.'
const NIL = '00000000-0000-0000-0000-000000000000'

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── offline ──────────────────────────────────────────────────────────────────

const fxOrder = (status: string, extra: Partial<SupportOrderView> = {}): SupportOrderView => ({ id: 'o1', order_number: 'AMC-2026-000147', title: 'GST filing', status, amount: '₹11,800', earning: '₹9,500', eta_date: '14 Oct 2026', updated_at: '2026-09-22T00:00:00Z', payout: null, refund: null, ...extra })
const fxRfq = (status: string, extra: Partial<SupportRfqView> = {}): SupportRfqView => ({ id: 'r1', title: 'Annual audit', status, quote_count: 3, max_quotes: 7, expires_at: '25 Sep 2026', my_quote: { status: 'submitted', price: '₹42,000' }, ...extra })
const base = (role: 'buyer' | 'provider'): SupportLookupResult => ({ role, sla: SLA, support_contact: CONTACT, ticket_ref: 'T-7F3A21', nudge_cooldown_hours: 24 })

function offline() {
  // the reply matrix — a representative slice (the full ≥ 40-row table is packages/shared support.test.ts)
  const table: Array<[string, Parameters<typeof resolveSupportReply>[0], SupportLookupResult, SupportReplyKey, boolean]> = [
    ['order in_progress → in_progress + nudge offered', 'order_status', { ...base('buyer'), order: fxOrder('in_progress'), nudge_subject: { kind: 'order', id: 'o1', active: true, capped: false } }, 'order_status.in_progress', true],
    ['order completed → completed, no nudge', 'order_status', { ...base('buyer'), order: fxOrder('completed'), nudge_subject: { kind: 'order', id: 'o1', active: false, capped: false } }, 'order_status.completed', false],
    ['order capped → no action', 'order_status', { ...base('buyer'), order: fxOrder('accepted'), nudge_subject: { kind: 'order', id: 'o1', active: true, capped: true } }, 'order_status.accepted', false],
    ['unknown order → not_found', 'order_status', { ...base('buyer'), order: null, orders_count: 2 }, 'order_status.not_found', false],
    ['payout while disputed → held_dispute', 'payout_status', { ...base('provider'), order: fxOrder('disputed') }, 'payout_status.held_dispute', false],
    ['payout processing', 'payout_status', { ...base('provider'), order: fxOrder('completed', { payout: { status: 'processing', scheduled_for: '30 Sep 2026', amount: '₹9,500' } }) }, 'payout_status.processing', false],
    ['refunded order → payment refunded', 'payment_status', { ...base('buyer'), order: fxOrder('refunded') }, 'payment_status.refunded', false],
    ['rfq open, no quotes → nudge offered', 'rfq_status', { ...base('buyer'), rfq: fxRfq('open', { quote_count: 0, my_quote: null }), nudge_subject: { kind: 'rfq', id: 'r1', active: true, capped: false } }, 'rfq_status.open_no_quotes', true],
    ['my quote accepted', 'quote_status', { ...base('provider'), rfq: fxRfq('accepted', { my_quote: { status: 'accepted', price: '₹42,000' } }) }, 'quote_status.accepted', false],
    ['nudge capped', 'nudge_request', { ...base('buyer'), nudge_subject: { kind: 'order', id: 'o1', active: true, capped: true } }, 'nudge.capped', false],
    ['how-to refund', 'how_to', { ...base('buyer'), how_to_topic: 'refund' }, 'how_to.refund', false],
    ['complaint → escalated', 'complaint', base('buyer'), 'escalated', false],
    ['other → unclear', 'other', base('buyer'), 'unclear', false],
  ]
  const bad = table.filter(([, intent, lookup, key, action]) => { const r = resolveSupportReply(intent, lookup); return r.key !== key || !!r.action !== action })
  check(`resolveSupportReply: ${table.length} representative rows (order / payout / payment / rfq / quote / nudge / how-to / escalation / unclear)`, bad.length === 0, bad.map((b) => b[0]).join('; '))

  // copy completeness: every key × locale renders with no unrendered placeholder
  const slots = { order_number: 'AMC-2026-000147', title: 'GST filing', status: 'in_progress', status_label: 'In progress', amount: '₹11,800', eta_date: '14 Oct 2026', expires_date: '25 Sep 2026', quote_count: 3, max_quotes: 7, price: '₹42,000', hours: 24, sla_hours: SLA.acknowledge_hours, sla_days: SLA.resolve_days, contact: CONTACT, ticket_ref: 'T-7F3A21', scheduled_for: '30 Sep 2026' }
  const holes: string[] = []
  for (const l of SUPPORT_LOCALES) for (const k of SUPPORT_REPLY_KEYS) {
    const tpl = SUPPORT_COPY[l][k]
    if (!tpl) { holes.push(`${l}:${k} missing`); continue }
    if (/\{[a-z_]+\}/.test(renderSupportReply(k, slots, l))) holes.push(`${l}:${k} unrendered`)
  }
  check(`copy completeness: ${SUPPORT_REPLY_KEYS.length} keys × ${SUPPORT_LOCALES.length} locales render with no unrendered slot`, holes.length === 0, holes.slice(0, 6).join(', '))

  // the numbers rule on every key: every digit run is in the fixture payload or the copy / SLA / contact / ticket ref
  const payload = JSON.stringify({ order: fxOrder('in_progress', { payout: { status: 'scheduled', scheduled_for: '30 Sep 2026', amount: '₹9,500' } }), rfq: fxRfq('open') })
  const leaks: string[] = []
  for (const l of SUPPORT_LOCALES) for (const k of SUPPORT_REPLY_KEYS) {
    const text = renderSupportReply(k, { ...slots, amount: '₹11,800', price: '₹42,000' }, l)
    const r = numbersAccountedFor(text, [SUPPORT_COPY[l][k] ?? '', payload, JSON.stringify(SLA), CONTACT, 'T-7F3A21', '24'])
    if (!r.ok) leaks.push(`${l}:${k}:${r.missing.join('/')}`)
  }
  check(`numbers rule: every rendered key × locale carries only digits present in the payload / copy / SLA / contact (${SUPPORT_REPLY_KEYS.length * SUPPORT_LOCALES.length} renders)`, leaks.length === 0, leaks.slice(0, 6).join(', '))
  const planted = numbersAccountedFor('Your order AMC-2026-000147 ships on 3 Nov for ₹99,999', [payload])
  check('numbers rule catches a planted figure absent from the payload (₹99,999 / 3 Nov)', !planted.ok && planted.missing.includes('999'), planted.missing.join(','))

  const good = { intent: 'order_status', as_role: null, order_ref: 'latest', rfq_ref: null, how_to_topic: null, escalate: false, escalate_reason: null, ops_summary: null, language: 'en' }
  // the nudge toasts quote the configured cooldown (the 429 carries cooldown_hours) — never a fixed number
  const toastBad: string[] = []
  for (const l of SUPPORT_LOCALES) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const m = require(`../messages/${l}.json`) as Record<string, Record<string, string>>
    for (const ns of ['orders', 'support']) {
      const capped = m[ns]?.['nudge_capped'] ?? ''
      const recent = m[ns]?.['nudge_capped_recent'] ?? ''
      if (!capped.includes('{hours}') || /\d/.test(capped.replace('{hours}', '')) || !recent || /\d/.test(recent)) toastBad.push(`${l}.${ns}`)
    }
  }
  check('nudge toasts in every locale quote {hours} from the route (no fixed number); the rate-limit fallback states none', toastBad.length === 0, toastBad.join(', '))
  check('supportIntentSchema accepts the classifier shape', supportIntentSchema.safeParse(good).success)
  check('supportIntentSchema is strict: a `reply` field (model-written text) is rejected', !supportIntentSchema.safeParse({ ...good, reply: 'Your order is on its way!' }).success)
}

// ── http ─────────────────────────────────────────────────────────────────────

async function http() {
  if (!BASE || !SUPA_URL || !ANON || !SERVICE) {
    skip('HTTP checks', 'set BASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
    return
  }
  const admin: SupabaseClient = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } })
  const tag = `kt_sup_${Date.now().toString(36)}`
  const TAG = tag.toUpperCase()
  const created = { users: [] as string[], providerIds: [] as string[], msmeIds: [] as string[], orderIds: [] as string[], rfqIds: [] as string[], convIds: [] as string[] }
  const settingsBefore = new Map<string, { existed: boolean; value: unknown }>()
  async function remember(key: string) {
    const { data } = await admin.from('agent_settings').select('value').eq('key', key).maybeSingle()
    settingsBefore.set(key, { existed: !!data, value: data?.value ?? null })
  }
  async function setSetting(key: string, value: unknown) {
    await admin.from('agent_settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  }
  let phoneSeq = 0
  async function mkUser(label: string, roles: string[]) {
    const email = `${tag}_${label}@killtest.amclub`
    const digits = `9${String(Date.now()).slice(-6)}${String(++phoneSeq).padStart(3, '0')}`
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

  console.log(`\nverify-support → ${BASE}\n`)
  const probe = await fetch(`${BASE}/api/v1/agent/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  const probeBody = await json(probe)
  // 503 agent_not_configured = flag ON without SUPABASE_JWT_SECRET (this laptop); any other 5xx = a broken server
  if (probe.status >= 500 && !(probe.status === 503 && probeBody['error'] === 'agent_not_configured')) {
    record('server probe', 'FAIL', `POST /api/v1/agent/token → ${probe.status}: the server is broken (env?), not dark — refusing to guess the flag`)
    return
  }
  const flagOn = probe.status !== 404
  const t41 = await admin.from('support_tickets').select('id').limit(1)
  const has0041 = !missingRelation(t41.error)
  const NEEDS_0041 = '0041 not applied on this DB yet — runs at the gate (after the migration, before the push)'

  try {
    const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
    const categoryId = cat!.id as string
    async function mkBuyer(label: string, extraRoles: string[] = []) {
      const u = await mkUser(label, ['msme', ...extraRoles])
      const { data: m, error } = await admin.from('msme_profiles').insert({ user_id: u.uid, business_name: `${label} Co`, state: 'KA', sector: 'services' }).select('id').single()
      if (error) throw new Error(`msme ${label}: ${error.message}`)
      created.msmeIds.push(m!.id)
      return { ...u, msmeId: m!.id as string }
    }
    async function addProvider(u: { uid: string }, label: string) {
      const { data: p, error } = await admin.from('provider_profiles').insert({ user_id: u.uid, legal_name: `${label} Pvt`, display_name: label, slug: `${tag}-${label}`, state: 'KA', city: 'X', languages: ['en'], status: 'active', gstin: `29AAAAA0000A1Z${label.length % 10}` }).select('id').single()
      if (error) throw new Error(`provider ${label}: ${error.message}`)
      created.providerIds.push(p!.id)
      await admin.from('provider_categories').insert({ provider_id: p!.id, category_id: categoryId })
      return p!.id as string
    }
    async function mkProvider(label: string) {
      // real roles (audit B3): every account starts as msme and provider signup appends provider
      const u = await mkUser(label, ['msme', 'provider'])
      return { ...u, providerId: await addProvider(u, label) }
    }
    let orderSeq = 0
    async function mkOrder(msmeId: string, providerId: string, status = 'in_progress') {
      const n = ++orderSeq
      const { data, error } = await admin
        .from('orders')
        .insert({ order_number: `${TAG}-${n}`, msme_id: msmeId, provider_id: providerId, source: 'package', title: `Support kill-test ${n}`, scope_snapshot: { items: ['kill-test'] }, price_paise: 1000000, discount_paise: 0, gst_paise: 180000, total_paise: 1180000, commission_bps: 500, commission_paise: 50000, provider_earning_paise: 950000, delivery_days: 5, status, due_at: new Date(Date.now() + 9 * 86400 * 1000).toISOString() })
        .select('id, order_number')
        .single()
      if (error || !data) throw new Error(`order ${n}: ${error?.message}`)
      created.orderIds.push(data.id)
      return { id: data.id as string, number: data.order_number as string }
    }
    async function mkRfq(token: string, title: string): Promise<string> {
      const r = await api(token, '/api/v1/rfq', { category_slug: 'tax-accounting', title, details: { additional_details: 'One GSTIN in Bengaluru, about 40 purchase invoices a month.' } })
      const d = await json(r)
      if (r.status !== 200 || !d['rfqId']) throw new Error(`rfq create ${r.status} ${JSON.stringify(d).slice(0, 120)}`)
      created.rfqIds.push(d['rfqId'] as string)
      return d['rfqId'] as string
    }

    const b1 = await mkBuyer('b1')
    const p1 = await mkProvider('p1')
    const stranger = await mkBuyer('x')
    const adminU = await mkUser('admin', ['admin'])

    // ── flag-independent: the pages and the agent API are dark unless the server is on ──
    if (!flagOn) {
      for (const [who, p] of [[b1, '/app/support'], [p1, '/partner/support'], [adminU, '/admin/support']] as const) {
        const page = await fetch(`${BASE}${p}`, { headers: { cookie: await cookieFor(who.email) } })
        check(`flag OFF: ${p} → 404`, page.status === 404, `status ${page.status}`)
      }
      for (const [p, m, body, who] of [['/api/v1/agent/support/message', 'POST', { text: 'where is my order' }, b1], ['/api/v1/agent/support/thread', 'GET', undefined, b1], ['/api/v1/agent/admin/support/tickets', 'GET', undefined, adminU], ['/api/v1/agent/admin/support/stats', 'GET', undefined, adminU], ['/api/v1/agent/admin/support/tickets', 'POST', { user_id: b1.uid }, adminU]] as const) {
        const r = await api(who.token, p, body, m)
        await json(r)
        check(`flag OFF: ${m} ${p} → 404`, r.status === 404, `status ${r.status}`)
      }
      const me = await json(await api(b1.token, '/api/v1/profile/me', undefined, 'GET'))
      check('flag OFF: /profile/me.supportEnabled === false', me['supportEnabled'] === false, JSON.stringify(me['supportEnabled']))
    }

    // ── the nudge spine (no flag; both server modes) ──────────────────────────
    if (!has0041) skip('nudge spine (order + RFQ): party check, notification, nudged event, cooldown 429, stranger 403', NEEDS_0041)
    else {
      const sb = await mkBuyer('sb')
      const sp = await mkProvider('sp')
      const so = await mkOrder(sb.msmeId, sp.providerId)
      const n1 = await api(sb.token, `/api/v1/orders/${so.id}/nudge`, { via: 'web' })
      const n1b = await json(n1)
      const { data: ev } = await admin.from('order_events').select('event').eq('order_id', so.id).eq('event', 'nudged')
      const { data: nt } = await admin.from('notifications').select('kind, link').eq('user_id', sp.uid).eq('kind', 'order_nudge')
      const { data: nr } = await admin.from('nudges').select('id, from_user_id, to_user_id, decision_id').eq('subject_id', so.id)
      check('POST /orders/[id]/nudge (buyer) → 200: one nudges row (to the provider, no decision), order_nudge notification to the provider, a `nudged` order event', n1.status === 200 && n1b['recipients'] === 1 && (nr ?? []).length === 1 && (nr as any[])[0].to_user_id === sp.uid && (nr as any[])[0].decision_id === null && (nt ?? []).length === 1 && (ev ?? []).length === 1, `status ${n1.status} ${JSON.stringify(n1b)}`)
      const n2 = await api(sb.token, `/api/v1/orders/${so.id}/nudge`, { via: 'web' })
      const n2b = await json(n2)
      const { data: coolRow } = await admin.from('agent_settings').select('value').eq('key', 'support_nudge_cooldown_hours').maybeSingle()
      const coolNow = typeof coolRow?.value === 'number' ? coolRow.value : 24
      check(`a second nudge inside the cooldown → 429 nudge_cooldown with retry_after + Retry-After + cooldown_hours = the setting (${coolNow})`, n2.status === 429 && n2b['error'] === 'nudge_cooldown' && Number(n2b['retry_after']) > 0 && !!n2.headers.get('retry-after') && n2b['cooldown_hours'] === coolNow, `status ${n2.status} ${JSON.stringify(n2b)}`)
      const n3 = await api(sp.token, `/api/v1/orders/${so.id}/nudge`, { via: 'web' })
      await json(n3)
      check('the other party has its own cooldown: the provider nudges the buyer → 200', n3.status === 200, `status ${n3.status}`)
      const n4 = await api(stranger.token, `/api/v1/orders/${so.id}/nudge`, { via: 'web' })
      await json(n4)
      check('a stranger → 403 not_a_party', n4.status === 403, `status ${n4.status}`)
      const done = await mkOrder(sb.msmeId, sp.providerId, 'completed')
      const n5 = await api(sb.token, `/api/v1/orders/${done.id}/nudge`, { via: 'web' })
      await json(n5)
      check('a terminal order (completed) → 409 subject_inactive', n5.status === 409, `status ${n5.status}`)
      const fake = await api(sb.token, `/api/v1/orders/${so.id}/nudge`, { via: 'web', text: 'hurry up' })
      await json(fake)
      check('no free text in a nudge: an extra body field → 422', fake.status === 422, `status ${fake.status}`)
      const rq = await mkRfq(sb.token, `${tag} spine`)
      const r1 = await api(sb.token, `/api/v1/rfq/${rq}/nudge`, { via: 'web' })
      const r1b = await json(r1)
      const { count: matched } = await admin.from('rfq_matches').select('provider_id', { count: 'exact', head: true }).eq('rfq_id', rq).is('declined_at', null)
      check('POST /rfq/[id]/nudge (buyer) → 200, bulk to every matched non-declined provider (recipients = matches)', r1.status === 200 && Number(r1b['recipients']) === (matched ?? -1) && (matched ?? 0) >= 1, `status ${r1.status} ${JSON.stringify(r1b)} matched=${matched}`)
      const r2 = await api(sp.token, `/api/v1/rfq/${rq}/nudge`, { via: 'web' })
      await json(r2)
      const { data: bn } = await admin.from('notifications').select('kind').eq('user_id', sb.uid).eq('kind', 'rfq_nudge')
      check('a matched provider nudges the buyer → 200, rfq_nudge to the buyer', r2.status === 200 && (bn ?? []).length === 1, `status ${r2.status}`)
      const r3 = await api(stranger.token, `/api/v1/rfq/${rq}/nudge`, { via: 'web' })
      await json(r3)
      check('an unmatched stranger on the RFQ → 403', r3.status === 403, `status ${r3.status}`)
    }

    if (!flagOn) {
      // WhatsApp: support not enabled → the ADR-030 HELP menu only (runtime in-process, AGENT_ENABLED on in THIS process)
      if (!has0041) skip('flag OFF WhatsApp: granted user text → the HELP menu only', NEEDS_0041)
      else {
        await remember('agents_enabled')
        const en = (settingsBefore.get('agents_enabled')?.value ?? {}) as Record<string, boolean>
        if (en['support']) skip('flag OFF WhatsApp HELP menu', 'agents_enabled.support is already true on this DB — not a dark baseline')
        else {
          process.env['AGENT_ENABLED'] = 'true'
          process.env['WHATSAPP_DRIVER'] = 'stub'
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const inbound = require('../../agent-runtime/src/whatsapp/inbound') as typeof import('../../agent-runtime/src/whatsapp/inbound')
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const outboundMod = require('../../agent-runtime/src/whatsapp/outbound') as typeof import('../../agent-runtime/src/whatsapp/outbound')
          const { data: c } = await admin.from('wa_conversations').insert({ phone_e164: `91${b1.digits}`, user_id: b1.uid, locale: 'en', last_inbound_at: new Date().toISOString(), window_open_until: new Date(Date.now() + 86400 * 1000).toISOString() }).select('id').single()
          created.convIds.push(c!.id)
          await admin.from('agent_grants').insert({ user_id: b1.uid, persona: 'buyer', scopes: [], channel: 'whatsapp', channel_identity: `+91${b1.digits}`, consent: { locale: 'en', surface: 'whatsapp', keyword: 'START', text_version: 'v1', at: new Date().toISOString() } })
          const { data: m } = await admin.from('wa_messages').insert({ conversation_id: c!.id, direction: 'in', vendor_message_id: `${tag}-off-1`, kind: 'text', body: 'where is my order', status: 'received', payload: { type: 'text', text: { body: 'where is my order' } } }).select('id').single()
          let enq = 0
          const sysKinds: string[] = []
          await inbound.handleWaInbound(m!.id, { enqueueSupportReply: async () => { enq++; return 'x' }, enqueueSupportDecide: async () => { enq++; return 'x' } }, { send: async (conv, kind, locale, opts) => { sysKinds.push(kind); return outboundMod.sendSystem(conv, kind, locale, opts) } })
          check('flag OFF WhatsApp: a granted user\'s text (support not enabled) → exactly ONE system reply, the HELP menu (ADR-030, no model); nothing enqueued for support', enq === 0 && sysKinds.length === 1 && sysKinds[0] === 'wa_menu', JSON.stringify(sysKinds))
        }
      }
      skip('flag ON legs', 'server is dark')
      return
    }

    // ── flag ON ──────────────────────────────────────────────────────────────
    if (!has0041) {
      skip('flag ON: web chat, WhatsApp, admin queue', NEEDS_0041)
      return
    }
    for (const k of ['agents_enabled', 'cohort_user_ids', 'ops_user_id', 'support_escalate_after_turns', 'support_nudge_cooldown_hours']) if (!settingsBefore.has(k)) await remember(k)
    const b2 = await mkBuyer('b2')
    const b3 = await mkBuyer('b3')
    const b4 = await mkBuyer('b4')
    const dual = await mkBuyer('dual', ['provider'])
    const dualProviderId = await addProvider(dual, 'dualp')
    const w = await mkBuyer('w')
    const n = await mkBuyer('n')
    const enabledBefore = (settingsBefore.get('agents_enabled')?.value ?? {}) as Record<string, boolean>
    const cohortBefore = (settingsBefore.get('cohort_user_ids')?.value ?? []) as string[]
    await setSetting('agents_enabled', { ...enabledBefore, support: true })
    await setSetting('cohort_user_ids', [...new Set([...cohortBefore, b1.uid, b2.uid, b3.uid, dual.uid, p1.uid, w.uid, n.uid])])
    await setSetting('ops_user_id', adminU.uid)
    await setSetting('support_escalate_after_turns', 2)
    await setSetting('support_nudge_cooldown_hours', 12) // not the default: every quoted cap must be the setting, never a constant 24
    const o1 = await mkOrder(b1.msmeId, p1.providerId)
    const o2 = await mkOrder(b2.msmeId, p1.providerId)

    const say = async (who: { token: string }, text: string, headers: Record<string, string> = {}) => {
      const r = await api(who.token, '/api/v1/agent/support/message', { text, locale: 'en' }, 'POST', headers)
      return { status: r.status, body: (await json(r)) as any }
    }
    const invocations = async (uid: string) => (await admin.from('ai_invocations').select('id', { count: 'exact', head: true }).eq('user_id', uid)).count ?? 0
    const threadOf = async (uid: string) => (await admin.from('support_threads').select('id, open_ticket_id, unclear_streak, last_intents').eq('user_id', uid).maybeSingle()).data as any
    const messagesOf = async (threadId: string) => ((await admin.from('support_messages').select('id, role, body, redacted, reply_key').eq('thread_id', threadId).order('created_at', { ascending: true })).data ?? []) as any[]

    // gating
    const meOn = await json(await api(b1.token, '/api/v1/profile/me', undefined, 'GET'))
    check('/profile/me.supportEnabled === true for a cohorted buyer', meOn['supportEnabled'] === true)
    const xs = await say(stranger, 'where is my order')
    check('a user outside the cohort → POST /agent/support/message 404', xs.status === 404, `status ${xs.status}`)
    const pageB = await fetch(`${BASE}/app/support`, { headers: { cookie: await cookieFor(b1.email) } })
    const pageP = await fetch(`${BASE}/partner/support`, { headers: { cookie: await cookieFor(p1.email) } })
    const pageX = await fetch(`${BASE}/app/support`, { headers: { cookie: await cookieFor(stranger.email) } })
    check('/app/support 200 (cohorted buyer), /partner/support 200 (cohorted provider), /app/support 404 (outside the cohort)', pageB.status === 200 && pageP.status === 200 && pageX.status === 404, `${pageB.status}/${pageP.status}/${pageX.status}`)

    // order status — the latest order, its number and label, every number from the order GET
    const s1 = await say(b1, 'where is my order')
    const orderGet = await json(await api(b1.token, `/api/v1/orders/${o1.id}`, undefined, 'GET'))
    const label = ORDER_STATUS_LABELS.en['in_progress'] ?? 'in_progress'
    const nr1 = s1.body?.reply ? numbersAccountedFor(String(s1.body.reply.text), [SUPPORT_COPY.en[s1.body.reply.key as SupportReplyKey] ?? '', JSON.stringify(orderGet), JSON.stringify(SLA), CONTACT]) : { ok: false, missing: ['no reply'] }
    check(`"where is my order" → order_status.in_progress naming ${o1.number} and the label "${label}"; every digit in the reply is in the order GET payload / copy / SLA / contact`, s1.status === 200 && s1.body.reply?.key === 'order_status.in_progress' && String(s1.body.reply.text).includes(o1.number) && String(s1.body.reply.text).toLowerCase().includes(label.toLowerCase()) && nr1.ok, `${s1.status} ${JSON.stringify(s1.body.reply)} missing=${nr1.missing.join(',')}`)
    check('an active order offers the nudge action (tool nudge_counterparty, subject = the order, support_message_id)', s1.body.action?.tool === 'nudge_counterparty' && s1.body.action?.subject?.id === o1.id && typeof s1.body.action?.support_message_id === 'string', JSON.stringify(s1.body.action))
    const inv1 = await admin.from('ai_invocations').select('task_class, tier, run_id').eq('user_id', b1.uid).order('created_at', { ascending: false }).limit(1).maybeSingle()
    check('one bounded ai_invocations row for the turn (support_intent, routine, run_id null on Vercel)', (inv1.data as any)?.task_class === 'support_intent' && (inv1.data as any)?.tier === 'routine' && (inv1.data as any)?.run_id === null, JSON.stringify(inv1.data))

    const s2 = await say(b1, 'how do I get a refund')
    check('"how do I get a refund" → how_to.refund (a template; no order lookup needed)', s2.body.reply?.key === 'how_to.refund', JSON.stringify(s2.body.reply))

    const s3 = await say(b1, 'my order please — call me on 98765 43210')
    const th1 = await threadOf(b1.uid)
    const msgs1 = await messagesOf(th1.id)
    const stored = msgs1.find((m) => m.role === 'user' && /call me/.test(m.body))
    check('a message with a phone number is stored masked (redacted=true, digits gone); the reply never echoes it', !!stored && stored.redacted === true && !stored.body.includes('98765') && !String(s3.body.reply?.text ?? '').includes('98765'), JSON.stringify(stored))
    const thr = await json(await api(b1.token, '/api/v1/agent/support/thread', undefined, 'GET'))
    check('GET /agent/support/thread → the user\'s messages (masked), same thread id', thr['thread_id'] === th1.id && Array.isArray(thr['messages']) && !JSON.stringify(thr['messages']).includes('98765'), `${(thr['messages'] as any[] | undefined)?.length}`)

    // nudge: suggestion → the user's confirm click → the spine route → ai_decisions support_nudge
    const s4 = await say(b1, 'please remind the provider')
    const act = s4.body.action
    check('"please remind the provider" → nudge.confirm + action on the latest order', s4.body.reply?.key === 'nudge.confirm' && act?.subject?.id === o1.id, JSON.stringify(s4.body.reply?.key))
    const click = await api(b1.token, `/api/v1/orders/${o1.id}/nudge`, { support_message_id: act?.support_message_id, via: 'web' })
    await json(click)
    const { data: dec } = await admin.from('ai_decisions').select('id, feature, tool, run_id, input_refs').eq('decided_by', b1.uid).eq('feature', 'support_nudge')
    const { data: nud } = await admin.from('nudges').select('decision_id').eq('subject_id', o1.id).eq('from_user_id', b1.uid)
    check('the confirm click → nudge route 200 → ONE ai_decisions (support_nudge, tool nudge_counterparty, run_id null, input_refs.support_message_id) linked from the nudges row', click.status === 200 && (dec ?? []).length === 1 && (dec as any[])[0].tool === 'nudge_counterparty' && (dec as any[])[0].run_id === null && (dec as any[])[0].input_refs?.support_message_id === act?.support_message_id && (nud as any[])?.[0]?.decision_id === (dec as any[])[0].id, JSON.stringify({ status: click.status, dec }))
    const s5 = await say(b1, 'remind them again please')
    const again = await api(b1.token, `/api/v1/orders/${o1.id}/nudge`, { support_message_id: act?.support_message_id, via: 'web' })
    const againB = await json(again)
    check('a second ask within the cooldown (set to 12 h) → nudge.capped quoting 12, never 24, no action; a direct second click → 429 with cooldown_hours 12 (what the toast renders)', s5.body.reply?.key === 'nudge.capped' && !s5.body.action && String(s5.body.reply?.text).includes('12') && !/\b24\b/.test(String(s5.body.reply?.text)) && again.status === 429 && againB['cooldown_hours'] === 12, `${s5.body.reply?.key} / ${again.status}`)
    // a forged support_message_id (the user's OWN user-role message, then someone else's assistant message) never reaches the ledger
    const pAsk = await api(p1.token, `/api/v1/orders/${o1.id}/nudge`, { support_message_id: act?.support_message_id, via: 'web' })
    await json(pAsk)
    const { count: pDec } = await admin.from('ai_decisions').select('id', { count: 'exact', head: true }).eq('decided_by', p1.uid)
    check('the provider nudging with the BUYER\'s assistant message id → the nudge goes (200) but NO ai_decisions row (not their thread)', pAsk.status === 200 && (pDec ?? 0) === 0, `status ${pAsk.status} decisions=${pDec}`)

    // RLS: another user's order never resolves through the lookups
    const otherRead = await createClient(SUPA_URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${b1.token}` } } }).from('orders').select('id').eq('id', o2.id)
    const otherGet = await api(b1.token, `/api/v1/orders/${o2.id}`, undefined, 'GET')
    await json(otherGet)
    check('RLS: B1\'s session client reads 0 rows for B2\'s order; GET /orders/[B2 order] as B1 → 403/404', (otherRead.data ?? []).length === 0 && [403, 404].includes(otherGet.status), `rows=${(otherRead.data ?? []).length} get=${otherGet.status}`)
    const s6 = await say(b1, `what is the status of order ${o2.number}`)
    check(`a message naming another user's order number (${o2.number}) never answers about it (the classifier only picks from the user's own list; the reply does not contain it)`, s6.status === 200 && !String(s6.body.reply?.text ?? '').includes(o2.number), JSON.stringify(s6.body.reply))

    // dual role — a quote question wears the provider hat
    const rq = await mkRfq(b4.token, `${tag} dual`)
    const { data: dm } = await admin.from('rfq_matches').select('provider_id').eq('rfq_id', rq).eq('provider_id', dualProviderId).maybeSingle()
    const dq = await api(dual.token, `/api/v1/rfq/${rq}/quote`, { price_paise: 420000, delivery_days: 6, scope: SCOPE })
    await json(dq)
    const s7 = await say(dual, 'has the buyer accepted my quote')
    check('a dual-role user asking about "my quote" → as_role provider: quote_status.submitted on the matched RFQ (the buyer hat would have no quote → quote_status.none)', !!dm && dq.status === 200 && s7.body.reply?.key === 'quote_status.submitted' && String(s7.body.reply?.text).includes(`${tag} dual`) && String(s7.body.reply?.text).includes('4,200'), `${dq.status} ${JSON.stringify(s7.body.reply)}`)

    // two unclear turns → ticket; the third message is stored with NO model call
    const u1 = await say(b2, 'asdf qwer')
    const u2 = await say(b2, 'zxcv uiop')
    const th2 = await threadOf(b2.uid)
    const { data: tk2 } = await admin.from('support_tickets').select('id, channel, role, reason, summary, suggested_next, status, thread_id').eq('user_id', b2.uid).maybeSingle()
    const { data: opsN } = await admin.from('notifications').select('kind, link').eq('user_id', adminU.uid).eq('kind', 'support_ticket_opened')
    const { data: userN } = await admin.from('notifications').select('kind').eq('user_id', b2.uid).eq('kind', 'support_escalated')
    check('two unclear turns → unclear then escalated with ticket_ref; ticket (web, buyer, unclear_twice, model summary, open) on the thread; ops support_ticket_opened + user support_escalated', u1.body.reply?.key === 'unclear' && u2.body.reply?.key === 'escalated' && typeof u2.body.ticket_ref === 'string' && !!tk2 && (tk2 as any).channel === 'web' && (tk2 as any).reason === 'unclear_twice' && !!(tk2 as any).summary && (tk2 as any).status === 'open' && th2.open_ticket_id === (tk2 as any).id && (opsN ?? []).some((x: any) => String(x.link).includes((tk2 as any).id)) && (userN ?? []).length === 1, JSON.stringify({ u1: u1.body.reply?.key, u2: u2.body.reply?.key, tk2 }))
    check('the escalated reply quotes the SLA from lib/legal/grievance.ts and the ticket ref', String(u2.body.reply?.text).includes(String(SLA.acknowledge_hours)) && String(u2.body.reply?.text).includes(String(u2.body.ticket_ref)))
    const invBefore = await invocations(b2.uid)
    const msgBefore = (await messagesOf(th2.id)).length
    const u3 = await say(b2, 'hello? are you there')
    check('the third message while the ticket is open → escalated_open, stored (+2 rows), NO model call (ai_invocations unchanged)', u3.body.reply?.key === 'escalated_open' && (await invocations(b2.uid)) === invBefore && (await messagesOf(th2.id)).length === msgBefore + 2, `${u3.body.reply?.key} inv ${invBefore}→${await invocations(b2.uid)}`)

    const h1 = await say(b3, 'I want to talk to a person')
    const { data: tk3 } = await admin.from('support_tickets').select('reason, channel').eq('user_id', b3.uid).maybeSingle()
    check('"I want to talk to a person" → an immediate ticket (asked_for_human) on the first turn', h1.body.reply?.key === 'escalated' && (tk3 as any)?.reason === 'asked_for_human', JSON.stringify(tk3))

    // ── admin queue ─────────────────────────────────────────────────────────
    const list = await json(await api(adminU.token, '/api/v1/agent/admin/support/tickets', undefined, 'GET'))
    const listed = ((list['tickets'] as any[]) ?? []).filter((t) => [b2.uid, b3.uid].includes(t.user_id))
    check('GET /agent/admin/support/tickets (admin) lists both open tickets with ref, summary, suggested_next', listed.length === 2 && listed.every((t) => t.ref && t.summary), `${listed.length}`)
    const listB = await api(b1.token, '/api/v1/agent/admin/support/tickets', undefined, 'GET')
    await json(listB)
    check('the admin queue refuses a buyer (403)', listB.status === 403, `status ${listB.status}`)
    const adminPage = await fetch(`${BASE}/admin/support`, { headers: { cookie: await cookieFor(adminU.email) } })
    check('/admin/support renders for an admin (200)', adminPage.status === 200, `status ${adminPage.status}`)
    const tid = (tk2 as any).id as string
    const detail = await json(await api(adminU.token, `/api/v1/agent/admin/support/tickets/${tid}`, undefined, 'GET'))
    check('GET ticket detail → the thread transcript (masked), the ref', Array.isArray(detail['transcript']) && (detail['transcript'] as any[]).length >= 4 && detail['ref'] === u2.body.ticket_ref, `${(detail['transcript'] as any[] | undefined)?.length}`)
    const ack = await api(adminU.token, `/api/v1/agent/admin/support/tickets/${tid}`, { action: 'acknowledge' }, 'PATCH')
    const ackB = await json(ack)
    const asg = await api(adminU.token, `/api/v1/agent/admin/support/tickets/${tid}`, { action: 'assign' }, 'PATCH')
    const asgB = await json(asg)
    const noNote = await api(adminU.token, `/api/v1/agent/admin/support/tickets/${tid}`, { action: 'resolve' }, 'PATCH')
    await json(noNote)
    const res = await api(adminU.token, `/api/v1/agent/admin/support/tickets/${tid}`, { action: 'resolve', note: 'Called the buyer; they meant the October invoice.' }, 'PATCH')
    const resB = await json(res)
    const { data: audits } = await admin.from('audit_logs').select('action').eq('actor_id', adminU.uid).eq('entity_id', tid)
    const acts = new Set(((audits ?? []) as any[]).map((a) => a.action))
    check('acknowledge → in_progress + acknowledged_at; assign → assigned_to me; resolve without a note → 422; resolve → resolved', ack.status === 200 && (ackB['ticket'] as any)?.status === 'in_progress' && !!(ackB['ticket'] as any)?.acknowledged_at && asg.status === 200 && (asgB['ticket'] as any)?.assigned_to === adminU.uid && noNote.status === 422 && res.status === 200 && (resB['ticket'] as any)?.status === 'resolved', `${ack.status}/${asg.status}/${noNote.status}/${res.status}`)
    check('audit_logs: support_ticket_acknowledge / _assign / _resolve by the admin on the ticket', acts.has('support_ticket_acknowledge') && acts.has('support_ticket_assign') && acts.has('support_ticket_resolve'), [...acts].join(','))
    const th2b = await threadOf(b2.uid)
    const { data: resN } = await admin.from('notifications').select('kind').eq('user_id', b2.uid).eq('kind', 'support_resolved')
    const back = await say(b2, 'where is my order')
    check('resolve → thread cleared (open_ticket_id null), the user told (support_resolved), the next message answered again (order_status, not escalated_open)', th2b.open_ticket_id === null && (resN ?? []).length === 1 && back.body.reply?.key === 'order_status.in_progress' && String(back.body.reply?.text).includes(o2.number), JSON.stringify(back.body.reply?.key))
    const reAct = await api(adminU.token, `/api/v1/agent/admin/support/tickets/${tid}`, { action: 'acknowledge' }, 'PATCH')
    await json(reAct)
    check('an action on a resolved ticket → 409 already_resolved', reAct.status === 409, `status ${reAct.status}`)

    // ── WhatsApp (runtime in-process) ───────────────────────────────────────
    process.env['AGENT_ENABLED'] = 'true'
    process.env['API_URL'] = BASE
    process.env['WHATSAPP_DRIVER'] = 'stub'
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rt = require('../../agent-runtime/src/agents/support/index') as typeof import('../../agent-runtime/src/agents/support/index')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const inbound = require('../../agent-runtime/src/whatsapp/inbound') as typeof import('../../agent-runtime/src/whatsapp/inbound')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const outboundMod = require('../../agent-runtime/src/whatsapp/outbound') as typeof import('../../agent-runtime/src/whatsapp/outbound')
    // ADR-030: the dispatcher's own replies (menu, consent) go through sendSystem — recorded here per conversation
    const sysSent: Array<{ conv: string; kind: string }> = []
    const sysSend: typeof outboundMod.sendSystem = async (conv, kind, locale, opts) => { sysSent.push({ conv: conv.id, kind }); return outboundMod.sendSystem(conv, kind, locale, opts) }
    const sysKindsOf = (conv: string) => sysSent.filter((s) => s.conv === conv).map((s) => s.kind)
    const { error: consentProbe } = await admin.from('wa_phone_consents').select('phone_e164').limit(1)
    const has0086 = !missingRelation(consentProbe)
    loadDefaultPrompts()
    const whatsapp = makeStubDriver(() => undefined)
    const store = new Map<string, number>()
    const memRedis: RedisLike = {
      async incrby(k, v) { const x = (store.get(k) ?? 0) + v; store.set(k, x); return x },
      async expire() { return 1 },
      async mget<T = unknown>(...keys: string[]) { return keys.map((k) => (store.has(k) ? (store.get(k) as unknown as T) : null)) },
    }
    const tokens = new Map<string, string>([[w.uid, w.token], [n.uid, n.token], [b1.uid, b1.token], [p1.uid, p1.token]])
    const tokenPersonas: string[] = []
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
    const deps: import('../../agent-runtime/src/agents/support/index').SupportRuntimeDeps = {
      core, admin, whatsapp, apiUrl: BASE, agentEnabled: true, tokenFor: async ({ userId, persona }) => { tokenPersonas.push(`${userId}:${persona ?? 'none'}`); return tokens.get(userId) ?? '' }, mediaBucket: BUCKET, runtimeSecret: RIG_RUNTIME_SECRET, capture: () => undefined,
    }
    const queue: Array<{ kind: 'reply'; conversationId: string; messageId: string } | { kind: 'decide'; runId: string; messageId: string; action: 'yes' | 'no' }> = []
    const hooks = {
      enqueueSupportReply: async (j: { conversationId: string; messageId: string }) => { queue.push({ kind: 'reply', ...j }); return 'queued' },
      enqueueSupportDecide: async (j: { runId: string; messageId: string; action: 'yes' | 'no' }) => { queue.push({ kind: 'decide', ...j }); return 'queued' },
    }
    const drain = async () => { const out: any[] = []; while (queue.length) { const j = queue.shift()!; out.push(j.kind === 'reply' ? await rt.runSupportReply(deps, j) : await rt.runSupportDecide(deps, j)) } return out }
    async function mkConv(u: { uid: string; digits: string }, grant: boolean, persona: 'buyer' | 'provider' = 'buyer') {
      const { data } = await admin.from('wa_conversations').insert({ phone_e164: `91${u.digits}`, user_id: u.uid, locale: 'en', last_inbound_at: new Date().toISOString(), window_open_until: new Date(Date.now() + 86400 * 1000).toISOString() }).select('id').single()
      created.convIds.push(data!.id)
      if (grant) await admin.from('agent_grants').insert({ user_id: u.uid, persona, scopes: [], channel: 'whatsapp', channel_identity: `+91${u.digits}`, consent: { locale: 'en', surface: 'whatsapp', keyword: 'START', text_version: 'v1', at: new Date().toISOString() } })
      return data!.id as string
    }
    let vendorSeq = 0
    async function waSay(conv: string, m: { kind: 'text' | 'button'; body?: string; payload?: string }, opts: { openWindow?: boolean } = {}) {
      const raw = m.kind === 'button' ? { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: m.payload, title: m.body ?? m.payload } } } : { type: 'text', text: { body: m.body } }
      const { data, error } = await admin.from('wa_messages').insert({ conversation_id: conv, direction: 'in', vendor_message_id: `${tag}-${++vendorSeq}`, kind: m.kind, body: m.body ?? m.payload ?? null, status: 'received', payload: raw }).select('id').single()
      if (error) throw new Error(`waSay: ${error.message}`)
      if (opts.openWindow !== false) await admin.from('wa_conversations').update({ last_inbound_at: new Date().toISOString(), window_open_until: new Date(Date.now() + 86400 * 1000).toISOString() }).eq('id', conv)
      await inbound.handleWaInbound(data!.id as string, hooks, { send: sysSend })
      return { id: data!.id as string, results: await drain() }
    }
    const outbound = async (conv: string) => ((await admin.from('wa_messages').select('id, kind, body, template_name, status, payload, created_at').eq('conversation_id', conv).eq('direction', 'out').order('created_at', { ascending: true })).data ?? []) as any[]
    const runRow = async (id: string) => (await admin.from('agent_runs').select('id, status, surface, meta').eq('id', id).maybeSingle()).data as any

    const ow = await mkOrder(w.msmeId, p1.providerId)
    const convW = await mkConv(w, true)
    const t1 = await waSay(convW, { kind: 'text', body: 'where is my order' })
    const r1 = t1.results[0]
    const runId1 = r1?.detail?.run_id as string | undefined
    const { data: inv } = await admin.from('ai_invocations').select('task_class, tier, run_id').eq('run_id', runId1 ?? NIL)
    const out1 = await outbound(convW)
    const btn = out1.find((m) => m.kind === 'button')
    const { count: tc } = await admin.from('agent_events').select('id', { count: 'exact', head: true }).eq('run_id', runId1 ?? NIL).eq('kind', 'tool_called').eq('tool', 'support_lookup')
    check('WhatsApp text (granted, cohorted) → support.reply: ONE ai_invocations (support_intent, routine, run_id), the reads logged as tool_called support_lookup, the run meta.agent = support', r1?.status === 'ok' && (inv ?? []).length === 1 && (inv as any[])[0].task_class === 'support_intent' && (inv as any[])[0].tier === 'routine' && (tc ?? 0) >= 1 && (await runRow(runId1 ?? NIL))?.meta?.agent === 'support', JSON.stringify({ r1, inv, tc }))
    check(`the outbound is the rendered template naming ${ow.number}, delivered as nudge buttons nudge:yes|no:<runId> (active order); the run parks awaiting_confirmation`, r1?.detail?.outcome === 'nudge_offered' && !!btn && String(btn.body).includes(ow.number) && (btn.payload?.buttons ?? []).includes(`nudge:yes:${runId1}`) && (await runRow(runId1 ?? NIL))?.status === 'awaiting_confirmation', JSON.stringify(out1.map((m) => [m.kind, String(m.body ?? '').slice(0, 60)])))
    const tap = await waSay(convW, { kind: 'button', payload: `nudge:yes:${runId1}`, body: 'Yes, send it' })
    const { data: wDec } = await admin.from('ai_decisions').select('feature, tool, run_id, input_refs').eq('run_id', runId1 ?? NIL).maybeSingle()
    const { data: wNud } = await admin.from('nudges').select('id').eq('subject_id', ow.id).eq('from_user_id', w.uid)
    check('tap Yes → support.decide → the decision route under the token (ai_decisions support_nudge, tool nudge_counterparty, input_refs.wa_message_id) → resume → the ORDINARY nudge route: a nudges row, "sent" reply', tap.results[0]?.detail?.outcome === 'sent' && (wDec as any)?.feature === 'support_nudge' && (wDec as any)?.tool === 'nudge_counterparty' && (wDec as any)?.input_refs?.wa_message_id === tap.id && (wNud ?? []).length === 1 && (await runRow(runId1 ?? NIL))?.status === 'completed', JSON.stringify({ r: tap.results[0], wDec }))
    const t2 = await waSay(convW, { kind: 'text', body: 'remind the provider again' })
    const out2 = await outbound(convW)
    check('asking again within the cooldown → nudge.capped text, no buttons', t2.results[0]?.detail?.reply_key === 'nudge.capped' && out2.at(-1)?.kind === 'text', JSON.stringify(t2.results[0]))
    // the cap through the resume: offer on a second order, nudge it directly, then tap Yes → the route answers 429
    const ow2 = await mkOrder(w.msmeId, p1.providerId)
    const t3 = await waSay(convW, { kind: 'text', body: 'where is my order' })
    const runId3 = t3.results[0]?.detail?.run_id as string | undefined
    const direct = await api(w.token, `/api/v1/orders/${ow2.id}/nudge`, { via: 'web' })
    await json(direct)
    const tap3 = await waSay(convW, { kind: 'button', payload: `nudge:yes:${runId3}`, body: 'Yes, send it' })
    check(`a Yes after the cap was reached elsewhere → the resumed route answers 429 → outcome capped + nudge.capped reply (${ow2.number} is the latest order)`, t3.results[0]?.detail?.outcome === 'nudge_offered' && direct.status === 200 && tap3.results[0]?.detail?.outcome === 'capped' && /already|12/.test(String((await outbound(convW)).at(-1)?.body ?? '')), JSON.stringify(tap3.results[0]))
    const tapNo = await waSay(convW, { kind: 'button', payload: `nudge:no:${runId3}`, body: 'No' })
    const { data: gAfterNo } = await admin.from('agent_grants').select('id').eq('user_id', w.uid).eq('channel', 'whatsapp').is('revoked_at', null)
    check('the nudge "No" button (title "No" = the S0.5 opt-out keyword) is classified by its payload: the WhatsApp grant stays active (no silent opt-out)', (gAfterNo ?? []).length === 1, `${(gAfterNo ?? []).length} active grants`)
    check('a replayed / late button on a closed run is harmless (stale or declined, no second nudge)', ['stale', 'declined'].includes(tapNo.results[0]?.detail?.outcome) &&((await admin.from('nudges').select('id', { count: 'exact', head: true }).eq('subject_id', ow2.id).eq('from_user_id', w.uid)).count ?? 0) === 1, JSON.stringify(tapNo.results[0]))
    // out of the 24 h window → the support_reply template carrier
    await admin.from('wa_conversations').update({ window_open_until: new Date(Date.now() - 60_000).toISOString() }).eq('id', convW)
    const t4 = await waSay(convW, { kind: 'text', body: 'how do I get a refund' }, { openWindow: false })
    const last4 = (await outbound(convW)).at(-1)
    check('out of the 24 h window → the support_reply template (amc_support_reply_en) carries the reply, no free text', t4.results[0]?.status === 'ok' && last4?.kind === 'template' && last4?.template_name === 'amc_support_reply_en', JSON.stringify([last4?.kind, last4?.template_name]))
    // escalation → ticket (runtime-credential route, or the fallback) → quiet → admin resolve → answered again
    const t5 = await waSay(convW, { kind: 'text', body: 'this is unacceptable, the provider is ignoring me' })
    const { data: tkW } = await admin.from('support_tickets').select('id, channel, reason, conversation_id, summary').eq('user_id', w.uid).neq('status', 'resolved').maybeSingle()
    const { data: convRow } = await admin.from('wa_conversations').select('support_ticket_id').eq('id', convW).single()
    const viaRoute = !!RIG_RUNTIME_SECRET && !!(tkW as any)?.summary && !/automatic summary was not available/.test((tkW as any).summary)
    check(`complaint → escalated: a whatsapp ticket (complaint) on the conversation, conversation marked, escalated reply with the ref — ${RIG_RUNTIME_SECRET ? 'via the runtime-credential route (model summary)' : 'via the runtime fallback (no AGENT_RUNTIME_SECRET here)'}`, t5.results[0]?.detail?.outcome === 'escalated' && !!tkW && (tkW as any).channel === 'whatsapp' && (tkW as any).reason === 'complaint' && (convRow as any)?.support_ticket_id === (tkW as any).id && String((await outbound(convW)).at(-1)?.body ?? '').includes(String(t5.results[0]?.detail?.ticket ?? '~')) && (RIG_RUNTIME_SECRET ? viaRoute : true), JSON.stringify({ r: t5.results[0], tkW }))
    if (!RIG_RUNTIME_SECRET) skip('the runtime-credential ticket route (POST /agent/admin/support/tickets)', 'set AGENT_RUNTIME_SECRET to the same throwaway value on this rig and the local server')
    const outBeforeQuiet = (await outbound(convW)).length
    const t6 = await waSay(convW, { kind: 'text', body: 'hello? anyone?' })
    const sysBeforeQuiet = sysKindsOf(convW).length
    check('while the ticket is open: the next inbound is stored, NO job, NO reply, NO menu', t6.results.length === 0 && (await outbound(convW)).length === outBeforeQuiet && sysKindsOf(convW).length === sysBeforeQuiet)
    const resW = await api(adminU.token, `/api/v1/agent/admin/support/tickets/${(tkW as any)?.id ?? NIL}`, { action: 'resolve', note: 'Spoke to the provider; work resumes tomorrow.' }, 'PATCH')
    await json(resW)
    const { data: convAfter } = await admin.from('wa_conversations').select('support_ticket_id').eq('id', convW).single()
    const t7 = await waSay(convW, { kind: 'text', body: 'where is my order' })
    check('admin resolve → the conversation is cleared → the next inbound is answered again', resW.status === 200 && (convAfter as any)?.support_ticket_id === null && t7.results[0]?.status === 'ok' && ['answered', 'nudge_offered'].includes(t7.results[0]?.detail?.outcome), JSON.stringify(t7.results[0]))
    // a provider-only user: the START grant is persona 'provider', so the run and every token must be 'provider' (a 'buyer' mint 403s)
    const convP = await mkConv(p1, true, 'provider')
    tokenPersonas.length = 0
    const tp = await waSay(convP, { kind: 'text', body: 'when will I be paid' })
    const runP = tp.results[0]?.detail?.run_id as string | undefined
    const { data: runPRow } = await admin.from('agent_runs').select('persona').eq('id', runP ?? NIL).maybeSingle()
    check('a provider-only WhatsApp user: the run persona and every delegated-token mint are provider (the grant persona) → payout_status answered from their own orders', tp.results[0]?.status === 'ok' && (runPRow as any)?.persona === 'provider' && tokenPersonas.length > 0 && tokenPersonas.every((x) => x === `${p1.uid}:provider`) && String(tp.results[0]?.detail?.reply_key ?? '').startsWith('payout_status.') && tp.results[0]?.detail?.reply_key !== 'payout_status.none', JSON.stringify({ r: tp.results[0], persona: (runPRow as any)?.persona, tokenPersonas: [...new Set(tokenPersonas)] }))
    // no grant → the HELP menu (no model, no support job)
    const convN = await mkConv(n, false)
    const tn = await waSay(convN, { kind: 'text', body: 'where is my order' })
    check('a cohorted user WITHOUT a WhatsApp grant → the ADR-030 HELP menu only (no support job)', tn.results.length === 0 && JSON.stringify(sysKindsOf(convN)) === '["wa_menu"]', JSON.stringify(sysKindsOf(convN)))
    // STOP → grants revoked, the one confirmation → afterwards nothing (0086: the phone is opted out) or the menu (before 0086)
    await waSay(convW, { kind: 'text', body: 'STOP' })
    const { data: gW } = await admin.from('agent_grants').select('id').eq('user_id', w.uid).eq('channel', 'whatsapp').is('revoked_at', null)
    const sysAfterStop = sysKindsOf(convW).length
    const ts = await waSay(convW, { kind: 'text', body: 'where is my order' })
    const afterStop = sysKindsOf(convW).slice(sysAfterStop)
    check(`STOP → every WhatsApp grant revoked, the opt-out confirmation → the next text gets ${has0086 ? 'NOTHING (the phone is opted out)' : 'the menu only (0086 not applied: the grant-only fallback)'} and no support job`, (gW ?? []).length === 0 && ts.results.length === 0 && sysKindsOf(convW)[sysAfterStop - 1] === 'wa_opt_out_confirmed' && JSON.stringify(afterStop) === (has0086 ? '[]' : '["wa_menu"]'), JSON.stringify({ afterStop, all: sysKindsOf(convW) }))
    // RLS through the runtime lookups: another user's order number never resolves (B1's token asks for B2's order)
    const rlsDeps = { ...deps, core: { ...core, ledger: { ...core.ledger, appendEvent: async () => undefined } } } as typeof deps
    const lk = rt.runtimeSupportLookups(rlsDeps, { runId: NIL, userId: b1.uid }, async () => false)
    const foreign = await lk.getOrder(o2.number, 'buyer')
    const forced = await runSupportTurn({ classify: async () => ({ intent: 'order_status', as_role: null, order_ref: o2.number, rfq_ref: null, how_to_topic: null, escalate: false, escalate_reason: null, ops_summary: null, language: 'en' }), lookups: lk, settings: { escalateAfterTurns: 2, nudgeCooldownHours: 24 }, sla: SLA, supportContact: CONTACT }, { text: `order ${o2.number}`, messageId: NIL, channel: 'whatsapp', roles: ['buyer'], locale: 'en', history: { intents: [], unclearStreak: 0 }, openTicket: false })
    check('a classifier that names ANOTHER user\'s order (forced) → the lookup under B1\'s token returns null → order_status.not_found; the reply never contains that number', foreign === null && forced.reply.key === 'order_status.not_found' && !forced.reply.text.includes(o2.number), JSON.stringify({ key: forced.reply.key }))

    // stats — the self-serve rate is computed from the returned counts
    const stats = await json(await api(adminU.token, '/api/v1/agent/admin/support/stats', undefined, 'GET'))
    const turns = Number(stats['turns_7d'])
    const esc = Number(stats['escalations_7d'])
    const expectRate = turns ? Math.round(((turns - esc) / turns) * 100) : null
    const reasons = (stats['reasons'] ?? {}) as Record<string, number>
    check('GET /agent/admin/support/stats: turns_7d counts web + WhatsApp turns, escalations ≥ 3, reasons incl. unclear_twice / asked_for_human / complaint, self-serve rate = (turns − escalations) ÷ turns', turns >= 14 && esc >= 3 && stats['self_serve_rate_pct'] === expectRate && (reasons['unclear_twice'] ?? 0) >= 1 && (reasons['asked_for_human'] ?? 0) >= 1 && (reasons['complaint'] ?? 0) >= 1 && typeof stats['median_ack_minutes'] === 'number', JSON.stringify(stats).slice(0, 220))
    const statsB = await api(b1.token, '/api/v1/agent/admin/support/stats', undefined, 'GET')
    await json(statsB)
    check('the stats route refuses a buyer (403)', statsB.status === 403, `status ${statsB.status}`)

    skip('HMAC token exchange + scoped delegated token (support_lookup / nudge_counterparty 403 without the scope)', 'the users\' own session tokens stand in (no SUPABASE_JWT_SECRET on this laptop); requireToolScope on the reads and the nudge routes is the S0.1-proven lock')
    skip('pg-boss queues agent.support.reply / .decide + the runtime webhook', 'runtime driven in-process on this laptop (never start the runtime against prod)')
    skip('voice note → STT → support turn', 'the S1.6 STT leg (transcribeVoiceNote) — set VOICE_STUB_TRANSCRIPT and drive it from verify-onboarding / verify-munshi')
    skip('live model classification', 'keyless gateway → the deterministic stub classifier; the live gate is eval --set support_intent (≥ 90 %, all injections) once the key exists')
  } finally {
    // ── cleanup (zero residue; CHECKED, FK-ordered) ──────────────────────────
    const errors: string[] = []
    const del = async (label: string, q: PromiseLike<{ error: { message: string } | null }>) => { const { error } = await q; if (error && !/Could not find the table|does not exist|schema cache/.test(error.message)) errors.push(`${label}: ${error.message}`) }
    try {
      const users = created.users.length ? created.users : [NIL]
      const rfqIds = created.rfqIds.length ? created.rfqIds : [NIL]
      const orderIds = created.orderIds.length ? created.orderIds : [NIL]
      const pids = created.providerIds.length ? created.providerIds : [NIL]
      const convIds = created.convIds.length ? created.convIds : [NIL]
      // support tables first (the ticket ↔ thread / conversation references are nulled before the deletes)
      await del('threads.open_ticket_id=null', admin.from('support_threads').update({ open_ticket_id: null }).in('user_id', users))
      await del('wa.support_ticket_id=null', admin.from('wa_conversations').update({ support_ticket_id: null }).in('id', convIds))
      const { data: ths } = await admin.from('support_threads').select('id').in('user_id', users)
      const threadIds = ((ths ?? []) as { id: string }[]).map((t) => t.id)
      if (threadIds.length) await del('support_messages', admin.from('support_messages').delete().in('thread_id', threadIds))
      await del('support_tickets', admin.from('support_tickets').delete().in('user_id', users))
      await del('support_threads', admin.from('support_threads').delete().in('user_id', users))
      await del('nudges', admin.from('nudges').delete().in('from_user_id', users))
      // notifications reach seed providers through the RFQ fan-out / bulk nudge: delete by the rig's links too
      for (const id of [...created.orderIds, ...created.rfqIds]) await del('notifications(link)', admin.from('notifications').delete().like('link', `%${id}%`))
      await del('notifications(user)', admin.from('notifications').delete().in('user_id', users))
      const { data: qs } = await admin.from('quotes').select('id').in('rfq_id', rfqIds)
      const quoteIds = ((qs ?? []) as { id: string }[]).map((q) => q.id)
      if (quoteIds.length) {
        const { data: convs } = await admin.from('conversations').select('id').eq('context_type', 'quote').in('context_id', quoteIds)
        const cids = ((convs ?? []) as { id: string }[]).map((c) => c.id)
        if (cids.length) {
          await del('messages', admin.from('messages').delete().in('conversation_id', cids))
          await del('conversations', admin.from('conversations').delete().in('id', cids))
        }
        await del('quote_events', admin.from('quote_events').delete().in('quote_id', quoteIds))
        await del('price_book(quote)', admin.from('provider_price_book').delete().in('source_quote_id', quoteIds))
      }
      await del('price_book(provider)', admin.from('provider_price_book').delete().in('provider_id', pids))
      await del('quotes', admin.from('quotes').delete().in('rfq_id', rfqIds))
      await del('rfq_clarifications', admin.from('rfq_clarifications').delete().in('rfq_id', rfqIds))
      await del('rfq_matches', admin.from('rfq_matches').delete().in('rfq_id', rfqIds))
      await del('rfq_intake', admin.from('rfq_intake_extractions').delete().in('rfq_id', rfqIds))
      await del('rfqs', admin.from('rfqs').delete().in('id', rfqIds))
      await del('order_events', admin.from('order_events').delete().in('order_id', orderIds))
      await del('orders', admin.from('orders').delete().in('id', orderIds))
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
      await del('grants', admin.from('agent_grants').delete().in('user_id', users))
      // ADR-030: the phone's current consent state goes; the consent EVENTS are append-only evidence (0086) and stay,
      // their user_id nulled when the user row is deleted
      await del('wa_phone_consents', admin.from('wa_phone_consents').delete().in('user_id', users))
      await del('audit', admin.from('audit_logs').delete().in('actor_id', users))
      await del('provider_categories', admin.from('provider_categories').delete().in('provider_id', pids))
      await del('provider_profiles', admin.from('provider_profiles').delete().in('id', pids))
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
      const { count: u } = await admin.from('users').select('id', { count: 'exact', head: true }).like('email', `${tag}%`)
      if (u) residue.push(`users=${u}`)
      if (created.users.length) {
        for (const [table, col] of [['agent_runs', 'user_id'], ['ai_decisions', 'decided_by'], ['ai_invocations', 'user_id'], ['agent_grants', 'user_id'], ['provider_profiles', 'user_id'], ['msme_profiles', 'user_id'], ['notifications', 'user_id'], ['support_tickets', 'user_id'], ['support_threads', 'user_id'], ['nudges', 'from_user_id'], ['audit_logs', 'actor_id']] as const) {
          const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true }).in(col, created.users)
          if (count && !error) residue.push(`${table}=${count}`)
        }
      }
      for (const [table, col, ids] of [['orders', 'id', created.orderIds], ['order_events', 'order_id', created.orderIds], ['rfqs', 'id', created.rfqIds], ['rfq_matches', 'rfq_id', created.rfqIds], ['quotes', 'rfq_id', created.rfqIds], ['wa_conversations', 'id', created.convIds], ['wa_messages', 'conversation_id', created.convIds]] as const) {
        if (!ids.length) continue
        const { count } = await admin.from(table).select('*', { count: 'exact', head: true }).in(col, ids)
        if (count) residue.push(`${table}=${count}`)
      }
      for (const id of [...created.orderIds, ...created.rfqIds]) {
        const { count } = await admin.from('notifications').select('id', { count: 'exact', head: true }).like('link', `%${id}%`)
        if (count) residue.push(`notifications(link ${id.slice(0, 8)})=${count}`)
      }
      if (errors.length) record('cleanup', 'FAIL', errors.join(' | '))
      else check(`cleanup: zero residue (${created.users.length} users, ${created.orderIds.length} orders, ${created.rfqIds.length} RFQs, ${created.convIds.length} conversations removed and recounted incl. seed-provider notifications by link; settings restored)`, residue.length === 0, residue.join(', '))
    } catch (e) {
      record('cleanup', 'FAIL', (e as Error).message)
    }
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
