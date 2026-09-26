/**
 * verify-munshi.ts — Digital Munshi v1 (BUILD_PROMPTS S2.2) against a running server on the prod DB.
 *
 *   offline  — the laws that are pure: the voice allow-list, button parsing, the scope list.
 *   flag OFF — /partner/munshi 404, /api/v1/agent/munshi* 404, crons enqueue nothing, the quote route is
 *              byte-identical, the price-book spine works for a session, the matched list carries notifiedAt.
 *   flag ON  — the runtime driven IN-PROCESS (munshi.scan / decide / followup with the stub WhatsApp driver
 *              and the keyless gateway): grant + cohort gating, no price history → never a quote, the band
 *              clamp, approve via the web decision route (resumed by the follow-up), the composer edit, skip,
 *              a grant without submit_quote, WhatsApp buttons + text "yes" + edit / re-ask paths, a reply
 *              draft, the window warning, expiry, the daily cap, disable + STOP, the admin tile.
 *
 * Recorded skips (never passes): the HMAC token exchange (the provider's OWN session token stands in for the
 * delegated one, so the web scope gate is a no-op — the in-process runner enforces the grant's scopes), the
 * runtime webhook / pg-boss legs, the WhatsApp voice note when VOICE_STUB_TRANSCRIPT is unset, a goods RFQ
 * (needs MART_ENABLED), a per-run budget breach (the keyless gateway reports zero cost), and the accept-via-
 * checkout leg (proven by the Phase 5 / S1.3 rigs).
 *
 * Every row it creates is tagged and deleted in FK order; the last row is the zero-residue recount.
 *
 * Run: BASE_URL=http://localhost:3100 pnpm --filter @amclub/web agents:verify:munshi
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
  type RedisLike,
  type RunAgentDeps,
} from '@amclub/agent-core'
import { MUNSHI_CONSENT_TEXT_VERSION, MUNSHI_SCOPES, isUnambiguousYes, parseMunshiButton, toolsForPersona, type MunshiDraft } from '@amclub/shared'

config({ path: path.resolve(__dirname, '../.env.local') })

const BASE = (process.env['BASE_URL'] || '').replace(/\/$/, '')
const SUPA_URL = process.env['NEXT_PUBLIC_SUPABASE_URL'] || ''
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] || ''
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY'] || ''
const CRON_SECRET = process.env['VERIFY_CRON_SECRET'] || ''
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
const SCOPE = 'Monthly GST return filing for one GSTIN, including reconciliation of purchase invoices and a monthly summary.'

/* eslint-disable @typescript-eslint/no-explicit-any */

function offline() {
  check('allow-list: "haan bhej do" approves; "yes send it" approves in every locale', isUnambiguousYes('Haan, bhej do!', 'hi') && isUnambiguousYes('yes send it', 'te'))
  check('allow-list: "haan lekin price badha do" / "hmm" / "yes but change the price" never approve', !isUnambiguousYes('haan lekin price badha do', 'hi') && !isUnambiguousYes('hmm', 'en') && !isUnambiguousYes('yes but change the price', 'en'))
  const rid = '11111111-1111-4111-8111-111111111111'
  check('button payloads: approve|edit|skip:<runId> parse; anything else is not a button', parseMunshiButton(`approve:${rid}`)?.action === 'approve' && parseMunshiButton(`confirm:${rid}`) === null && parseMunshiButton('yes') === null)
  const names = new Set(toolsForPersona('provider').map((t) => t.name))
  check('MUNSHI_SCOPES ⊆ provider tools; submit / ask / reply are confirm:true', MUNSHI_SCOPES.every((s) => names.has(s)) && toolsForPersona('provider').filter((t) => ['submit_quote', 'ask_clarification', 'reply_thread'].includes(t.name)).every((t) => t.confirm))
}

async function http() {
  if (!BASE || !SUPA_URL || !ANON || !SERVICE) {
    skip('HTTP checks', 'set BASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
    return
  }
  const admin: SupabaseClient = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } })
  const tag = `kt_mun_${Date.now().toString(36)}`
  const created = { users: [] as string[], providerIds: [] as string[], msmeIds: [] as string[], rfqIds: [] as string[], convIds: [] as string[], objects: [] as string[] }
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
  const api = (token: string, p: string, body?: unknown, method = 'POST') =>
    fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const cookieFor = async (email: string) => {
    const jar: Record<string, string> = {}
    const ssr = createServerClient(SUPA_URL, ANON, { cookies: { getAll() { return Object.entries(jar).map(([name, value]) => ({ name, value })) }, setAll(l) { for (const { name, value } of l) jar[name] = value } } })
    await ssr.auth.signInWithPassword({ email, password: 'Test1234!' })
    return Object.entries(jar).map(([n, v]) => `${n}=${v}`).join('; ')
  }
  const missingRelation = (e: { message: string } | null | undefined) => !!e && /Could not find|does not exist|schema cache/.test(e.message)
  const draftsFor = async (providerId: string, rfqId?: string) => {
    let q = admin.from('munshi_drafts').select('id, kind, status, rfq_id, quote_id, run_id, draft, basis, result_ref, decision_id, delivered, expires_at, created_at').eq('provider_id', providerId).order('created_at', { ascending: true })
    if (rfqId) q = q.eq('rfq_id', rfqId)
    const { data } = await q
    return (data ?? []) as any[]
  }
  const runRow = async (id: string) => (await admin.from('agent_runs').select('id, status, parent_run_id, surface, subject_type, subject_id, error').eq('id', id).single()).data as any
  const outbound = async (convId: string) => ((await admin.from('wa_messages').select('id, kind, body, template_name, status, payload, created_at').eq('conversation_id', convId).eq('direction', 'out').order('created_at', { ascending: true })).data ?? []) as any[]

  console.log(`\nverify-munshi → ${BASE}\n`)
  const probe = await fetch(`${BASE}/api/v1/agent/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  await json(probe)
  const flagOn = probe.status !== 404

  try {
    const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
    const categoryId = cat!.id
    const buyer = await mkUser('buyer', ['msme'])
    const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'Munshi Buyer Co', state: 'KA', sector: 'services' }).select('id').single()
    created.msmeIds.push(msme!.id)
    async function mkProvider(label: string) {
      // real roles (audit B3): every account starts as msme and provider signup appends provider
      const u = await mkUser(label, ['msme', 'provider'])
      const { data: p } = await admin.from('provider_profiles').insert({ user_id: u.uid, legal_name: `${label} Pvt`, display_name: label, slug: `${tag}-${label}`, state: 'KA', city: 'X', languages: ['en'], status: 'active', gstin: `29AAAAA0000A1Z${label.length}` }).select('id').single()
      created.providerIds.push(p!.id)
      await admin.from('provider_categories').insert({ provider_id: p!.id, category_id: categoryId })
      return { ...u, providerId: p!.id as string }
    }
    const p1 = await mkProvider('p1')
    const p2 = await mkProvider('p2')
    const p3 = await mkProvider('p3')
    async function mkRfq(title: string, details: Record<string, unknown> = { additional_details: 'One GSTIN in Guntur, about 40 purchase invoices a month.' }): Promise<string> {
      const r = await api(buyer.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title, details })
      const d = await json(r)
      if (r.status !== 200 || !d['rfqId']) throw new Error(`rfq create ${r.status} ${JSON.stringify(d).slice(0, 120)}`)
      created.rfqIds.push(d['rfqId'] as string)
      return d['rfqId'] as string
    }

    // Crons are wired and guarded whatever the flag.
    for (const name of ['agent-munshi-scan', 'agent-munshi-followup']) {
      const no = await fetch(`${BASE}/api/v1/cron/${name}`)
      await json(no)
      check(`cron/${name} refuses an unauthenticated call (403)`, no.status === 403, `status ${no.status}`)
      if (CRON_SECRET) {
        const yes = await fetch(`${BASE}/api/v1/cron/${name}`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } })
        const b = await json(yes)
        check(`cron/${name} with the secret → 200, enqueued=false (no runtime configured here)`, yes.status === 200 && b['enqueued'] === false, `status ${yes.status} ${JSON.stringify(b)}`)
      } else skip(`cron/${name} with secret`, 'set VERIFY_CRON_SECRET (= the server CRON_SECRET)')
    }

    const rfq0 = await mkRfq(`${tag} zero`)
    const { data: m0 } = await admin.from('rfq_matches').select('provider_id, notified_at').eq('rfq_id', rfq0).eq('provider_id', p1.providerId).maybeSingle()
    check('P1 (KA, tax) is matched to the RFQ', !!m0)
    const matched = await json(await api(p1.token, '/api/v1/rfq/matched', undefined, 'GET'))
    const item = ((matched['rfqs'] as any[]) ?? []).find((r) => r.rfqId === rfq0)
    check('GET /rfq/matched carries notifiedAt (spine, both flags)', !!item && typeof item.notifiedAt === 'string', JSON.stringify(item ?? null).slice(0, 120))

    // Price-book spine (session; 0040-dependent — recorded honestly when the migration is not yet applied).
    const pb0 = await api(p1.token, '/api/v1/partner/price-book', undefined, 'GET')
    const pb0b = await json(pb0)
    if (pb0.status === 503) skip('price-book spine (GET/POST/DELETE)', '0040 not applied on this DB yet — re-run after the migration at the gate')
    else {
      check('GET /partner/price-book (session) → 200 with rows', pb0.status === 200 && Array.isArray(pb0b['rows']), `status ${pb0.status}`)
      const add = await api(p1.token, '/api/v1/partner/price-book', { category_slug: 'tax-accounting', unit: 'job', price_paise: 210000, delivery_days: 5 })
      const addB = await json(add)
      const rowId = (addB['row'] as any)?.id as string | undefined
      check('POST /partner/price-book (manual row) → 201 source manual', add.status === 201 && (addB['row'] as any)?.source === 'manual', `status ${add.status}`)
      if (rowId) {
        const del = await api(p1.token, `/api/v1/partner/price-book/${rowId}`, undefined, 'DELETE')
        check('DELETE /partner/price-book/[id] soft-deletes own row → 200; gone from GET', del.status === 200 && !(((await json(await api(p1.token, '/api/v1/partner/price-book', undefined, 'GET')))['rows'] as any[]) ?? []).some((r) => r.id === rowId))
      }
      const bad = await api(p1.token, '/api/v1/partner/price-book', { category_slug: 'nope', unit: 'job', price_paise: 100 })
      await json(bad)
      check('POST /partner/price-book rejects an unknown category (422)', bad.status === 422, `status ${bad.status}`)
    }

    if (!flagOn) {
      const cookie = await cookieFor(p1.email)
      const page = await fetch(`${BASE}/partner/munshi`, { headers: { cookie } })
      check('flag OFF: /partner/munshi → 404', page.status === 404, `status ${page.status}`)
      for (const [p, m, body] of [['/api/v1/agent/munshi', 'GET', undefined], ['/api/v1/agent/munshi/enable', 'POST', { consent_text_version: MUNSHI_CONSENT_TEXT_VERSION }], ['/api/v1/agent/munshi/drafts', 'GET', undefined], ['/api/v1/agent/admin/munshi/stats', 'GET', undefined]] as const) {
        const r = await api(p1.token, p, body, m)
        await json(r)
        check(`flag OFF: ${m} ${p} → 404`, r.status === 404, `status ${r.status}`)
      }
      const me = await json(await api(p1.token, '/api/v1/profile/me', undefined, 'GET'))
      check('flag OFF: /profile/me.munshiEnabled === false', me['munshiEnabled'] === false)
      const sub = await api(p1.token, `/api/v1/rfq/${rfq0}/quote`, { price_paise: 220000, delivery_days: 5, scope: SCOPE })
      const subB = await json(sub)
      check('flag OFF: a plain quote submits → 200 (byte-identical route; no munshi_draft_id, no drafts table touched)', sub.status === 200 && !!subB['quoteId'], `status ${sub.status}`)
      const md = await admin.from('munshi_drafts').select('id').eq('provider_id', p1.providerId)
      if (missingRelation(md.error)) record('flag OFF: no munshi_drafts row', 'pass', 'table absent (0040 not applied yet) — trivially none')
      else check('flag OFF: no munshi_drafts row', !md.error && (md.data ?? []).length === 0, md.error?.message)
      skip('flag ON lifecycle', 'server is dark')
      return
    }

    // ── flag ON ──────────────────────────────────────────────────────────────
    for (const k of ['agents_enabled', 'cohort_user_ids', 'budget_run_paise_by_agent', 'munshi_price_tolerance_bps', 'munshi_max_drafts_per_day', 'munshi_followup_hours_before_lapse', 'quote_window_hours']) await remember(k)
    const enabledBefore = (settingsBefore.get('agents_enabled')?.value ?? {}) as Record<string, boolean>
    const cohortBefore = (settingsBefore.get('cohort_user_ids')?.value ?? []) as string[]
    const budgetBefore = (settingsBefore.get('budget_run_paise_by_agent')?.value ?? {}) as Record<string, number>
    await setSetting('agents_enabled', { ...enabledBefore, munshi: true })
    await setSetting('cohort_user_ids', [...new Set([...cohortBefore, p1.uid, p2.uid])])
    await setSetting('budget_run_paise_by_agent', { ...budgetBefore, munshi: 1000 })
    await setSetting('munshi_price_tolerance_bps', 2500)
    await setSetting('munshi_max_drafts_per_day', 20)
    await setSetting('munshi_followup_hours_before_lapse', 6)
    await setSetting('quote_window_hours', 48)

    process.env['AGENT_ENABLED'] = 'true'
    process.env['API_URL'] = BASE
    process.env['WHATSAPP_DRIVER'] = 'stub'
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rt = require('../../agent-runtime/src/agents/munshi/index') as typeof import('../../agent-runtime/src/agents/munshi/index')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const inbound = require('../../agent-runtime/src/whatsapp/inbound') as typeof import('../../agent-runtime/src/whatsapp/inbound')
    loadDefaultPrompts()
    const stubLog: string[] = []
    const whatsapp = makeStubDriver((l) => stubLog.push(l))
    const store = new Map<string, number>()
    const memRedis: RedisLike = {
      async incrby(k, v) { const n = (store.get(k) ?? 0) + v; store.set(k, n); return n },
      async expire() { return 1 },
      async mget<T = unknown>(...keys: string[]) { return keys.map((k) => (store.has(k) ? (store.get(k) as unknown as T) : null)) },
    }
    const tokens = new Map<string, string>([[p1.uid, p1.token], [p2.uid, p2.token], [p3.uid, p3.token]])
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
    const deps: import('../../agent-runtime/src/agents/munshi/index').MunshiRuntimeDeps = {
      core, admin, whatsapp, apiUrl: BASE, agentEnabled: true, tokenFor: async ({ userId }) => tokens.get(userId) ?? '', mediaBucket: BUCKET, runtimeSecret: '', capture: () => undefined,
    }
    // audit M42: the dispatcher also enqueues `reask` (a buttons re-send) and sets textApproval on a bound utterance
    type DecideJob = Omit<import('../../agent-runtime/src/agents/munshi/index').MunshiDecideJob, 'kind'>
    const queue: DecideJob[] = []
    const hooks = { enqueueMunshiDecide: async (j: DecideJob) => { queue.push(j); return 'queued' } }
    const drain = async () => { const out: any[] = []; while (queue.length) { const j = queue.shift()!; out.push(await rt.runMunshiDecide(deps, { kind: 'decide', ...j })) } return out }
    const scan = () => rt.runMunshiScan(deps)
    const followup = () => rt.runMunshiFollowup(deps)

    // ── enable: P1 (cohort) yes; P3 (not in cohort) 404 ─────────────────────
    const en1 = await api(p1.token, '/api/v1/agent/munshi/enable', { locale: 'en', consent_text_version: MUNSHI_CONSENT_TEXT_VERSION })
    const en1b = await json(en1)
    const { data: g1 } = await admin.from('agent_grants').select('scopes, channel, consent').eq('user_id', p1.uid).eq('persona', 'provider').eq('channel', 'web').is('revoked_at', null).maybeSingle()
    check('POST /agent/munshi/enable (P1, cohort) → 201 enabled; web grant persona provider with MUNSHI_SCOPES + consent text_version', en1.status === 201 && en1b['enabled'] === true && !!g1 && MUNSHI_SCOPES.every((s) => (g1 as any).scopes.includes(s)) && (g1 as any).consent?.text_version === MUNSHI_CONSENT_TEXT_VERSION, `status ${en1.status}`)
    const en3 = await api(p3.token, '/api/v1/agent/munshi/enable', { locale: 'en', consent_text_version: MUNSHI_CONSENT_TEXT_VERSION })
    await json(en3)
    check('POST /agent/munshi/enable (P3, not in cohort) → 404', en3.status === 404, `status ${en3.status}`)
    const me1 = await json(await api(p1.token, '/api/v1/profile/me', undefined, 'GET'))
    check('/profile/me.munshiEnabled === true for P1', me1['munshiEnabled'] === true)
    const cookie1 = await cookieFor(p1.email)
    const page1 = await fetch(`${BASE}/partner/munshi`, { headers: { cookie: cookie1 } })
    const html1 = await page1.text()
    check('/partner/munshi renders for P1 (200; the server-rendered title — the panel hydrates its sections client-side)', page1.status === 200 && /Munshi/.test(html1), `status ${page1.status}`)
    const page3 = await fetch(`${BASE}/partner/munshi`, { headers: { cookie: await cookieFor(p3.email) } })
    check('/partner/munshi → 404 for P3 (not in cohort)', page3.status === 404, `status ${page3.status}`)

    // ── scan 1: no price history → never a quote ─────────────────────────────
    const rfq1 = await mkRfq(`${tag} one`)
    const s1 = await scan()
    const d1 = await draftsFor(p1.providerId, rfq1)
    check('scan: one provider (P1: grant + cohort; P2 no grant; P3 not cohort), one parent + two child runs (rfq0 and rfq1 are both new)', s1.status === 'ok' && (s1 as any).detail.providers === 1 && (s1 as any).detail.runs === 3, JSON.stringify(s1).slice(0, 160))
    check('no price history → the draft is ask (fixed question) or skip no_price_history, never quote; status proposed; run awaiting_confirmation', d1.length === 1 && d1[0].kind !== 'quote' && (d1[0].kind === 'skip' || (d1[0].status === 'proposed' && (await runRow(d1[0].run_id))?.status === 'awaiting_confirmation')), JSON.stringify(d1.map((d) => [d.kind, d.status])))
    const { data: inv1 } = await admin.from('ai_invocations').select('task_class, tier, run_id').eq('run_id', d1[0]?.run_id ?? '00000000-0000-0000-0000-000000000000').limit(1).maybeSingle()
    check('one ai_invocations row (quote_draft, reasoning tier, run_id set)', !!inv1 && (inv1 as any).task_class === 'quote_draft' && (inv1 as any).tier === 'reasoning', JSON.stringify(inv1))
    check('P2 (cohort, no grant) and P3 (grant attempt refused) have no drafts', (await draftsFor(p2.providerId)).length === 0 && (await draftsFor(p3.providerId)).length === 0)
    const s1b = await scan()
    check('a second scan does not re-draft the same RFQ (one open draft per rfq/provider)', s1b.status === 'ok' && (await draftsFor(p1.providerId, rfq1)).length === 1)
    if (d1[0]?.status === 'proposed') {
      const sk = await api(p1.token, `/api/v1/agent/munshi/drafts/${d1[0].id}/skip`, {})
      const skB = await json(sk)
      const after = (await draftsFor(p1.providerId, rfq1))[0]
      check('skip via web → draft skipped, run cancelled (declined event)', sk.status === 200 && skB['status'] === 'skipped' && after.status === 'skipped' && (await runRow(after.run_id))?.status === 'cancelled', JSON.stringify(skB))
    }

    // ── seed the price book (3 manual rows) → scan 2 → a quote inside the band ─
    for (const price of [200000, 250000, 220000]) {
      const r = await api(p1.token, '/api/v1/partner/price-book', { category_slug: 'tax-accounting', unit: 'job', price_paise: price, delivery_days: 5 })
      if (r.status !== 201) throw new Error(`price-book seed ${r.status}`)
    }
    const rfq2 = await mkRfq(`${tag} two`)
    const s2 = await scan()
    const d2 = (await draftsFor(p1.providerId, rfq2))[0]
    const q2 = (d2?.draft as MunshiDraft | undefined)?.quote
    check('with 3 rows → a quote draft inside the band [150000, 312500], basis ⊆ rows, status proposed, run awaiting_confirmation', s2.status === 'ok' && !!d2 && d2.kind === 'quote' && !!q2 && q2.price_paise >= 150000 && q2.price_paise <= 312500 && (d2.basis as any[]).length === 3 && d2.status === 'proposed' && (await runRow(d2.run_id))?.status === 'awaiting_confirmation', JSON.stringify(d2 ? [d2.kind, d2.status, q2?.price_paise] : null))
    const list2 = await json(await api(p1.token, '/api/v1/agent/munshi/drafts', undefined, 'GET'))
    const v2 = ((list2['drafts'] as any[]) ?? []).find((d) => d.id === d2?.id)
    check('GET /agent/munshi/drafts serves the proposal with the exact tool payload (munshi_draft_id inside)', !!v2 && v2.tool === 'submit_quote' && v2.payload?.munshi_draft_id === d2?.id && v2.payload?.price_paise === q2?.price_paise)

    // ── out-of-band stub → clamped to ask ───────────────────────────────────
    deps.stubDraft = () => ({ action: 'quote', quote: { price_paise: 900000, delivery_days: 5, scope: SCOPE, gst_included: null, transport_included: null, valid_until: null, advance_percent: null }, basis: [], question: null, skip_reason: null, rationale: ['premium'], confidence: 'low' })
    const rfq3 = await mkRfq(`${tag} three`)
    await scan()
    const d3 = (await draftsFor(p1.providerId, rfq3))[0]
    check('a stub price outside the band (₹9,000) → clamped to ask with the fixed question; the proposal is ask_clarification', !!d3 && d3.kind === 'ask' && (d3.draft as MunshiDraft).quote === null && !!(d3.draft as MunshiDraft).question && (await runRow(d3.run_id))?.status === 'awaiting_confirmation', JSON.stringify(d3 ? [d3.kind, (d3.draft as MunshiDraft).question?.slice(0, 40)] : null))
    delete deps.stubDraft
    skip('goods RFQ → skip goods_rfq', 'a goods RFQ needs MART_ENABLED (staged 0022); the law is proven by the agent-core harness test')

    // ── already quoted by hand → not drafted ────────────────────────────────
    const rfq4 = await mkRfq(`${tag} four`)
    const hand = await api(p1.token, `/api/v1/rfq/${rfq4}/quote`, { price_paise: 220000, delivery_days: 5, scope: SCOPE })
    await json(hand)
    await scan()
    check('an RFQ already quoted by hand is not drafted (matched list marks it quoted)', hand.status === 200 && (await draftsFor(p1.providerId, rfq4)).length === 0)

    // ── approve via the web decision route → resumed by the follow-up → the ordinary quote route ─
    const dec2 = await api(p1.token, `/api/v1/agent/runs/${d2.run_id}/decision`, { approve: true, final: v2.payload, input_refs: { munshi_draft_id: d2.id } })
    const dec2b = await json(dec2)
    check('web Approve: POST decision → approved (ai_decisions row bound to the run), resumed=false here (no runtime URL)', dec2.status === 200 && dec2b['status'] === 'approved' && !!dec2b['decision_id'] && dec2b['resumed'] === false, JSON.stringify(dec2b))
    const f1 = await followup()
    const d2b = (await draftsFor(p1.providerId, rfq2))[0]
    const { data: q2row } = await admin.from('quotes').select('id, munshi_draft_id, price_paise, status').eq('rfq_id', rfq2).eq('provider_id', p1.providerId).maybeSingle()
    const { data: dec2row } = await admin.from('ai_decisions').select('id, feature, tool').eq('run_id', d2.run_id).maybeSingle()
    check('follow-up resumes the approved run → submit_quote ran the ORDINARY route: quote row with munshi_draft_id = draft, draft approved with result_ref.quote_id, ai_decisions (munshi_draft, submit_quote), run completed', f1.status === 'ok' && (f1 as any).detail.resumed >= 1 && !!q2row && (q2row as any).munshi_draft_id === d2.id && (q2row as any).price_paise === q2!.price_paise && d2b.status === 'approved' && d2b.result_ref?.quote_id === (q2row as any).id && (dec2row as any)?.feature === 'munshi_draft' && (dec2row as any)?.tool === 'submit_quote' && (await runRow(d2.run_id))?.status === 'completed', JSON.stringify({ f1: (f1 as any).detail, draft: d2b?.status, dec: dec2row }))
    const { data: pbq } = await admin.from('provider_price_book').select('id, source').eq('source_quote_id', (q2row as any)?.id ?? '00000000-0000-0000-0000-000000000000').maybeSingle()
    check('the approved quote wrote its own price-book row (source quote)', !!pbq && (pbq as any).source === 'quote')

    // ── a grant WITHOUT submit_quote → the proposal is refused; the draft is failed ─
    await admin.from('agent_grants').insert({ user_id: p2.uid, persona: 'provider', scopes: ['extract_requirements', 'read_price_book', 'draft_quote'], channel: 'web', channel_identity: null, consent: { locale: 'en', surface: 'rig', text_version: MUNSHI_CONSENT_TEXT_VERSION, at: new Date().toISOString() } })
    await admin.from('munshi_provider_state').upsert({ provider_id: p2.providerId, user_id: p2.uid, locale: 'en' }, { onConflict: 'provider_id' })
    const s5 = await scan()
    check('P2 with a grant lacking submit_quote is not enumerated (hasMunshiScopes false) — no run, no draft', s5.status === 'ok' && (s5 as any).detail.providers === 1 && (await draftsFor(p2.providerId)).length === 0, JSON.stringify((s5 as any).detail))
    // The single failure that would let Munshi act without consent: a grant WITHOUT submit_quote reaching the quote
    // route. Enumeration already refuses it (above); here the grant is narrowed AFTER a draft was proposed and the
    // provider approves — the resume re-reads the CURRENT grant's scopes and the runner refuses the tool before any
    // route call (the route's requireToolScope on the delegated token is the second lock, not driven here).
    const rfq5 = await mkRfq(`${tag} five`)
    const grantFor = (scopes: readonly string[]) => admin.from('agent_grants').insert({ user_id: p2.uid, persona: 'provider', scopes: [...scopes], channel: 'web', channel_identity: null, consent: { locale: 'en', surface: 'rig', text_version: MUNSHI_CONSENT_TEXT_VERSION, at: new Date().toISOString() } })
    await admin.from('agent_grants').update({ revoked_at: new Date().toISOString() }).eq('user_id', p2.uid).is('revoked_at', null)
    await grantFor(MUNSHI_SCOPES)
    await api(p2.token, '/api/v1/partner/price-book', { category_slug: 'tax-accounting', unit: 'job', price_paise: 300000, delivery_days: 7 })
    await scan()
    const d5 = (await draftsFor(p2.providerId, rfq5))[0]
    check('P2 with full scopes is drafted (proposed, parked on submit_quote)', !!d5 && d5.kind === 'quote' && d5.status === 'proposed' && (await runRow(d5.run_id))?.status === 'awaiting_confirmation', JSON.stringify(d5 ? [d5.kind, d5.status] : null))
    await admin.from('agent_grants').update({ revoked_at: new Date().toISOString() }).eq('user_id', p2.uid).is('revoked_at', null)
    await grantFor(['extract_requirements', 'read_price_book', 'draft_quote'])
    const list5 = ((await json(await api(p2.token, '/api/v1/agent/munshi/drafts', undefined, 'GET')))['drafts'] as any[] | undefined)?.find((d) => d.id === d5?.id)
    const dec5 = d5 ? await api(p2.token, `/api/v1/agent/runs/${d5.run_id}/decision`, { approve: true, final: list5?.payload ?? {}, input_refs: { munshi_draft_id: d5.id } }) : null
    if (dec5) await json(dec5)
    await followup()
    const d5b = d5 ? (await draftsFor(p2.providerId, rfq5))[0] : null
    const { data: q5 } = await admin.from('quotes').select('id').eq('rfq_id', rfq5).eq('provider_id', p2.providerId).maybeSingle()
    check('a grant narrowed after the proposal (no submit_quote) + the provider\'s approve → the resume refuses the tool (tool_out_of_scope) before any route call: NO quote, draft failed with the reason, run failed', !!d5 && dec5?.status === 200 && !q5 && d5b?.status === 'failed' && /tool_out_of_scope/.test(String(d5b?.result_ref?.error ?? '')) && (await runRow(d5.run_id))?.status === 'failed', JSON.stringify(d5b ? [d5b.status, d5b.result_ref] : null))
    skip('web 403 on a scoped delegated token', 'the HMAC token exchange is not driven here (no SUPABASE_JWT_SECRET / AGENT_RUNTIME_SECRET on this laptop); the runner refused the narrowed grant above and requireToolScope on the route is the S0.1-proven second lock')
    void rt

    // ── Edit: the composer submit with munshi_draft_id → draft edited, run declined ─
    const rfq6 = await mkRfq(`${tag} six`)
    await scan()
    const d6 = (await draftsFor(p1.providerId, rfq6))[0]
    const edited = await api(p1.token, `/api/v1/rfq/${rfq6}/quote`, { price_paise: 230000, delivery_days: 6, scope: SCOPE, munshi_draft_id: d6.id })
    const editedB = await json(edited)
    const d6b = (await draftsFor(p1.providerId, rfq6))[0]
    const { data: q6 } = await admin.from('quotes').select('munshi_draft_id, price_paise').eq('id', (editedB['quoteId'] as string) ?? '00000000-0000-0000-0000-000000000000').maybeSingle()
    check('Edit: the provider\'s own submit with munshi_draft_id → 200, quotes.munshi_draft_id set, draft edited (result_ref via composer), the parked run declined → cancelled', edited.status === 200 && (q6 as any)?.munshi_draft_id === d6.id && (q6 as any)?.price_paise === 230000 && d6b.status === 'edited' && d6b.result_ref?.via === 'composer' && (await runRow(d6.run_id))?.status === 'cancelled', JSON.stringify([edited.status, d6b?.status]))
    const cookiePage = await fetch(`${BASE}/partner/rfqs/${rfq6}?munshi=${d6.id}`, { headers: { cookie: cookie1 } })
    check('/partner/rfqs/[id]?munshi=<id> renders (an edited draft no longer prefills; the page is unchanged otherwise)', cookiePage.status === 200)
    const wrong = await api(p1.token, `/api/v1/rfq/${rfq6}/quote`, { price_paise: 1, delivery_days: 1, scope: SCOPE, munshi_draft_id: d2.id })
    await json(wrong)
    check('a munshi_draft_id for another RFQ / a closed draft → 422 munshi_draft_mismatch (or 409 already_quoted first)', wrong.status === 422 || wrong.status === 409, `status ${wrong.status}`)

    // ── approve on a request that closed meanwhile → expired ────────────────
    const rfq8 = await mkRfq(`${tag} eight`)
    await scan()
    const d8 = (await draftsFor(p1.providerId, rfq8))[0]
    const hand8 = await api(p1.token, `/api/v1/rfq/${rfq8}/quote`, { price_paise: 220000, delivery_days: 5, scope: SCOPE })
    await json(hand8)
    const list8 = ((await json(await api(p1.token, '/api/v1/agent/munshi/drafts', undefined, 'GET')))['drafts'] as any[]).find((d) => d.id === d8.id)
    const dec8 = await api(p1.token, `/api/v1/agent/runs/${d8.run_id}/decision`, { approve: true, final: list8?.payload ?? {}, input_refs: { munshi_draft_id: d8.id } })
    await json(dec8)
    await followup()
    const d8b = (await draftsFor(p1.providerId, rfq8))[0]
    check('approve after quoting by hand → the route answers 409 already_quoted → draft expired with the reason (no second quote)', hand8.status === 200 && dec8.status === 200 && d8b.status === 'expired' && d8b.result_ref?.error === 'already_quoted', JSON.stringify(d8b?.result_ref))

    // ── WhatsApp: opt-in widened, buttons delivered, approve by button ───────
    const { data: convRow } = await admin.from('wa_conversations').insert({ phone_e164: `91${p1.digits}`, user_id: p1.uid, locale: 'en', last_inbound_at: new Date().toISOString(), window_open_until: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }).select('id').single()
    const conv = convRow!.id as string
    created.convIds.push(conv)
    await admin.from('agent_grants').insert({ user_id: p1.uid, persona: 'provider', scopes: [], channel: 'whatsapp', channel_identity: `+91${p1.digits}`, consent: { locale: 'en', surface: 'whatsapp', keyword: 'START', text_version: 'v1', at: new Date().toISOString() } })
    const en1b2 = await json(await api(p1.token, '/api/v1/agent/munshi/enable', { locale: 'en', consent_text_version: MUNSHI_CONSENT_TEXT_VERSION }))
    check('re-enable widens the WhatsApp grant to MUNSHI_SCOPES (one consent screen, two channels)', en1b2['whatsapp_widened'] === true && (en1b2['grant'] as any)?.whatsapp === true, JSON.stringify(en1b2['grant']))
    const rfq9 = await mkRfq(`${tag} nine`)
    await scan()
    const d9 = (await draftsFor(p1.providerId, rfq9))[0]
    const out9 = await outbound(conv)
    const btn9 = out9.find((m) => m.kind === 'button' && (m.payload?.buttons ?? []).includes(`approve:${d9.run_id}`))
    check('a proposed draft is delivered as WhatsApp buttons approve|edit|skip:<runId> inside the window; delivered.whatsapp recorded', !!btn9 && d9.delivered?.whatsapp === btn9.id, JSON.stringify(out9.map((m) => [m.kind, m.status])))
    let vendorSeq = 0
    async function say(m: { kind: 'text' | 'button' | 'audio'; body?: string | null; payload?: string; mediaRef?: string; mime?: string }) {
      const raw = m.kind === 'button' ? { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: m.payload, title: m.body ?? m.payload } } } : m.kind === 'text' ? { type: 'text', text: { body: m.body } } : { type: 'audio', audio: { id: 'stub' } }
      const { data, error } = await admin.from('wa_messages').insert({ conversation_id: conv, direction: 'in', vendor_message_id: `${tag}-${++vendorSeq}`, kind: m.kind, body: m.body ?? (m.kind === 'button' ? m.payload : null), media_ref: m.mediaRef ?? null, mime: m.mime ?? null, status: 'received', payload: raw }).select('id').single()
      if (error) throw new Error(`say: ${error.message}`)
      await admin.from('wa_conversations').update({ last_inbound_at: new Date().toISOString(), window_open_until: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }).eq('id', conv)
      await inbound.handleWaInbound(data!.id as string, hooks)
      return { id: data!.id as string, results: await drain() }
    }
    const tap9 = await say({ kind: 'button', payload: `approve:${d9.run_id}`, body: 'Approve' })
    const d9b = (await draftsFor(p1.providerId, rfq9))[0]
    const { data: q9 } = await admin.from('quotes').select('id, munshi_draft_id').eq('rfq_id', rfq9).eq('provider_id', p1.providerId).maybeSingle()
    const { data: dec9 } = await admin.from('ai_decisions').select('input_refs').eq('run_id', d9.run_id).maybeSingle()
    check('button approve → munshi.decide → decision route under the provider\'s token (input_refs wa_message_id) → in-process resume → quote created, draft approved, "sent" text back', tap9.results[0]?.status === 'ok' && tap9.results[0]?.detail?.outcome === 'approved' && d9b.status === 'approved' && (q9 as any)?.munshi_draft_id === d9.id && (dec9 as any)?.input_refs?.wa_message_id === tap9.id && (await outbound(conv)).some((m) => m.kind === 'text' && /quote is sent/.test(m.body ?? '')), JSON.stringify(tap9.results[0]))
    const replay = await say({ kind: 'button', payload: `approve:${d9.run_id}`, body: 'Approve' })
    check('a replayed Approve is harmless: "draft no longer open", no second quote', replay.results[0]?.detail?.outcome === 'draft_gone' && ((await admin.from('quotes').select('id', { count: 'exact', head: true }).eq('rfq_id', rfq9).eq('provider_id', p1.providerId)).count ?? 0) === 1)

    // ── text "yes" (allow-list) approves; "yes but…" → edit path; "hmm" → re-ask; a stub 'approve' never approves ─
    const rfq10 = await mkRfq(`${tag} ten`)
    await scan()
    const d10 = (await draftsFor(p1.providerId, rfq10))[0]
    const hmm = await say({ kind: 'text', body: 'hmm' })
    const decCount = async (runId: string) => (await admin.from('ai_decisions').select('id', { count: 'exact', head: true }).eq('run_id', runId)).count ?? 0
    check('"hmm" → classifier unclear → buttons re-sent, NO decision row', hmm.results[0]?.detail?.outcome === 'reask' && (await decCount(d10.run_id)) === 0 && (await outbound(conv)).filter((m) => m.kind === 'button' && (m.payload?.buttons ?? []).includes(`approve:${d10.run_id}`)).length >= 2, JSON.stringify(hmm.results[0]))
    deps.stubIntent = () => ({ intent: 'approve', edit_instructions: null })
    const maybe = await say({ kind: 'text', body: 'maybe' })
    check('a classifier that says approve for "maybe" still cannot approve: re-ask, NO decision row (the allow-list is the only approver)', maybe.results[0]?.detail?.outcome === 'reask' && (await decCount(d10.run_id)) === 0, JSON.stringify(maybe.results[0]))
    deps.stubIntent = () => ({ intent: 'edit', edit_instructions: 'price badha do 3000' })
    const editSay = await say({ kind: 'text', body: 'haan lekin price badha do' })
    const d10b = (await draftsFor(p1.providerId, rfq10))[0]
    check('"haan lekin price badha do" → edit path: decline (reason edited), draft edited, deep link with ?munshi= sent, NO approval decision', editSay.results[0]?.detail?.outcome === 'edited' && d10b.status === 'edited' && (await runRow(d10.run_id))?.status === 'cancelled' && (await outbound(conv)).some((m) => m.kind === 'text' && (m.body ?? '').includes(`?munshi=${d10.id}`)), JSON.stringify(editSay.results[0]))
    delete deps.stubIntent
    const rfq11 = await mkRfq(`${tag} eleven`)
    await scan()
    const d11 = (await draftsFor(p1.providerId, rfq11))[0]
    const yes = await say({ kind: 'text', body: 'haan bhej do' })
    const d11b = (await draftsFor(p1.providerId, rfq11))[0]
    check('"haan bhej do" (allow-list, Hindi) → approved without any model call: quote created, decision via whatsapp_text', yes.results[0]?.detail?.outcome === 'approved' && d11b.status === 'approved' && (await decCount(d11.run_id)) === 1, JSON.stringify(yes.results[0]))
    if (VOICE_STUB) {
      const rfq12 = await mkRfq(`${tag} twelve`)
      await scan()
      const d12 = (await draftsFor(p1.providerId, rfq12))[0]
      const wav = Buffer.alloc(44 + 8000)
      wav.write('RIFF', 0); wav.writeUInt32LE(36 + 8000, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(8000, 40)
      const path = `${conv}/${tag}-yes.wav`
      const { error: upErr } = await admin.storage.from(BUCKET).upload(path, wav, { contentType: 'audio/wav', upsert: true })
      if (upErr) skip('voice note approval', `upload failed: ${upErr.message}`)
      else {
        created.objects.push(path)
        const v = await say({ kind: 'audio', mediaRef: path, mime: 'audio/wav' })
        const d12b = (await draftsFor(p1.providerId, rfq12))[0]
        const { data: dec12 } = await admin.from('ai_decisions').select('input_refs').eq('run_id', d12.run_id).maybeSingle()
        const expectYes = isUnambiguousYes(VOICE_STUB, 'en')
        check(`voice note (STT stub transcript "${VOICE_STUB}") → ${expectYes ? 'approved via the allow-list with transcript_vendor recorded' : 'not approved (transcript is not an allow-listed yes)'}`, expectYes ? v.results[0]?.detail?.outcome === 'approved' && d12b.status === 'approved' && !!(dec12 as any)?.input_refs?.transcript_vendor : v.results[0]?.detail?.outcome !== 'approved' && d12b.status !== 'approved', JSON.stringify(v.results[0]))
      }
    } else skip('voice note approval', 'set VOICE_STUB_TRANSCRIPT on the server (e.g. "yes send it") to drive the STT stub')

    // ── follow-up: window warning once per match; expiry; reply draft ────────
    const rfq13 = await mkRfq(`${tag} thirteen`)
    await admin.from('rfq_matches').update({ notified_at: new Date(Date.now() - 43 * 3600 * 1000).toISOString() }).eq('rfq_id', rfq13).eq('provider_id', p1.providerId)
    await admin.from('munshi_provider_state').update({ last_scan_at: new Date().toISOString() }).eq('provider_id', p1.providerId) // keep the scan from drafting rfq13 (notified before the cursor)
    const f2 = await followup()
    const { data: st2 } = await admin.from('munshi_provider_state').select('munshi_reminders').eq('provider_id', p1.providerId).single()
    check('follow-up: a match 5 h from lapse (window 48 h, notified 43 h ago) → ONE warning (stub WhatsApp text + reminder keyed by rfq)', f2.status === 'ok' && (f2 as any).detail.warnings === 1 && !!(st2 as any)?.munshi_reminders?.[rfq13] && (await outbound(conv)).some((m) => m.kind === 'text' && /lapse/.test(m.body ?? '')), JSON.stringify((f2 as any).detail))
    const f3 = await followup()
    check('a second follow-up sends no second warning for the same match', f3.status === 'ok' && (f3 as any).detail.warnings === 0, JSON.stringify((f3 as any).detail))
    // expiry
    const rfq14 = await mkRfq(`${tag} fourteen`)
    await admin.from('munshi_provider_state').update({ last_scan_at: null }).eq('provider_id', p1.providerId)
    await scan()
    const d14 = (await draftsFor(p1.providerId, rfq14))[0]
    await admin.from('munshi_drafts').update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', d14.id)
    const f4 = await followup()
    const d14b = (await draftsFor(p1.providerId, rfq14))[0]
    check('expiry: a proposed draft past expires_at → expired, run cancelled', (f4 as any).detail.expired >= 1 && d14b.status === 'expired' && (await runRow(d14.run_id))?.status === 'cancelled', JSON.stringify((f4 as any).detail))
    // reply draft on the approved quote's thread (rfq9): a buyer message ≥ 2 h old
    const msg = await api(buyer.token, `/api/v1/quotes/${(q9 as any).id}/messages`, { body: 'Can you start from the October return?' })
    const msgB = await json(msg)
    await admin.from('messages').update({ created_at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() }).eq('id', (msgB['id'] as string) ?? '00000000-0000-0000-0000-000000000000')
    const f5 = await followup()
    const dr = (await draftsFor(p1.providerId)).find((d) => d.kind === 'reply' && d.quote_id === (q9 as any).id)
    check('follow-up: a buyer message 3 h old on my quote thread → a reply draft (kind reply, proposed, parked on reply_thread, delivered as buttons)', msg.status === 200 && (f5 as any).detail.replies === 1 && !!dr && dr.status === 'proposed' && (await runRow(dr.run_id))?.status === 'awaiting_confirmation' && (await outbound(conv)).some((m) => m.kind === 'button' && (m.payload?.buttons ?? []).includes(`approve:${dr.run_id}`)), JSON.stringify((f5 as any).detail))
    if (dr) {
      const tapR = await say({ kind: 'button', payload: `approve:${dr.run_id}`, body: 'Approve' })
      const drb = (await draftsFor(p1.providerId)).find((d) => d.id === dr.id)!
      const thread = await json(await api(p1.token, `/api/v1/quotes/${(q9 as any).id}/messages`, undefined, 'GET'))
      const mine = ((thread['messages'] as any[]) ?? []).filter((m) => m.mine)
      const { data: decR } = await admin.from('ai_decisions').select('feature, tool').eq('run_id', dr.run_id).maybeSingle()
      check('approve the reply → reply_thread ran the ordinary messages route under the token: my message posted, draft approved (result_ref.message_id), ai_decisions (munshi_reply, reply_thread)', tapR.results[0]?.detail?.outcome === 'approved' && drb.status === 'approved' && mine.length >= 1 && mine.some((m) => m.id === drb.result_ref?.message_id) && (decR as any)?.feature === 'munshi_reply' && (decR as any)?.tool === 'reply_thread', JSON.stringify([tapR.results[0], drb.result_ref, decR]))
      const f6 = await followup()
      check('no second reply draft while my reply is the last message', (f6 as any).detail.replies === 0)
    }

    // ── caps ────────────────────────────────────────────────────────────────
    const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10)
    await admin.from('munshi_provider_state').update({ drafts_today: 20, drafts_today_date: today }).eq('provider_id', p1.providerId)
    const rfq15 = await mkRfq(`${tag} fifteen`)
    const s15 = await scan()
    check('daily cap reached (20/20 today) → the scan drafts nothing for P1', s15.status === 'ok' && (await draftsFor(p1.providerId, rfq15)).length === 0 && (s15 as any).detail.runs === 0, JSON.stringify((s15 as any).detail))
    await admin.from('munshi_provider_state').update({ drafts_today: 0, drafts_today_date: today }).eq('provider_id', p1.providerId)
    skip('budget_run_paise_by_agent.munshi = 1 → child run fails cleanly', 'the keyless gateway reports zero cost so the cap is never crossed here; the breach → clean failure path is agent-core budget.test.ts + runner.test.ts')

    // ── STOP stops WhatsApp delivery; web drafts continue. Disable stops the scan. ─
    const stop = await say({ kind: 'text', body: 'STOP' })
    void stop
    const { data: waGrant } = await admin.from('agent_grants').select('id').eq('user_id', p1.uid).eq('channel', 'whatsapp').is('revoked_at', null).maybeSingle()
    const rfq16 = await mkRfq(`${tag} sixteen`)
    const outBefore = (await outbound(conv)).length
    await scan()
    const d16 = (await draftsFor(p1.providerId, rfq16))[0]
    check('WhatsApp STOP → the WhatsApp grant is revoked; the next draft is still proposed (web grant) but NOT delivered on WhatsApp', !waGrant && !!d16 && d16.status === 'proposed' && !d16.delivered?.whatsapp && (await outbound(conv)).length === outBefore, JSON.stringify(d16?.delivered))
    const dis = await api(p1.token, '/api/v1/agent/munshi/disable', {})
    const disB = await json(dis)
    const rfq17 = await mkRfq(`${tag} seventeen`)
    const s17 = await scan()
    check('POST /agent/munshi/disable → web grant revoked, enabled=false; the next scan skips P1 (no run, no draft)', dis.status === 200 && disB['enabled'] === false && s17.status === 'ok' && (s17 as any).detail.providers === 0 && (await draftsFor(p1.providerId, rfq17)).length === 0, JSON.stringify((s17 as any).detail))

    // ── admin tile + the metric ──────────────────────────────────────────────
    const adminU = await mkUser('admin', ['admin'])
    const stats = await api(adminU.token, '/api/v1/agent/admin/munshi/stats', undefined, 'GET')
    const statsB = await json(stats)
    check('GET /agent/admin/munshi/stats (admin) → week counts incl. approved ≥ 3, providers_enabled, exit metric shape', stats.status === 200 && ((statsB['week'] as any)?.approved ?? 0) >= 3 && typeof statsB['providers_enabled'] === 'number' && 'exit_metric_pct' in statsB, JSON.stringify(statsB).slice(0, 160))
    const statsP = await api(p1.token, '/api/v1/agent/admin/munshi/stats', undefined, 'GET')
    await json(statsP)
    check('the admin stats route refuses a provider (403)', statsP.status === 403, `status ${statsP.status}`)
    skip('accepted-quote metric via the simulated checkout', 'quote acceptance is the Phase 5 / S1.3 rigs\' leg; finalizeQuoteAcceptance now also sets provider_price_book.accepted_at (typechecked; exercised when a Munshi quote is accepted in pilot)')
    skip('pg-boss queues + HMAC token exchange + runtime webhook + in-app notify (AMC-Runtime credential)', 'runtime driven in-process on this laptop (no SUPABASE_JWT_SECRET / AGENT_RUNTIME_SECRET; never start the runtime against prod) — S0.1/S0.5/S1.4-proven legs')
  } finally {
    // ── cleanup (zero residue; CHECKED, FK-ordered) ──────────────────────────
    const errors: string[] = []
    const del = async (label: string, q: PromiseLike<{ error: { message: string } | null }>) => { const { error } = await q; if (error && !/Could not find the table|does not exist/.test(error.message)) errors.push(`${label}: ${error.message}`) }
    try {
      const users = created.users
      const NIL = '00000000-0000-0000-0000-000000000000'
      const rfqIds = created.rfqIds.length ? created.rfqIds : [NIL]
      const pids = created.providerIds.length ? created.providerIds : [NIL]
      const { data: qs } = await admin.from('quotes').select('id').in('rfq_id', rfqIds)
      const quoteIds = ((qs ?? []) as { id: string }[]).map((q) => q.id)
      if (quoteIds.length) {
        const { data: convs } = await admin.from('conversations').select('id').eq('context_type', 'quote').in('context_id', quoteIds)
        const convIds = ((convs ?? []) as { id: string }[]).map((c) => c.id)
        if (convIds.length) {
          await del('messages', admin.from('messages').delete().in('conversation_id', convIds))
          await del('conversations', admin.from('conversations').delete().in('id', convIds))
        }
        await del('quote_events', admin.from('quote_events').delete().in('quote_id', quoteIds))
        await del('price_book(quote)', admin.from('provider_price_book').delete().in('source_quote_id', quoteIds))
      }
      await del('price_book(provider)', admin.from('provider_price_book').delete().in('provider_id', pids))
      // the quotes ↔ munshi_drafts FK cycle (quotes.munshi_draft_id / munshi_drafts.quote_id): null both sides first
      await del('quotes.munshi_draft_id=null', admin.from('quotes').update({ munshi_draft_id: null }).in('rfq_id', rfqIds))
      await del('drafts.quote_id=null', admin.from('munshi_drafts').update({ quote_id: null }).in('provider_id', pids))
      await del('quotes', admin.from('quotes').delete().in('rfq_id', rfqIds))
      await del('munshi_drafts', admin.from('munshi_drafts').delete().in('provider_id', pids))
      await del('munshi_state', admin.from('munshi_provider_state').delete().in('provider_id', pids))
      await del('rfq_clarifications', admin.from('rfq_clarifications').delete().in('rfq_id', rfqIds))
      await del('rfq_matches', admin.from('rfq_matches').delete().in('rfq_id', rfqIds))
      await del('rfq_intake', admin.from('rfq_intake_extractions').delete().in('rfq_id', rfqIds))
      await del('rfqs', admin.from('rfqs').delete().in('id', rfqIds))
      if (users.length) {
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
        if (created.convIds.length) {
          await del('wa_messages', admin.from('wa_messages').delete().in('conversation_id', created.convIds))
          await del('wa_conversations', admin.from('wa_conversations').delete().in('id', created.convIds))
        }
        await del('grants', admin.from('agent_grants').delete().in('user_id', users))
        // ADR-030: STOP wrote the phone's consent state (the append-only events stay as evidence, user_id nulled)
        await del('wa_phone_consents', admin.from('wa_phone_consents').delete().in('user_id', users))
        await del('notifications', admin.from('notifications').delete().in('user_id', users))
        await del('audit', admin.from('audit_logs').delete().in('actor_id', users))
        await del('provider_categories', admin.from('provider_categories').delete().in('provider_id', pids))
        await del('provider_profiles', admin.from('provider_profiles').delete().in('id', pids))
        await del('msme_profiles', admin.from('msme_profiles').delete().in('user_id', users))
      }
      if (created.objects.length) {
        const { error } = await admin.storage.from(BUCKET).remove(created.objects)
        if (error) errors.push(`storage: ${error.message}`)
      }
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
        for (const [table, col] of [['agent_runs', 'user_id'], ['ai_decisions', 'decided_by'], ['ai_invocations', 'user_id'], ['agent_grants', 'user_id'], ['provider_profiles', 'user_id'], ['msme_profiles', 'user_id'], ['munshi_drafts', 'user_id'], ['munshi_provider_state', 'user_id']] as const) {
          const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true }).in(col, created.users)
          if (count && !error) residue.push(`${table}=${count}`)
        }
      }
      if (created.rfqIds.length) {
        for (const table of ['rfqs', 'quotes'] as const) {
          const { count } = await admin.from(table).select('*', { count: 'exact', head: true }).in(table === 'rfqs' ? 'id' : 'rfq_id', created.rfqIds)
          if (count) residue.push(`${table}=${count}`)
        }
      }
      if (created.convIds.length) {
        const { count } = await admin.from('wa_conversations').select('id', { count: 'exact', head: true }).in('id', created.convIds)
        if (count) residue.push(`wa_conversations=${count}`)
        for (const convId of created.convIds) {
          const { data: objs, error } = await admin.storage.from(BUCKET).list(convId)
          if (error) residue.push(`storage(${convId.slice(0, 8)}):${error.message}`)
          else if ((objs ?? []).length) residue.push(`storage(${convId.slice(0, 8)})=${objs!.length}`)
        }
      }
      if (errors.length) record('cleanup', 'FAIL', errors.join(' | '))
      else check(`cleanup: zero residue incl. storage (${created.users.length} users, ${created.rfqIds.length} RFQs, ${created.convIds.length} conversations, ${created.objects.length} objects removed and recounted, settings restored)`, residue.length === 0, residue.join(', '))
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
