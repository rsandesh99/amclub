/**
 * verify-onboarding — S1.6 Onboarding agent (verify-* convention; rig, service role).
 *
 * OFFLINE (always): the pure interview machine end to end in memory; copy
 *   completeness; strict draft schema; summary rendering; JOIN → 'onboard';
 *   the four templates; per-agent budget caps.
 * HTTP flag-OFF (BASE_URL, AGENT_ENABLED=false server): start + draft → 404;
 *   /profile/me.onboardingWhatsAppEnabled false; the wizard page renders
 *   WITHOUT the card; the cron route is wired and guarded.
 * HTTP flag-ON (AGENT_ENABLED=true server + NEXT_PUBLIC_SUPABASE_URL/ANON_KEY +
 *   SUPABASE_SERVICE_ROLE_KEY): the whole lifecycle. The runtime's turn function
 *   is driven IN-PROCESS (the same `runOnboardingTurn` + `handleWaInbound` the
 *   worker calls) with a stub WhatsApp driver and the stub gateway; inbound
 *   messages are wa_messages rows inserted in the Meta raw shape; the provider's
 *   OWN session token stands in for the delegated one (this laptop has no
 *   SUPABASE_JWT_SECRET / AGENT_RUNTIME_SECRET — the HMAC exchange and the
 *   pg-boss queue are S0.1/S1.4-proven and recorded as skips). Every fixture
 *   row is removed in finally with CHECKED, FK-ordered deletes; agent_settings
 *   are restored; zero residue is asserted.
 *
 * Run: [BASE_URL=<url>] pnpm --filter @amclub/web agents:verify:onboarding
 *   (flag-ON server: AGENT_ENABLED=true COLUMN_ENCRYPTION_KEY=<64 hex> CRON_SECRET=<x> PORT=3100 pnpm start)
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import {
  LEGAL_VERSIONS,
  ONBOARDING_MAX_DRAFTS,
  capabilityFactsFromDraft,
  onboardingCopyIds,
  onboardingCopy,
  onboardingDraftSchema,
  type OnboardingDraft,
} from '@amclub/shared'
import {
  classifyKeyword,
  createGateway,
  createRedisBudget,
  createSupabaseLedger,
  makeStubDriver,
  promptFor,
  renderDraftSummary,
  resolveCaps,
  stepMachine,
  templateFor,
  type MachineSession,
  type RedisLike,
  type RunAgentDeps,
} from '@amclub/agent-core'

const BASE = (process.env['BASE_URL'] || '').replace(/\/$/, '')
const SUPA_URL = process.env['NEXT_PUBLIC_SUPABASE_URL'] || ''
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] || ''
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY'] || ''
const CRON_SECRET = process.env['VERIFY_CRON_SECRET'] || ''
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
const uuid = () => crypto.randomUUID()

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── OFFLINE ──────────────────────────────────────────────────────────────────
function offline() {
  const session = (over: Partial<MachineSession> = {}): MachineSession => ({ id: 's', state: 'language', locale: 'en', answers: [], photo_refs: [], category_slugs: [], gstin: null, udyam: null, draft_run_id: null, draft_count: 0, revise_pending: false, ...over })
  let n = 0
  const msg = (kind: 'text' | 'button' | 'image' | 'audio', text: string | null, buttonPayload: string | null = null, mediaRef: string | null = null) => ({ messageId: `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`, kind, text, buttonPayload, mediaRef })
  let s = session()
  const step = (i: ReturnType<typeof msg>) => { const r = stepMachine(s, i); s = { ...s, ...r.patch, state: r.state } as MachineSession; return r }
  step(msg('button', 'हिंदी', 'lang:hi'))
  check('machine: language button → business_name in Hindi', s.state === 'business_name' && s.locale === 'hi')
  step(msg('text', 'Gupta Tax Consultants'))
  const bad = step(msg('text', '29ABC'))
  check('machine: bad GSTIN re-prompts, state unchanged', bad.state === 'gstin' && bad.outcome === 'reprompt')
  step(msg('text', '09ABCDE1234F1Z5'))
  step(msg('button', 'Skip', 'udyam:skip'))
  check('machine: SKIP on udyam → categories with udyam null', s.state === 'categories' && s.udyam === null)
  step(msg('button', 'x', 'cat:tax-accounting'))
  step(msg('button', 'x', 'cat:done'))
  check('machine: one category + Done → capabilities', s.state === 'capabilities' && s.category_slugs.join() === 'tax-accounting')
  const stt = step(msg('audio', null))
  check('machine: failed transcription asks to type instead', stt.outcome === 'reprompt' && s.state === 'capabilities')
  step(msg('text', 'GST returns for traders'))
  step(msg('audio', 'monthly GSTR-1 and 3B in Tally'))
  step(msg('text', 'teen hazaar mahina'))
  check('machine: 3 answers → photos', s.state === 'photos' && s.answers.filter((a) => a.step === 'capabilities').length === 3)
  step(msg('image', null, null, 'c/p1.jpg'))
  const done = step(msg('button', 'Done', 'photos:done'))
  check('machine: photo + Done → drafting with the draft action', s.state === 'drafting' && done.action === 'draft' && s.photo_refs.length === 1)
  s = { ...s, state: 'review', draft_run_id: 'run-1', draft_count: 1 }
  const yes = step(msg('text', 'yes'))
  check('machine: free text "yes" on review never confirms (buttons re-sent)', s.state === 'review' && yes.action === null && yes.replies.some((r) => r.type === 'buttons'))
  const conf = step(msg('button', 'ok', 'confirm:run-1'))
  check('machine: confirm:<runId> button → confirmed', conf.action === 'confirm' && conf.state === 'confirmed')
  const cap = stepMachine(session({ state: 'review', draft_run_id: 'r2', draft_count: ONBOARDING_MAX_DRAFTS }), msg('button', 'x', 'revise:r2'))
  check(`machine: revise after ${ONBOARDING_MAX_DRAFTS} drafts → cap hand-off`, cap.action === 'cap_handoff' && cap.state === 'handed_off')

  const ids = onboardingCopyIds()
  const bare = ids.filter((id) => ['en', 'hi', 'te'].some((l) => !onboardingCopy(id, l as any, { name: 'x', max: 1, n: 1, total: 1, category: 'c', question: 'q', fields: 'f', link: 'l', display_name: 'a', legal_name: 'b', city: 'c', state: 'd', languages: 'e', categories: 'f', about: 'g', title: 't', scope: 's', deliverables: 'd', price: 'p', days: 1 }).trim()))
  check(`copy: ${ids.length} message ids present in en/hi/te`, bare.length === 0, bare.join(','))
  check('schema: strict draft rejects verified/status/approved keys', !onboardingDraftSchema.safeParse({ profile: { display_name: 'A B', legal_name: null, about: null, city: null, state: null, languages: [], category_slugs: [], verified: true }, packages: [], uncertain_fields: [] }).success && !onboardingDraftSchema.safeParse({ profile: { display_name: 'A B', legal_name: null, about: null, city: null, state: null, languages: [], category_slugs: [] }, packages: [], uncertain_fields: [], status: 'active' }).success)
  const draft: OnboardingDraft = { profile: { display_name: 'Gupta Tax', legal_name: null, about: 'GST', city: null, state: 'UP', languages: ['hi'], category_slugs: ['tax-accounting'] }, packages: [{ category_slug: 'tax-accounting', title: 'Monthly GST', scope_included: ['GSTR-1'], deliverables: ['Filed'], price_paise: 300000, delivery_days: null }], uncertain_fields: [] }
  const summary = renderDraftSummary(draft, 'hi')
  check('render: summary in Hindi with ₹ from paise and "not stated"', summary.join('\n').includes('₹3,000') && summary.join('\n').includes('नहीं बताया') && summary.every((c) => c.length <= 1024))
  check('facts: one per scope/deliverable line', capabilityFactsFromDraft(draft, 'hi').length === 2)
  check("keywords: JOIN → 'onboard'; START still opt_in; STOP still opt_out", classifyKeyword('JOIN') === 'onboard' && classifyKeyword('START') === 'opt_in' && classifyKeyword('STOP') === 'opt_out')
  check('templates: the four onboarding kinds exist in te', ['onboarding_start', 'onboarding_resume', 'onboarding_draft_ready', 'onboarding_expired'].every((k) => templateFor(k, 'te')?.name.endsWith('_te')))
  check('budget: budget_run_paise_by_agent.onboarding overrides the global run cap', resolveCaps({ budget_run_paise: 2000, budget_run_paise_by_agent: { onboarding: 1500 } }, 'onboarding').runPaise === 1500 && resolveCaps({ budget_run_paise: 2000, budget_run_paise_by_agent: { onboarding: 1500 } }, 'rfq_quality').runPaise === 2000)
  check('welcome prompt carries the name and three language buttons', (promptFor('language', session(), { name: 'Ravi' })[0] as any).text.includes('Ravi') && (promptFor('language', session())[1] as any).buttons.length === 3)
}

// ── HTTP + lifecycle ─────────────────────────────────────────────────────────
async function http() {
  if (!BASE || !SUPA_URL || !ANON || !SERVICE) {
    skip('HTTP checks', 'set BASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
    return
  }
  const admin: SupabaseClient = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } })
  const tag = `kt_onb_${Date.now().toString(36)}`
  const created = { users: [] as string[], convIds: [] as string[], objects: [] as string[], providerIds: [] as string[] }
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
  const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '')
  const cookieFor = async (email: string) => {
    const jar: Record<string, string> = {}
    const ssr = createServerClient(SUPA_URL, ANON, { cookies: { getAll() { return Object.entries(jar).map(([name, value]) => ({ name, value })) }, setAll(l) { for (const { name, value } of l) jar[name] = value } } })
    await ssr.auth.signInWithPassword({ email, password: 'Test1234!' })
    return Object.entries(jar).map(([n, v]) => `${n}=${v}`).join('; ')
  }
  const sessionRow = async (id: string) => (await admin.from('onboarding_sessions').select('*').eq('id', id).single()).data as any
  const runRow = async (id: string) => (await admin.from('agent_runs').select('id, status, parent_run_id, surface, subject_type, subject_id, error').eq('id', id).single()).data as any
  const outbound = async (convId: string) => ((await admin.from('wa_messages').select('id, kind, body, template_name, status, payload, created_at').eq('conversation_id', convId).eq('direction', 'out').order('created_at', { ascending: true })).data ?? []) as any[]

  console.log(`\nverify-onboarding → ${BASE}\n`)
  const probe = await fetch(`${BASE}/api/v1/agent/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  await json(probe)
  const flagOn = probe.status !== 404

  try {
    const prov = await mkUser('prov', ['provider'])
    const other = await mkUser('other', ['provider'])

    // Cron route is wired and guarded whatever the flag.
    const cronNo = await fetch(`${BASE}/api/v1/cron/agent-onboarding-expire`)
    await json(cronNo)
    check('cron/agent-onboarding-expire refuses an unauthenticated call (403)', cronNo.status === 403, `status ${cronNo.status}`)
    if (CRON_SECRET) {
      const cronYes = await fetch(`${BASE}/api/v1/cron/agent-onboarding-expire`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } })
      const cb = await json(cronYes)
      check('cron/agent-onboarding-expire with the secret → 200, enqueue result honest (no runtime configured here)', cronYes.status === 200 && cb['enqueued'] === false, `status ${cronYes.status} ${JSON.stringify(cb)}`)
    } else skip('cron with secret', 'set VERIFY_CRON_SECRET (= the server CRON_SECRET)')

    if (!flagOn) {
      // ── inertness: the web surfaces do not exist ──
      const st = await api(prov.token, '/api/v1/agent/onboarding/start', {})
      await json(st)
      check('flag OFF: POST /agent/onboarding/start → 404', st.status === 404, `status ${st.status}`)
      const dr = await api(prov.token, '/api/v1/agent/onboarding/draft', undefined, 'GET')
      await json(dr)
      check('flag OFF: GET /agent/onboarding/draft → 404', dr.status === 404, `status ${dr.status}`)
      const me = await json(await api(prov.token, '/api/v1/profile/me', undefined, 'GET'))
      check('flag OFF: /profile/me.onboardingWhatsAppEnabled === false', me['onboardingWhatsAppEnabled'] === false)
      const cookie = await cookieFor(prov.email)
      const page = await fetch(`${BASE}/partner/onboarding`, { headers: { cookie } })
      const html = visible(await page.text())
      check('flag OFF: wizard page renders without the WhatsApp card', page.status === 200 && html.includes('Business details') && !html.includes('Finish on WhatsApp'), `status ${page.status}`)
      const { count: sessions } = await admin.from('onboarding_sessions').select('id', { count: 'exact', head: true }).in('user_id', created.users)
      check('flag OFF: no onboarding_sessions row was written', (sessions ?? 0) === 0)
      skip('flag ON lifecycle', 'server is dark (AGENT_ENABLED=false)')
      return
    }

    // ── flag ON ──────────────────────────────────────────────────────────────
    for (const k of ['agents_enabled', 'cohort_user_ids', 'budget_run_paise_by_agent', 'onboarding_session_ttl_hours']) await remember(k)
    const enabledBefore = (settingsBefore.get('agents_enabled')?.value ?? {}) as Record<string, boolean>
    const cohortBefore = (settingsBefore.get('cohort_user_ids')?.value ?? []) as string[]

    // Runtime modules in-process (the worker's own functions), with the runtime flag on.
    process.env['AGENT_ENABLED'] = 'true'
    process.env['API_URL'] = BASE
    process.env['WHATSAPP_DRIVER'] = 'stub'
    const rt = (await import('../../agent-runtime/src/agents/onboarding/index')) as typeof import('../../agent-runtime/src/agents/onboarding/index')
    const inbound = (await import('../../agent-runtime/src/whatsapp/inbound')) as typeof import('../../agent-runtime/src/whatsapp/inbound')
    const stubLog: string[] = []
    const whatsapp = makeStubDriver((l) => stubLog.push(l))
    const store = new Map<string, number>()
    const memRedis: RedisLike = {
      async incrby(k, v) { const n = (store.get(k) ?? 0) + v; store.set(k, n); return n },
      async expire() { return 1 },
      async mget<T = unknown>(...keys: string[]) { return keys.map((k) => (store.has(k) ? (store.get(k) as unknown as T) : null)) },
    }
    const tokens = new Map<string, string>()
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
    const deps = { core, admin, whatsapp, apiUrl: BASE, agentEnabled: true, tokenFor: async ({ userId }: { userId: string }) => tokens.get(userId) ?? '', mediaBucket: BUCKET, ttlHours: 72, capture: () => undefined }
    const queue: Array<{ kind: 'start' | 'message'; sessionId: string; messageId?: string }> = []
    const hooks = { enqueueOnboarding: async (t: { kind: 'start' | 'message'; sessionId: string; messageId?: string }) => { queue.push(t); return 'queued' } }
    const drain = async () => { const out: any[] = []; while (queue.length) { const t = queue.shift()!; out.push(await rt.runOnboardingTurn(deps as any, t)) } return out }

    async function conversationFor(u: { uid: string; digits: string }) {
      const { data, error } = await admin.from('wa_conversations').insert({ phone_e164: `91${u.digits}`, user_id: u.uid, locale: 'en', last_inbound_at: new Date().toISOString(), window_open_until: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }).select('id').single()
      if (error) throw new Error(`conversation: ${error.message}`)
      created.convIds.push(data!.id)
      return data!.id as string
    }
    let vendorSeq = 0
    async function say(convId: string, m: { kind: 'text' | 'button' | 'image' | 'audio'; body?: string | null; payload?: string; mediaRef?: string; mime?: string }) {
      const raw = m.kind === 'button'
        ? { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: m.payload, title: m.body ?? m.payload } } }
        : m.kind === 'text' ? { type: 'text', text: { body: m.body } } : { type: m.kind }
      const { data, error } = await admin.from('wa_messages').insert({ conversation_id: convId, direction: 'in', vendor_message_id: `${tag}-${++vendorSeq}`, kind: m.kind, body: m.body ?? (m.kind === 'button' ? m.payload : null), media_ref: m.mediaRef ?? null, mime: m.mime ?? null, status: 'received', payload: raw }).select('id').single()
      if (error) throw new Error(`wa_messages: ${error.message}`)
      await admin.from('wa_conversations').update({ last_inbound_at: new Date().toISOString(), window_open_until: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }).eq('id', convId)
      await inbound.handleWaInbound(data!.id as string, hooks)
      const results = await drain()
      return { messageId: data!.id as string, results }
    }
    async function upload(objPath: string, bytes: Uint8Array, contentType: string) {
      const up = await admin.storage.from(BUCKET).upload(objPath, bytes, { contentType, upsert: true })
      if (up.error) throw new Error(`upload ${objPath}: ${up.error.message}`)
      created.objects.push(objPath)
    }

    // Agent OFF (flag on): the web start 404s; JOIN from a granted provider is only the S0.5 path.
    await setSetting('agents_enabled', { ...enabledBefore, onboarding: false })
    await setSetting('cohort_user_ids', [...new Set([...cohortBefore, prov.uid, other.uid])])
    tokens.set(prov.uid, prov.token)
    tokens.set(other.uid, other.token)
    const offStart = await api(prov.token, '/api/v1/agent/onboarding/start', {})
    await json(offStart)
    check('agent OFF: POST start → 404', offStart.status === 404, `status ${offStart.status}`)
    const convP = await conversationFor(prov)
    const join1 = await say(convP, { kind: 'text', body: 'JOIN' })
    const { data: g1 } = await admin.from('agent_grants').select('id').eq('user_id', prov.uid).eq('channel', 'whatsapp').is('revoked_at', null)
    check('JOIN without a grant keeps the S0.5 meaning: opt-in grant created, no session', (g1?.length ?? 0) === 1 && join1.results.length === 0 && (await outbound(convP)).some((m) => m.template_name?.startsWith('amc_wa_opt_in')))
    const join2 = await say(convP, { kind: 'text', body: 'JOIN' })
    const { count: sess0 } = await admin.from('onboarding_sessions').select('id', { count: 'exact', head: true }).eq('user_id', prov.uid)
    check('agent OFF: JOIN with a grant → holding reply only, no session, no run', (sess0 ?? 0) === 0 && join2.results.length === 0 && (await outbound(convP)).some((m) => m.template_name?.startsWith('amc_wa_holding')))

    // Agent ON + cohort.
    await setSetting('agents_enabled', { ...enabledBefore, onboarding: true })
    const meOn = await json(await api(prov.token, '/api/v1/profile/me', undefined, 'GET'))
    check('agent ON: /profile/me.onboardingWhatsAppEnabled === true for the cohort provider', meOn['onboardingWhatsAppEnabled'] === true)
    const start = await api(prov.token, '/api/v1/agent/onboarding/start', {})
    const sb = await json(start)
    const sessionId = String(sb['sessionId'] ?? '')
    check('web start → 201 { sessionId, needsOptIn:false (granted), enqueued:false (no runtime configured here) }', start.status === 201 && !!sessionId && sb['needsOptIn'] === false && sb['enqueued'] === false, `status ${start.status} ${JSON.stringify(sb).slice(0, 160)}`)
    const s0 = await sessionRow(sessionId)
    check("session row: state 'language', surface whatsapp, no conversation yet, expires_at ≈ +72 h", s0?.state === 'language' && s0?.surface === 'whatsapp' && s0?.conversation_id === null && Math.abs(new Date(s0.expires_at).getTime() - Date.now() - 72 * 3600e3) < 120e3)
    const start2 = await api(prov.token, '/api/v1/agent/onboarding/start', {})
    const sb2 = await json(start2)
    check('second start → 409 session_active with the same id', start2.status === 409 && sb2['sessionId'] === sessionId, `status ${start2.status}`)
    const draft0 = await api(prov.token, '/api/v1/agent/onboarding/draft', undefined, 'GET')
    await json(draft0)
    check('GET draft before anything is confirmed → 404', draft0.status === 404, `status ${draft0.status}`)
    const cookieP = await cookieFor(prov.email)
    const page0 = visible(await (await fetch(`${BASE}/partner/onboarding`, { headers: { cookie: cookieP } })).text())
    check('wizard page renders WITH the "Finish on WhatsApp" card (flag + cohort)', page0.includes('Finish on WhatsApp') && page0.includes('Business details'))

    // JOIN attaches the web-started session and runs the start turn (root run + welcome).
    const join3 = await say(convP, { kind: 'text', body: 'JOIN' })
    const s1 = await sessionRow(sessionId)
    const conv1 = (await admin.from('wa_conversations').select('active_session_id').eq('id', convP).single()).data as any
    check('JOIN attaches the session to the conversation (active_session_id) and enqueues start', s1?.conversation_id === convP && conv1?.active_session_id === sessionId && join3.results[0]?.status === 'completed', JSON.stringify(join3.results[0]).slice(0, 120))
    const rootRunId = s1?.root_run_id as string | null
    const root = rootRunId ? await runRow(rootRunId) : null
    check('root run opened by the start turn (surface whatsapp, subject onboarding_session)', !!root && root.surface === 'whatsapp' && root.subject_type === 'onboarding_session' && root.subject_id === sessionId && root.status === 'completed')
    const out1 = await outbound(convP)
    check('welcome text + language buttons recorded as outbound wa_messages (session_id in payload)', out1.some((m) => m.kind === 'text' && String(m.body).includes('Welcome') && m.payload?.session_id === sessionId) && out1.some((m) => m.kind === 'button' && JSON.stringify(m.payload?.buttons) === JSON.stringify(['lang:en', 'lang:hi', 'lang:te'])))

    // The interview.
    const lang = await say(convP, { kind: 'button', payload: 'lang:en', body: 'English' })
    const s2 = await sessionRow(sessionId)
    const child = lang.results[0]?.runId ? await runRow(lang.results[0].runId) : null
    check("language button → business_name; the turn's run is a child of the root", s2?.state === 'business_name' && child?.parent_run_id === rootRunId)
    await say(convP, { kind: 'text', body: 'x' })
    check('too-short business name re-prompts (state unchanged)', (await sessionRow(sessionId))?.state === 'business_name')
    await say(convP, { kind: 'text', body: 'Kill Test Tax Services' })
    await say(convP, { kind: 'text', body: '29ABC' })
    check('bad GSTIN re-prompts (state gstin, gstin null)', (await sessionRow(sessionId))?.state === 'gstin' && (await sessionRow(sessionId))?.gstin === null)
    await say(convP, { kind: 'text', body: '29abcde1234f1z5' })
    check('good GSTIN → udyam (stored upper-cased)', (await sessionRow(sessionId))?.state === 'udyam' && (await sessionRow(sessionId))?.gstin === '29ABCDE1234F1Z5')
    await say(convP, { kind: 'button', payload: 'udyam:skip', body: 'Skip' })
    check('SKIP → categories', (await sessionRow(sessionId))?.state === 'categories')
    await say(convP, { kind: 'button', payload: 'cat:tax-accounting', body: 'Tax' })
    await say(convP, { kind: 'button', payload: 'cat:web-tech', body: 'Web' })
    await say(convP, { kind: 'button', payload: 'cat:done', body: 'Done' })
    const s3 = await sessionRow(sessionId)
    check('two categories + Done → capabilities', s3?.state === 'capabilities' && JSON.stringify(s3?.category_slugs) === JSON.stringify(['tax-accounting', 'web-tech']))
    // 6 answers: text ×4, one with a phone number (masked), one voice note (STT via the web route, keyless stub).
    await say(convP, { kind: 'text', body: 'GST returns and ITR for small traders in Bengaluru' })
    await say(convP, { kind: 'text', body: 'Monthly GSTR-1 and 3B in Tally, filed within five days; call me on 98765 43210 for details' })
    await say(convP, { kind: 'text', body: 'Two thousand five hundred per month' })
    const audioPath = `${convP}/${tag}-voice.ogg`
    await upload(audioPath, new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4]), 'audio/ogg')
    const voice = await say(convP, { kind: 'audio', mediaRef: audioPath, mime: 'audio/ogg; codecs=opus' })
    let s4 = await sessionRow(sessionId)
    const audioAnswer = (s4?.answers ?? []).find((a: any) => a.kind === 'audio')
    if (audioAnswer) check('voice note transcribed through POST /rfq/voice-parse (transcript_only) under the provider token; stored with transcript_vendor', audioAnswer.transcript_vendor === 'stub' && String(audioAnswer.text).length > 0, JSON.stringify(audioAnswer).slice(0, 120))
    else {
      check('voice note transcribed through POST /rfq/voice-parse (transcript_only)', false, `no audio answer stored — ${JSON.stringify(voice.results[0]).slice(0, 160)}`)
      await say(convP, { kind: 'text', body: 'WordPress sites for shops, five pages' })
    }
    await say(convP, { kind: 'text', body: 'Five page site in ten days with hosting' })
    await say(convP, { kind: 'text', body: 'Fifteen thousand for the site' })
    s4 = await sessionRow(sessionId)
    const masked = (s4?.answers ?? []).find((a: any) => a.redacted === true)
    check('an answer with a phone number is stored masked (redacted flag, no digits)', !!masked && String(masked.text).includes('[contact hidden]') && !String(masked.text).includes('98765'))
    check('9 → 6 answers (2 categories × 3) → photos', s4?.state === 'photos' && (s4?.answers ?? []).filter((a: any) => a.step === 'capabilities').length === 6)
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const p1 = `${convP}/${tag}-photo1.png`
    const p2 = `${convP}/${tag}-photo2.png`
    await upload(p1, png, 'image/png')
    await upload(p2, png, 'image/png')
    await say(convP, { kind: 'image', mediaRef: p1, mime: 'image/png' })
    await say(convP, { kind: 'image', mediaRef: p2, mime: 'image/png' })
    const invBefore = ((await admin.from('ai_invocations').select('id').eq('user_id', prov.uid).eq('task_class', 'onboarding_interview')).data ?? []).length
    const doneTurn = await say(convP, { kind: 'button', payload: 'photos:done', body: 'Done' })
    const s5 = await sessionRow(sessionId)
    const draftRun1 = s5?.draft_run_id as string | null
    const invs = ((await admin.from('ai_invocations').select('id, run_id, task_class, status').eq('user_id', prov.uid).eq('task_class', 'onboarding_interview')).data ?? []) as any[]
    check('two photos + Done → drafting → ONE model call (ai_invocations task_class onboarding_interview, run_id = the draft turn)', invs.length === invBefore + 1 && invs.some((i) => i.run_id === draftRun1) && doneTurn.results[0]?.status === 'awaiting_confirmation', `invocations ${invs.length}, turn ${doneTurn.results[0]?.status}`)
    const dr1 = draftRun1 ? await runRow(draftRun1) : null
    check('draft run parked awaiting_confirmation, child of the root; session in review with the draft stored (schema-valid, categories pinned)', dr1?.status === 'awaiting_confirmation' && dr1?.parent_run_id === rootRunId && s5?.state === 'review' && onboardingDraftSchema.safeParse(s5?.draft).success && JSON.stringify(s5?.draft?.profile?.category_slugs) === JSON.stringify(['tax-accounting', 'web-tech']) && s5?.photo_refs?.length === 2)
    const out5 = await outbound(convP)
    check('summary text + confirm/revise buttons sent (payload ids bound to the draft run)', out5.some((m) => m.kind === 'button' && JSON.stringify(m.payload?.buttons) === JSON.stringify([`confirm:${draftRun1}`, `revise:${draftRun1}`])) && out5.some((m) => m.kind === 'text' && String(m.body).includes('Kill Test Tax Services')))

    // Free text never confirms.
    const decBefore = ((await admin.from('ai_decisions').select('id').eq('decided_by', prov.uid)).data ?? []).length
    await say(convP, { kind: 'text', body: 'yes' })
    const out6 = await outbound(convP)
    check('free text "yes" on review → buttons re-sent, NO ai_decisions row', out6.filter((m) => m.kind === 'button' && JSON.stringify(m.payload?.buttons) === JSON.stringify([`confirm:${draftRun1}`, `revise:${draftRun1}`])).length >= 2 && ((await admin.from('ai_decisions').select('id').eq('decided_by', prov.uid)).data ?? []).length === decBefore && (await sessionRow(sessionId))?.state === 'review')

    // Revise → second draft.
    await say(convP, { kind: 'button', payload: `revise:${draftRun1}`, body: 'Change something' })
    const s6 = await sessionRow(sessionId)
    check('revise button: draft run cancelled, revise_pending, "what should change?" sent', s6?.revise_pending === true && (await runRow(draftRun1!))?.status === 'cancelled' && (await outbound(convP)).some((m) => String(m.body).includes('What should change')))
    await say(convP, { kind: 'text', body: 'make the web price twelve thousand' })
    const s7 = await sessionRow(sessionId)
    const draftRun2 = s7?.draft_run_id as string | null
    const invs2 = ((await admin.from('ai_invocations').select('id').eq('user_id', prov.uid).eq('task_class', 'onboarding_interview')).data ?? []).length
    check('revise note → second draft: second invocation, draft_count 2, new parked run, back in review', invs2 === invBefore + 2 && s7?.draft_count === 2 && !!draftRun2 && draftRun2 !== draftRun1 && s7?.state === 'review' && (await runRow(draftRun2!))?.status === 'awaiting_confirmation')

    // Confirm the second draft (button payload only).
    const { count: profilesBefore } = await admin.from('provider_profiles').select('id', { count: 'exact', head: true }).eq('user_id', prov.uid)
    const confirm = await say(convP, { kind: 'button', payload: `confirm:${draftRun2}`, body: 'Looks right' })
    const s8 = await sessionRow(sessionId)
    const decs = ((await admin.from('ai_decisions').select('id, feature, tool, run_id, input_refs, final').eq('decided_by', prov.uid)).data ?? []) as any[]
    const dec = decs.find((d) => d.run_id === draftRun2)
    check('confirm:<runId> → exactly one ai_decisions row (feature onboarding, tool confirm_onboarding_draft, run_id, input_refs.wa_message_id = the button row)', decs.length === decBefore + 1 && !!dec && dec.feature === 'onboarding' && dec.tool === 'confirm_onboarding_draft' && dec.input_refs?.wa_message_id === confirm.messageId && dec.input_refs?.session_id === sessionId, JSON.stringify(dec?.input_refs))
    check('draft run completed (resumed in-process: the web could not reach a runtime here); the local tool called no route', (await runRow(draftRun2!))?.status === 'completed' && ((await admin.from('agent_events').select('kind, payload').eq('run_id', draftRun2!).eq('kind', 'tool_called')).data ?? []).some((e: any) => e.payload?.local === true))
    const facts = ((await admin.from('provider_capability_facts').select('id, category_slug, fact, source_decision_id, source_session_id').eq('user_id', prov.uid)).data ?? []) as any[]
    check('provider_capability_facts written with the decision as provenance', facts.length > 0 && facts.every((f) => f.source_decision_id === dec?.id && f.source_session_id === sessionId), `facts ${facts.length}`)
    check('session: confirmed_at + draft_decision_id, then handed_off with the hand-off link sent; active_session_id cleared', s8?.state === 'handed_off' && !!s8?.confirmed_at && s8?.draft_decision_id === dec?.id && !!s8?.handed_off_at && (await outbound(convP)).some((m) => String(m.body).includes(`/partner/onboarding?session=${sessionId}`)) && ((await admin.from('wa_conversations').select('active_session_id').eq('id', convP).single()).data as any)?.active_session_id === null)
    const { count: profilesAfter } = await admin.from('provider_profiles').select('id', { count: 'exact', head: true }).eq('user_id', prov.uid)
    check('provider_profiles count unchanged by the agent (never creates a profile)', (profilesBefore ?? 0) === 0 && (profilesAfter ?? 0) === 0)
    const replay = await say(convP, { kind: 'button', payload: `confirm:${draftRun2}`, body: 'Looks right' })
    check('a replayed confirm on a terminal session is refused (session_terminal), nothing written', replay.results.length === 0 && ((await admin.from('ai_decisions').select('id').eq('decided_by', prov.uid)).data ?? []).length === decBefore + 1)

    // Wizard consumption.
    const dv = await api(prov.token, '/api/v1/agent/onboarding/draft', undefined, 'GET')
    const dvb = (await json(dv)) as any
    check('GET draft → the confirmed draft, redacted answers, 2 signed photo URLs, decisionId, gstin', dv.status === 200 && dvb.sessionId === sessionId && onboardingDraftSchema.safeParse(dvb.draft).success && dvb.decisionId === dec?.id && Array.isArray(dvb.photoUrls) && dvb.photoUrls.length === 2 && dvb.answers.some((a: any) => a.redacted && !String(a.text).includes('98765')) && dvb.gstin === '29ABCDE1234F1Z5', `status ${dv.status}`)
    const page1 = visible(await (await fetch(`${BASE}/partner/onboarding`, { headers: { cookie: cookieP } })).text())
    check('wizard page renders with the prefill chips and the prefilled display name', page1.includes('From your WhatsApp interview') && page1.includes('Kill Test Tax Services'))
    const foreign = await api(other.token, '/api/v1/profile/provider', { legalName: 'X Ltd', displayName: 'X', categorySlugs: ['web-tech'], state: 'KA', bankIfsc: 'HDFC0000001', bankAccount: '123456789012', bankHolder: 'X', onboardingSessionId: sessionId })
    await json(foreign)
    check("POST /profile/provider with another user's session id → 403 (before any write)", foreign.status === 403, `status ${foreign.status}`)
    await admin.from('terms_acceptances').insert((['terms', 'privacy', 'provider_addendum'] as const).map((doc) => ({ user_id: prov.uid, doc, version: LEGAL_VERSIONS[doc], payload: { surface: 'verify' } })))
    const submit = await api(prov.token, '/api/v1/profile/provider', { legalName: 'Kill Test Tax Services', displayName: 'Kill Test Tax Services', about: 'kill test', categorySlugs: ['web-tech'], state: 'KA', city: 'Bengaluru', languages: ['en'], bankIfsc: 'HDFC0000001', bankAccount: '123456789012', bankHolder: 'Kill Test', onboardingSessionId: sessionId })
    const subBody = (await json(submit)) as any
    let providerId: string | null = null
    if (submit.status === 200) {
      providerId = String(subBody.providerId)
      created.providerIds.push(providerId)
      check('POST /profile/provider with onboardingSessionId → profile created by the WIZARD route, session.provider_id linked', (await sessionRow(sessionId))?.provider_id === providerId)
    } else if (submit.status === 503 && subBody.error === 'bank_encryption_unconfigured') {
      skip('wizard submit links provider_id', 'local server has no COLUMN_ENCRYPTION_KEY (start it with a 64-hex dev key)')
    } else check('POST /profile/provider with onboardingSessionId', false, `status ${submit.status} ${JSON.stringify(subBody).slice(0, 160)}`)

    // Admin view.
    const adminU = await mkUser('admin', ['admin'])
    if (!providerId) {
      const { data: pp } = await admin.from('provider_profiles').insert({ user_id: prov.uid, legal_name: 'Kill Test Tax Services', display_name: 'Kill Test Tax Services', slug: `${tag}-prov`, state: 'KA', city: 'X', languages: ['en'], status: 'under_review' }).select('id').single()
      providerId = pp!.id
      created.providerIds.push(providerId!)
    }
    const adm = await api(adminU.token, `/api/v1/admin/providers/${providerId}`, undefined, 'GET')
    const ab = (await json(adm)) as any
    check('GET /admin/providers/[id] carries onboarding (redacted answers, 1 transcript, 2 signed photos, confirmed draft, decisionId)', adm.status === 200 && ab.onboarding?.session?.state === 'handed_off' && ab.onboarding?.answers?.some((a: any) => a.redacted && !String(a.text).includes('98765')) && ab.onboarding?.transcripts?.length === 1 && ab.onboarding?.photoUrls?.length === 2 && ab.onboarding?.draftConfirmed === true && ab.onboarding?.decisionId === dec?.id && ab.onboarding?.session?.gstinGiven === true && !JSON.stringify(ab.onboarding.session).includes('29ABCDE'), `status ${adm.status}`)

    // Session B (other): revise twice → cap hand-off without a confirmation.
    const convO = await conversationFor(other)
    await admin.from('agent_grants').insert({ user_id: other.uid, persona: 'provider', scopes: [], channel: 'whatsapp', channel_identity: `+91${other.digits}`, consent: { surface: 'verify', text_version: 'v1', at: new Date().toISOString() } })
    await say(convO, { kind: 'text', body: 'JOIN' })
    const sessB = ((await admin.from('onboarding_sessions').select('id').eq('user_id', other.uid).single()).data as any)?.id as string
    check('JOIN with a grant + agent on → a fresh session bound to the conversation', !!sessB && ((await admin.from('wa_conversations').select('active_session_id').eq('id', convO).single()).data as any)?.active_session_id === sessB)
    for (const m of [{ kind: 'button' as const, payload: 'lang:te', body: 'తెలుగు' }, { kind: 'text' as const, body: 'Kill Test Web Works' }, { kind: 'text' as const, body: '36ABCDE1234F1Z5' }, { kind: 'button' as const, payload: 'udyam:skip', body: 'Skip' }, { kind: 'text' as const, body: '7' }, { kind: 'button' as const, payload: 'cat:done', body: 'Done' }, { kind: 'text' as const, body: 'websites for shops' }, { kind: 'text' as const, body: 'five pages in a week' }, { kind: 'text' as const, body: 'ten thousand' }, { kind: 'button' as const, payload: 'photos:skip', body: 'Skip' }]) await say(convO, m)
    const b1 = await sessionRow(sessB)
    check('session B (Telugu, typed category number, no photos) reaches review with one draft', b1?.state === 'review' && b1?.locale === 'te' && b1?.draft_count === 1 && JSON.stringify(b1?.category_slugs) === JSON.stringify(['web-tech']))
    await say(convO, { kind: 'button', payload: `revise:${b1.draft_run_id}`, body: 'x' })
    await say(convO, { kind: 'text', body: 'title should say WordPress' })
    const b2 = await sessionRow(sessB)
    check('session B: second draft', b2?.draft_count === 2 && b2?.state === 'review')
    await say(convO, { kind: 'button', payload: `revise:${b2.draft_run_id}`, body: 'x' })
    const b3 = await sessionRow(sessB)
    check('session B: a third revise → handed_off with the cap noted, NO decision, active_session_id cleared', b3?.state === 'handed_off' && b3?.failure === 'revise_cap' && b3?.draft_decision_id === null && (await outbound(convO)).some((m) => String(m.body).includes('two drafts')) && ((await admin.from('wa_conversations').select('active_session_id').eq('id', convO).single()).data as any)?.active_session_id === null)
    const dvB = await api(other.token, '/api/v1/agent/onboarding/draft', undefined, 'GET')
    const dvBb = (await json(dvB)) as any
    check('GET draft for an unconfirmed hand-off → answers only, draft null', dvB.status === 200 && dvBb.draft === null && dvBb.answers.length > 0)

    // Budget: per-agent cap 0 → the draft turn fails cleanly.
    const prov3 = await mkUser('prov3', ['provider'])
    tokens.set(prov3.uid, prov3.token)
    await setSetting('cohort_user_ids', [...new Set([...cohortBefore, prov.uid, other.uid, prov3.uid])])
    await setSetting('budget_run_paise_by_agent', { onboarding: 0 })
    const conv3 = await conversationFor(prov3)
    await admin.from('agent_grants').insert({ user_id: prov3.uid, persona: 'provider', scopes: [], channel: 'whatsapp', channel_identity: `+91${prov3.digits}`, consent: { surface: 'verify', text_version: 'v1', at: new Date().toISOString() } })
    await say(conv3, { kind: 'text', body: 'JOIN' })
    const sess3 = ((await admin.from('onboarding_sessions').select('id').eq('user_id', prov3.uid).single()).data as any)?.id as string
    for (const m of [{ kind: 'button' as const, payload: 'lang:en', body: 'English' }, { kind: 'text' as const, body: 'Kill Test Budget Co' }, { kind: 'text' as const, body: '29ABCDE1234F1Z5' }, { kind: 'button' as const, payload: 'udyam:skip', body: 'Skip' }, { kind: 'button' as const, payload: 'cat:legal', body: 'Legal' }, { kind: 'button' as const, payload: 'cat:done', body: 'Done' }, { kind: 'text' as const, body: 'contracts and notices' }, { kind: 'text' as const, body: 'district court, English' }, { kind: 'text' as const, body: 'depends' }]) await say(conv3, m)
    const budgetTurn = await say(conv3, { kind: 'button', payload: 'photos:skip', body: 'Skip' })
    const c1 = await sessionRow(sess3)
    check('budget_run_paise_by_agent.onboarding = 0 → the draft turn fails cleanly (run failed budget_run_cap, state failed, answers kept, "continue on the website" sent)', budgetTurn.results[0]?.status === 'failed' && String(budgetTurn.results[0]?.error).startsWith('budget_run_cap') && c1?.state === 'failed' && c1?.failure === 'budget_run_cap' && (c1?.answers ?? []).length >= 6 && (await outbound(conv3)).some((m) => String(m.body).includes('continue on the website')), JSON.stringify(budgetTurn.results[0]).slice(0, 160))
    const inv3 = ((await admin.from('ai_invocations').select('id').eq('user_id', prov3.uid).eq('task_class', 'onboarding_interview')).data ?? []).length
    check('budget breach happened BEFORE the call: no ai_invocations row for the budget session', inv3 === 0)
    const dv3 = (await json(await api(prov3.token, '/api/v1/agent/onboarding/draft', undefined, 'GET'))) as any
    check('GET draft for the failed session → answers without a draft (the wizard prefill still works from answers)', dv3.draft === null && Array.isArray(dv3.answers) && dv3.answers.length >= 6)
    await setSetting('budget_run_paise_by_agent', settingsBefore.get('budget_run_paise_by_agent')?.existed ? settingsBefore.get('budget_run_paise_by_agent')!.value : {})

    // Expiry: an attached session past expires_at, out of window → abandoned + the expired template.
    const prov4 = await mkUser('prov4', ['provider'])
    tokens.set(prov4.uid, prov4.token)
    await setSetting('cohort_user_ids', [...new Set([...cohortBefore, prov.uid, other.uid, prov3.uid, prov4.uid])])
    const conv4 = await conversationFor(prov4)
    await admin.from('agent_grants').insert({ user_id: prov4.uid, persona: 'provider', scopes: [], channel: 'whatsapp', channel_identity: `+91${prov4.digits}`, consent: { surface: 'verify', text_version: 'v1', at: new Date().toISOString() } })
    await say(conv4, { kind: 'text', body: 'JOIN' })
    const sess4 = ((await admin.from('onboarding_sessions').select('id').eq('user_id', prov4.uid).single()).data as any)?.id as string
    await admin.from('onboarding_sessions').update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', sess4)
    await admin.from('wa_conversations').update({ window_open_until: new Date(Date.now() - 60_000).toISOString() }).eq('id', conv4)
    const expiredIds = await rt.listExpiredOnboardingSessions(admin)
    check('expiry job selection includes the aged session and not the live/terminal ones', expiredIds.includes(sess4) && !expiredIds.includes(sessionId) && !expiredIds.includes(sess3))
    const exp = await rt.runOnboardingTurn(deps as any, { kind: 'expire', sessionId: sess4 })
    const e1 = await sessionRow(sess4)
    check('expire turn → abandoned, amc_onboarding_expired_en template sent (out of window, grant present), active_session_id cleared', exp.status === 'completed' && e1?.state === 'abandoned' && (await outbound(conv4)).some((m) => m.template_name === 'amc_onboarding_expired_en') && ((await admin.from('wa_conversations').select('active_session_id').eq('id', conv4).single()).data as any)?.active_session_id === null, JSON.stringify(exp).slice(0, 120))
    const exp2 = await rt.runOnboardingTurn(deps as any, { kind: 'expire', sessionId: sess4 })
    check('a second expire turn is refused (session_terminal) with no run opened', exp2.status === 'failed' && exp2.error === 'session_terminal' && exp2.runId === null)
    skip('pg-boss queue + HMAC token exchange + runtime webhook', 'runtime driven in-process on this laptop (no SUPABASE_JWT_SECRET / AGENT_RUNTIME_SECRET; never start the runtime against prod) — S0.1/S0.5/S1.4-proven legs')
  } finally {
    // ── cleanup (zero residue; CHECKED, FK-ordered) ──────────────────────────
    const errors: string[] = []
    // Before 0036 is applied the two S1.6 tables do not exist on the DB (flag-off run): nothing can be there, so that error is not residue.
    const del = async (label: string, q: PromiseLike<{ error: { message: string } | null }>) => { const { error } = await q; if (error && !/Could not find the table/.test(error.message)) errors.push(`${label}: ${error.message}`) }
    try {
      const users = created.users
      if (users.length) {
        const { data: runs } = await admin.from('agent_runs').select('id').in('user_id', users)
        const runIds = ((runs ?? []) as { id: string }[]).map((r) => r.id)
        await del('facts', admin.from('provider_capability_facts').delete().in('user_id', users))
        await del('sessions', admin.from('onboarding_sessions').delete().in('user_id', users))
        await del('decisions', admin.from('ai_decisions').delete().in('decided_by', users))
        if (runIds.length) {
          await del('events', admin.from('agent_events').delete().in('run_id', runIds))
          await del('invocations(run)', admin.from('ai_invocations').delete().in('run_id', runIds))
        }
        await del('invocations(user)', admin.from('ai_invocations').delete().in('user_id', users))
        await del('runs', admin.from('agent_runs').delete().in('user_id', users))
        if (created.convIds.length) {
          await del('wa_messages', admin.from('wa_messages').delete().in('conversation_id', created.convIds))
          await del('wa_conversations', admin.from('wa_conversations').delete().in('id', created.convIds))
        }
        await del('grants', admin.from('agent_grants').delete().in('user_id', users))
        await del('terms', admin.from('terms_acceptances').delete().in('user_id', users))
        await del('notifications', admin.from('notifications').delete().in('user_id', users))
        await del('audit', admin.from('audit_logs').delete().in('actor_id', users))
        if (created.providerIds.length) {
          await del('bank', admin.from('provider_bank_accounts').delete().in('provider_id', created.providerIds))
          await del('verifications', admin.from('provider_verifications').delete().in('provider_id', created.providerIds))
          await del('categories', admin.from('provider_categories').delete().in('provider_id', created.providerIds))
          await del('profiles', admin.from('provider_profiles').delete().in('id', created.providerIds))
        }
        await del('profiles(user)', admin.from('provider_profiles').delete().in('user_id', users))
        await del('bank_verifications', admin.from('bank_account_verifications').delete().in('user_id', users))
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
      // Zero-residue assertion for this tag.
      const residue: string[] = []
      const { count: u } = await admin.from('users').select('id', { count: 'exact', head: true }).like('email', `${tag}%`)
      if (u) residue.push(`users=${u}`)
      if (created.users.length) {
        for (const [table, col] of [['onboarding_sessions', 'user_id'], ['provider_capability_facts', 'user_id'], ['agent_runs', 'user_id'], ['ai_decisions', 'decided_by'], ['ai_invocations', 'user_id'], ['agent_grants', 'user_id'], ['provider_profiles', 'user_id']] as const) {
          const { count } = await admin.from(table).select('*', { count: 'exact', head: true }).in(col, created.users)
          if (count) residue.push(`${table}=${count}`)
        }
      }
      if (created.convIds.length) {
        const { count } = await admin.from('wa_conversations').select('id', { count: 'exact', head: true }).in('id', created.convIds)
        if (count) residue.push(`wa_conversations=${count}`)
        // Storage: the uploaded objects (voice note, photos) must be gone too, not only the rows that reference them.
        for (const convId of created.convIds) {
          const { data: objs, error } = await admin.storage.from(BUCKET).list(convId)
          if (error) residue.push(`storage(${convId.slice(0, 8)}):${error.message}`)
          else if ((objs ?? []).length) residue.push(`storage(${convId.slice(0, 8)})=${objs!.length}`)
        }
      }
      if (errors.length) record('cleanup', 'FAIL', errors.join(' | '))
      else check(`cleanup: zero residue incl. storage (${created.users.length} users, ${created.convIds.length} conversations, ${created.objects.length} objects removed and recounted, settings restored)`, residue.length === 0, residue.join(', '))
    } catch (e) {
      record('cleanup', 'FAIL', (e as Error).message)
    }
  }
}

async function main() {
  offline()
  await http()
  console.log(`\nverify-onboarding ${BASE ? `→ ${BASE}` : '(offline)'}\n`)
  for (const r of rows) console.log(`  ${r.status === 'pass' ? '✓' : r.status === 'skip' ? '⏭' : '✗'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
  const skipped = rows.filter((r) => r.status === 'skip').length
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${rows.length} checks: ${rows.length - failed - skipped} pass, ${skipped} skipped, ${failed} FAIL\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 2
})
