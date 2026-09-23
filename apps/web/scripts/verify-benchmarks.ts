/**
 * verify-benchmarks.ts — fair price ranges (BUILD_PROMPTS S3.2, A3) against a running server on the prod DB.
 *
 *   offline  — the formula table (the brief fixture's rounded nearest-rank percentiles), each privacy gate failing
 *              alone, the share cap, the rounding boundaries, monotonicity on adversarial inputs, the line in four
 *              locales, a view schema with no id, the note policy on planted bad sentences.
 *   flag OFF — every benchmark switch off (the prod default): cron/benchmark-compute is a no-op heartbeat that writes
 *              nothing, the table is empty, the buyer and provider RFQ pages carry no benchmark markup and
 *              GET /rfq/[id] no `benchmark` field — even with rows present (display is its own switch).
 *   flag ON  — fixtures in the rig's OWN inactive test category: 40 paid services orders from 10 providers and 12
 *              buyers (Telangana) → one state row + one national row with the expected rounded percentiles and days;
 *              unpaid / cancelled / refunded / goods orders and quotes-only activity contribute nothing; a second run
 *              the same day changes nothing; 7 providers → both rows disappear on the next run (and come back); one
 *              provider at 30 % → gated; the row has no id or user column at all (service role, a stranger through
 *              RLS, anon gets nothing); display on → the buyer page, the provider page and GET /rfq/[id] carry the
 *              IDENTICAL line; a buyer in another state gets the "across India" line; a stranger gets 404; the note
 *              (AGENT_ENABLED server + agents_enabled.benchmark + cohort) falls back cleanly on a failure and the stub
 *              note passes the output policy.
 *
 * The compute is driven IN-PROCESS restricted to the rig's category (`onlyCategories`), never through the cron with the
 * switch on (that would compute every real category); the route is proven as a no-op wrapper flag-off. Needs
 * migration 0046 for everything but the offline laws and the flag-OFF page / API legs — recorded skips until applied.
 *
 * Every row it creates is tagged and deleted; the last row is the zero-residue recount.
 *
 * Run: BASE_URL=http://localhost:3100 VERIFY_CRON_SECRET=<server CRON_SECRET> pnpm --filter @amclub/web trust:verify:benchmarks
 */
import Module from 'node:module'
import path from 'node:path'
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import {
  AGENT_SETTING_DEFS,
  BENCHMARK_DEFAULT_GATES,
  BENCHMARK_LOCALES,
  BENCHMARK_VERSION,
  BENCHMARK_WINDOW_DAYS,
  benchmarkLine,
  benchmarkNoteViolations,
  benchmarkViewSchema,
  computeBenchmark,
  isGated,
  roundBenchmarkPaise,
  type BenchmarkInputRow,
  type BenchmarkView,
} from '@amclub/shared'

config({ path: path.resolve(__dirname, '../.env.local') })

const BASE = (process.env['BASE_URL'] || '').replace(/\/$/, '')
const SUPA_URL = process.env['NEXT_PUBLIC_SUPABASE_URL'] || ''
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] || ''
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY'] || ''
const CRON_SECRET = process.env['VERIFY_CRON_SECRET'] || ''
const NIL = '00000000-0000-0000-0000-000000000000'
const D = 86_400_000

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

const R = (rupees: number) => rupees * 100
const fixture = (n: number, providers: number, buyers: number, price: (i: number) => number): BenchmarkInputRow[] =>
  Array.from({ length: n }, (_, i) => ({ price_paise: price(i), provider_id: `p${i % providers}`, msme_id: `b${i % buyers}`, delivery_days: null }))

/** No column that could name or link a person, order or quote. */
const ID_LIKE = /(^|_)(id|ids|user|users|provider|buyer|msme|order|orders|quote|quotes|email|phone|name)$/

function offline() {
  const brief = computeBenchmark(fixture(40, 10, 12, (i) => R(18_000 + i * 250)))
  check('formula: the brief fixture (40 jobs, 10 providers, 12 buyers, ₹18,000 + i×₹250) → p25 ₹20,500 · p50 ₹23,000 · p75 ₹25,500 (nearest rank, rounded to ₹500)', !isGated(brief) && brief.p25_paise === R(20_500) && brief.p50_paise === R(23_000) && brief.p75_paise === R(25_500), JSON.stringify(brief))
  const g = (o: ReturnType<typeof computeBenchmark>) => (isGated(o) ? o.gated : 'passed')
  check('each gate fails alone: 29 jobs → sample · 7 providers → providers · 7 buyers → buyers', g(computeBenchmark(fixture(29, 10, 10, () => R(20_000)))) === 'sample' && g(computeBenchmark(fixture(40, 7, 12, () => R(20_000)))) === 'providers' && g(computeBenchmark(fixture(40, 10, 7, () => R(20_000)))) === 'buyers')
  const dominant = fixture(40, 10, 12, () => R(20_000)).map((r, i) => (i < 12 ? { ...r, provider_id: 'dominant' } : { ...r, provider_id: `p${i % 9}` }))
  const at25 = fixture(40, 10, 12, () => R(20_000)).map((r, i) => (i < 10 ? { ...r, provider_id: 'big' } : { ...r, provider_id: `p${i % 9}` }))
  check('share cap: one provider at 30 % of 40 → provider_share; exactly 25 % passes', g(computeBenchmark(dominant)) === 'provider_share' && g(computeBenchmark(at25)) === 'passed')
  check('rounding boundaries: ₹4,349 → ₹4,300 · ₹9,999 → ₹10,000 · ₹18,250 → ₹18,500 · ₹99,750 → ₹1,00,000 · ₹1,00,500 → ₹1,01,000 · ₹30 → ₹100', roundBenchmarkPaise(R(4_349)) === R(4_300) && roundBenchmarkPaise(R(9_999)) === R(10_000) && roundBenchmarkPaise(R(18_250)) === R(18_500) && roundBenchmarkPaise(R(99_750)) === R(1_00_000) && roundBenchmarkPaise(R(1_00_500)) === R(1_01_000) && roundBenchmarkPaise(R(30)) === R(100))
  let mono = true
  for (const price of [(i: number) => (i % 2 ? R(9_990) : R(10_010)), (i: number) => R(60_000 - i * 1_000), (i: number) => (i === 39 ? R(9_00_00_000) : R(15_000))]) {
    const o = computeBenchmark(fixture(40, 10, 12, price))
    if (isGated(o) || !(o.p25_paise <= o.p50_paise && o.p50_paise <= o.p75_paise)) mono = false
  }
  check('monotonic p25 ≤ p50 ≤ p75 on adversarial inputs (two clusters across a step boundary, reversed, one huge outlier)', mono)
  const view: BenchmarkView = { category_slug: 'tax-accounting', scope: 'state', state: 'TS', p25_paise: R(18_000), p50_paise: R(22_000), p75_paise: R(26_000), median_delivery_days: 7, p25_delivery_days: 5, p75_delivery_days: 9, sample_n: 34, providers_n: 11, computed_at: '2026-09-23T04:15:00Z', note: null }
  const lines = BENCHMARK_LOCALES.map((l) => benchmarkLine(view, l))
  check('the line in four locales: numbers, place and sample in each; English is the brief\'s sentence', lines[0] === 'Similar jobs in Telangana closed at ₹18,000–₹26,000, typically in 5–9 days (based on 34 paid jobs from 11 providers).' && lines.every((x) => x.includes('₹18,000') && x.includes('₹26,000') && x.includes('34') && x.includes('Telangana') && !/undefined|null/.test(x)), lines.join(' | '))
  check('the view schema is strict and has no id-like field', Object.keys(benchmarkViewSchema.shape).every((k) => !ID_LIKE.test(k)) && !benchmarkViewSchema.safeParse({ ...view, provider_id: 'x' }).success)
  check('the note policy refuses advice and invented numbers ("you should pay ₹20,000"), accepts a plain sentence', benchmarkNoteViolations('You should pay ₹20,000.', view).length === 2 && benchmarkNoteViolations('Most of the 34 similar jobs here were priced between ₹18,000 and ₹26,000.', view).length === 0)
  check('settings: compute + display default OFF; the gates can only be tightened', AGENT_SETTING_DEFS.benchmark_compute_enabled.default === false && AGENT_SETTING_DEFS.benchmark_display_enabled.default === false && !AGENT_SETTING_DEFS.benchmark_min_sample.schema.safeParse(29).success && !AGENT_SETTING_DEFS.benchmark_max_provider_share_bps.schema.safeParse(2600).success)
}

async function loadCompute(): Promise<null | typeof import('../lib/benchmarks/compute')> {
  try {
    const m = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string }
    const orig = m._resolveFilename
    const empty = path.join(path.dirname(require.resolve('server-only')), 'empty.js')
    m._resolveFilename = function (request: string, ...rest: unknown[]) {
      if (request === 'server-only') return empty
      return orig.call(this, request, ...rest)
    }
    return (await import('../lib/benchmarks/compute')) as typeof import('../lib/benchmarks/compute')
  } catch (e) {
    console.error('  (direct import of lib/benchmarks/compute not possible here:', (e as Error).message.split('\n')[0], ')')
    return null
  }
}

async function http() {
  if (!BASE || !SUPA_URL || !ANON || !SERVICE) {
    skip('HTTP checks', 'set BASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
    return
  }
  const admin: SupabaseClient = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } })
  const stamp = Date.now().toString(36)
  const tag = `kt_bench_${stamp}`
  const TAG = tag.toUpperCase()
  const CAT_SLUG = `p7-kb${stamp}-cat`
  const created = { users: [] as string[], providerIds: [] as string[], msmeIds: [] as string[], rfqIds: [] as string[], orderIds: [] as string[], packageIds: [] as string[], categoryId: null as string | null }
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
  const { data: hbBefore } = await admin.from('cron_heartbeats').select('name, last_ok_at, last_result').eq('name', 'benchmark-compute').maybeSingle()
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
    return { uid: data.user.id, token: s.session!.access_token, email }
  }
  const api = (token: string, p: string) => fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${token}`, 'x-amc-locale': 'en' } })
  const cookieFor = async (email: string) => {
    const jar: Record<string, string> = {}
    const ssr = createServerClient(SUPA_URL, ANON, { cookies: { getAll() { return Object.entries(jar).map(([name, value]) => ({ name, value })) }, setAll(l) { for (const { name, value } of l) jar[name] = value } } })
    await ssr.auth.signInWithPassword({ email, password: 'Test1234!' })
    return Object.entries(jar).map(([n, v]) => `${n}=${v}`).join('; ')
  }
  const page = async (email: string, p: string) => {
    const r = await fetch(`${BASE}/en${p}`, { headers: { cookie: await cookieFor(email) } })
    return { status: r.status, html: await r.text() }
  }
  const missingRelation = (e: { message: string } | null | undefined) => !!e && /Could not find|does not exist|schema cache/.test(e.message)

  console.log(`\nverify-benchmarks → ${BASE}\n`)
  const probe = await fetch(`${BASE}/api/v1/agent/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  const probeBody = await json(probe)
  if (probe.status >= 500 && !(probe.status === 503 && probeBody['error'] === 'agent_not_configured')) {
    record('server probe', 'FAIL', `POST /api/v1/agent/token → ${probe.status}: the server is broken (env?)`)
    return
  }
  const agentOn = probe.status !== 404
  // a real select (a head count on a missing table returns an EMPTY error message — it would read as present)
  const t46 = await admin.from('price_benchmarks').select('category_slug').limit(1)
  const has0046 = !t46.error
  if (t46.error && !missingRelation(t46.error)) console.warn('  (price_benchmarks probe error:', t46.error.message, ')')
  const NEEDS_0046 = '0046 not applied on this DB yet — runs at the gate (after the migration, before the push)'
  const compute = has0046 ? await loadCompute() : null
  const benchRows = async () => ((await admin.from('price_benchmarks').select('*').eq('category_slug', CAT_SLUG).eq('version', BENCHMARK_VERSION)).data ?? []) as any[]
  const runCompute = () => compute!.computeBenchmarks(admin, { force: true, onlyCategories: [CAT_SLUG] })

  try {
    // ── fixtures: the rig's own inactive category, 10 providers + 12 buyers in Telangana, one draft package each ──
    const { data: cat, error: cErr } = await admin.from('categories').insert({ slug: CAT_SLUG, name_i18n: { en: 'P7 Test Cat' }, is_active: false }).select('id').single()
    if (cErr) throw new Error(`category: ${cErr.message}`)
    created.categoryId = cat!.id
    async function mkBuyer(label: string, state: string) {
      const u = await mkUser(label, ['msme'])
      const { data: m, error } = await admin.from('msme_profiles').insert({ user_id: u.uid, business_name: `${label} Co`, state, sector: 'services' }).select('id').single()
      if (error) throw new Error(`msme ${label}: ${error.message}`)
      created.msmeIds.push(m!.id)
      return { ...u, msmeId: m!.id as string }
    }
    async function mkProvider(label: string) {
      const u = await mkUser(label, ['provider'])
      const { data: p, error } = await admin.from('provider_profiles').insert({ user_id: u.uid, legal_name: `${label} Pvt`, display_name: `KT ${label}`, slug: `${tag}-${label}`, state: 'TS', status: 'active' }).select('id').single()
      if (error) throw new Error(`provider ${label}: ${error.message}`)
      created.providerIds.push(p!.id)
      await admin.from('provider_categories').insert({ provider_id: p!.id, category_id: created.categoryId })
      const { data: pk, error: pkErr } = await admin.from('packages').insert({ provider_id: p!.id, category_id: created.categoryId, slug: `${tag}-${label}-pkg`, title_i18n: { en: 'KT bench package' }, scope_included: ['kill-test'], deliverables: ['kill-test'], price_paise: R(20_000), delivery_days: 7, status: 'draft' }).select('id').single()
      if (pkErr) throw new Error(`package ${label}: ${pkErr.message}`)
      created.packageIds.push(pk!.id)
      return { ...u, providerId: p!.id as string, packageId: pk!.id as string }
    }
    const providers = [] as Awaited<ReturnType<typeof mkProvider>>[]
    for (let i = 0; i < 10; i++) providers.push(await mkProvider(`p${i}`))
    const buyers = [] as Awaited<ReturnType<typeof mkBuyer>>[]
    for (let i = 0; i < 12; i++) buyers.push(await mkBuyer(`b${i}`, 'TS'))
    const buyerKA = await mkBuyer('bka', 'KA')
    const stranger = await mkBuyer('stranger', 'TS')
    const iso = (ms: number) => new Date(ms).toISOString()
    let orderSeq = 0
    async function mkOrder(msmeId: string, p: { providerId: string; packageId: string }, o: { pricePaise: number; status?: string; createdAt: number; paid?: 'captured' | 'refunded' | null; kind?: 'service' | 'goods'; deliverAfterDays?: number }) {
      const n = ++orderSeq
      const gst = Math.round(o.pricePaise * 0.18)
      const { data, error } = await admin.from('orders').insert({ order_number: `${TAG}-${n}`, msme_id: msmeId, provider_id: p.providerId, source: 'package', package_id: p.packageId, title: `Bench kill-test ${n}`, scope_snapshot: { items: ['kill-test'] }, price_paise: o.pricePaise, discount_paise: 0, gst_paise: gst, total_paise: o.pricePaise + gst, commission_bps: 500, commission_paise: Math.round(o.pricePaise * 0.05), provider_earning_paise: o.pricePaise - Math.round(o.pricePaise * 0.05), delivery_days: 7, status: o.status ?? 'completed', created_at: iso(o.createdAt), ...(o.kind ? { kind: o.kind } : {}) }).select('id').single()
      if (error) throw new Error(`order ${n}: ${error.message}`)
      created.orderIds.push(data!.id)
      if (o.paid !== null) {
        const { error: pErr } = await admin.from('payments').insert({ order_id: data!.id, amount_paise: o.pricePaise + gst, method: 'upi', status: o.paid ?? 'captured', idempotency_key: `${tag}-pay-${n}` })
        if (pErr) throw new Error(`payment ${n}: ${pErr.message}`)
      }
      if (o.deliverAfterDays != null) {
        const { error: eErr } = await admin.from('order_events').insert({ order_id: data!.id, event: 'deliver', created_at: iso(o.createdAt + o.deliverAfterDays * D), payload: { kill_test: true } })
        if (eErr) throw new Error(`deliver ${n}: ${eErr.message}`)
      }
      return data!.id as string
    }
    // the buyer's request in this category (open, fanned out, P0 matched) — the page / API subject
    async function mkRfq(msmeId: string, title: string) {
      const { data, error } = await admin.from('rfqs').insert({ msme_id: msmeId, category_id: created.categoryId, title, details: { additional_details: 'kill-test fixture' }, status: 'open', quote_count: 0, max_quotes: 7, fanout_at: iso(Date.now()), expires_at: iso(Date.now() + 3 * D) }).select('id').single()
      if (error) throw new Error(`rfq: ${error.message}`)
      created.rfqIds.push(data!.id)
      await admin.from('rfq_matches').insert({ rfq_id: data!.id, provider_id: providers[0]!.providerId, notified_at: iso(Date.now()) })
      return data!.id as string
    }
    const rfqTS = await mkRfq(buyers[0]!.msmeId, `${tag} TS request`)
    const rfqKA = await mkRfq(buyerKA.msmeId, `${tag} KA request`)

    // ── FLAG OFF: every switch off (the prod default) ──────────────────────
    await setSetting('benchmark_compute_enabled', false)
    await setSetting('benchmark_display_enabled', false)
    if (CRON_SECRET) {
      const before = has0046 ? ((await admin.from('price_benchmarks').select('category_slug', { count: 'exact', head: true })).count ?? 0) : 0
      const r = await fetch(`${BASE}/api/v1/cron/benchmark-compute`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } })
      const b = await json(r)
      const after = has0046 ? ((await admin.from('price_benchmarks').select('category_slug', { count: 'exact', head: true })).count ?? 0) : 0
      const { data: hb } = await admin.from('cron_heartbeats').select('last_result').eq('name', 'benchmark-compute').maybeSingle()
      check('flag OFF: cron/benchmark-compute → 200 { enabled: false }, writes nothing, records the no-op heartbeat', r.status === 200 && b['enabled'] === false && after === before && (hb as any)?.last_result?.enabled === false, `status ${r.status} ${JSON.stringify(b)} rows ${before}→${after}`)
    } else skip('flag OFF: cron/benchmark-compute no-op', 'set VERIFY_CRON_SECRET (= the server CRON_SECRET)')
    const noAuth = await fetch(`${BASE}/api/v1/cron/benchmark-compute`)
    check('the cron refuses a call without the cron secret (403)', noAuth.status === 403, `status ${noAuth.status}`)
    if (has0046) {
      const { count } = await admin.from('price_benchmarks').select('category_slug', { count: 'exact', head: true })
      check('flag OFF: price_benchmarks is empty (compute has never been switched on)', (count ?? 0) === 0, `rows ${count}`)
    } else skip('flag OFF: the table is empty', NEEDS_0046)
    const offPages = async (label: string) => {
      const bp = await page(buyers[0]!.email, `/app/rfq/${rfqTS}`)
      const pp = await page(providers[0]!.email, `/partner/rfqs/${rfqTS}`)
      const ab = await json(await api(buyers[0]!.token, `/api/v1/rfq/${rfqTS}`))
      const ap = await json(await api(providers[0]!.token, `/api/v1/rfq/${rfqTS}`))
      check(`flag OFF${label}: the buyer page and the provider page carry NO benchmark markup; GET /rfq/[id] has NO benchmark field (buyer + provider)`, bp.status === 200 && pp.status === 200 && bp.html.includes(`${tag} TS request`) && pp.html.includes(`${tag} TS request`) && !bp.html.includes('benchmark-line') && !pp.html.includes('benchmark-line') && ab['role'] === 'buyer' && ap['role'] === 'provider' && !('benchmark' in ab) && !('benchmark' in ap), JSON.stringify({ bp: bp.status, pp: pp.status, ab: Object.keys(ab), ap: Object.keys(ap) }))
    }
    await offPages('')

    if (!has0046 || !compute) {
      for (const leg of ['flag ON: inputs, compute, gates, idempotency', 'flag ON: no id column (service role / stranger RLS / anon)', 'flag ON: display — the identical line on both pages and the API', 'flag ON: the note']) skip(leg, has0046 ? 'the compute library could not be loaded in-process' : NEEDS_0046)
      return
    }

    // ── FLAG ON: 40 paid services orders + the extras that must contribute nothing ──
    const T0 = Date.now() - 60 * D
    const paidIds: string[] = []
    for (let i = 0; i < 40; i++) paidIds.push(await mkOrder(buyers[i % 12]!.msmeId, providers[i % 10]!, { pricePaise: R(18_000 + i * 250), createdAt: T0 + i * 3_600_000, deliverAfterDays: 4.2 + (i % 5) }))
    await mkOrder(buyers[0]!.msmeId, providers[0]!, { pricePaise: R(1_000), createdAt: T0, paid: null })
    await mkOrder(buyers[1]!.msmeId, providers[1]!, { pricePaise: R(1_000), createdAt: T0, status: 'cancelled_by_buyer' })
    await mkOrder(buyers[2]!.msmeId, providers[2]!, { pricePaise: R(1_000), createdAt: T0, status: 'refunded', paid: 'refunded' })
    await mkOrder(buyers[3]!.msmeId, providers[3]!, { pricePaise: R(1_000), createdAt: T0, status: 'resolved_refund' })
    await mkOrder(buyers[4]!.msmeId, providers[4]!, { pricePaise: R(1_000), createdAt: T0, kind: 'goods' }).catch(() => null)
    await mkOrder(buyers[5]!.msmeId, providers[5]!, { pricePaise: R(1_000), createdAt: Date.now() - (BENCHMARK_WINDOW_DAYS + 5) * D })
    // quotes-only activity: submitted quotes at wild prices on an open request in this category
    const qRfq = await mkRfq(buyers[6]!.msmeId, `${tag} quotes only`)
    for (let i = 1; i <= 3; i++) await admin.from('quotes').insert({ rfq_id: qRfq, provider_id: providers[i]!.providerId, price_paise: R(9_99_000), delivery_days: 1, scope: 'kill-test quote, never an input', status: 'submitted' })
    const { data: inputs, error: inErr } = await admin.rpc('benchmark_inputs', { p_since: iso(Date.now() - BENCHMARK_WINDOW_DAYS * D) }).eq('category_slug', CAT_SLUG)
    const inRows = (inputs ?? []) as any[]
    check('inputs = exactly the 40 paid services orders: unpaid, cancelled, refunded, refund-resolved, goods, out-of-window orders and quotes-only activity contribute nothing', !inErr && inRows.length === 40 && inRows.every((r) => Number(r.price_paise) >= R(18_000) && r.state === 'TS'), inErr?.message ?? `n=${inRows.length}`)

    const r1 = await runCompute()
    const b1 = await benchRows()
    const st = b1.find((r) => r.scope === 'state')
    const na = b1.find((r) => r.scope === 'national')
    const expect = (r: any) => !!r && Number(r.p25_paise) === R(20_500) && Number(r.p50_paise) === R(23_000) && Number(r.p75_paise) === R(25_500) && r.p25_delivery_days === 6 && r.median_delivery_days === 7 && r.p75_delivery_days === 8 && r.sample_n === 40 && r.providers_n === 10 && r.buyers_n === 12 && r.window_days === BENCHMARK_WINDOW_DAYS
    check('compute → ONE state row (TS) and ONE national row: p25 ₹20,500 · p50 ₹23,000 · p75 ₹25,500, days 6 / 7 / 8, 40 jobs · 10 providers · 12 buyers', r1.enabled && r1.rows_written === 2 && b1.length === 2 && expect(st) && st?.state === 'TS' && expect(na) && na?.state === null, JSON.stringify({ r1, rows: b1.map((r) => [r.scope, r.state, r.p25_paise, r.p50_paise, r.p75_paise, r.p25_delivery_days, r.median_delivery_days, r.p75_delivery_days, r.sample_n]) }))
    const r2 = await runCompute()
    const b2 = await benchRows()
    check('a second run the same day changes nothing (0 written, 2 unchanged, computed_at unchanged)', r2.rows_written === 0 && r2.unchanged === 2 && r2.deleted === 0 && b2.every((r) => b1.find((x) => x.scope === r.scope)?.computed_at === r.computed_at), JSON.stringify(r2))

    // the gates on the next run: 7 providers → gone; back; one provider at 30 % → gone; back
    const moved: { id: string; from: string }[] = []
    const { data: ords } = await admin.from('orders').select('id, provider_id').in('id', paidIds)
    const byProv = new Map<string, string[]>()
    for (const o of (ords ?? []) as any[]) byProv.set(o.provider_id, [...(byProv.get(o.provider_id) ?? []), o.id])
    const move = async (id: string, from: string, to: string) => { await admin.from('orders').update({ provider_id: to }).eq('id', id); moved.push({ id, from }) }
    const restore = async () => { for (const m of moved.splice(0)) await admin.from('orders').update({ provider_id: m.from }).eq('id', m.id) }
    for (let k = 7; k < 10; k++) for (const [j, id] of (byProv.get(providers[k]!.providerId) ?? []).entries()) await move(id, providers[k]!.providerId, providers[j % 3]!.providerId)
    const r3 = await runCompute()
    const b3 = await benchRows()
    check('drop to 7 providers → the next run deletes both rows (gated: providers)', r3.deleted === 2 && b3.length === 0 && (r3.gated_by_reason.providers ?? 0) === 2, JSON.stringify(r3))
    await restore()
    const r4 = await runCompute()
    check('back to 10 providers → the rows return the next run', r4.rows_written === 2 && (await benchRows()).length === 2, JSON.stringify(r4))
    for (let k = 1; k <= 8; k++) await move((byProv.get(providers[k]!.providerId) ?? [])[0]!, providers[k]!.providerId, providers[0]!.providerId)
    const r5 = await runCompute()
    check('one provider at 30 % of the sample (12 of 40, still 10 providers) → gated: provider_share, both rows gone', r5.deleted === 2 && (await benchRows()).length === 0 && (r5.gated_by_reason.provider_share ?? 0) === 2, JSON.stringify(r5))
    await restore()
    const r6 = await runCompute()
    const b6 = await benchRows()
    check('restored → the rows return with the same numbers', r6.rows_written === 2 && b6.length === 2 && expect(b6.find((r) => r.scope === 'state')), JSON.stringify(r6))

    // ── no id column, whoever reads ──
    const cols = Object.keys(b6[0] ?? {})
    const strangerClient = createClient(SUPA_URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${stranger.token}` } } })
    const { data: sRows, error: sErr } = await strangerClient.from('price_benchmarks').select('*').eq('category_slug', CAT_SLUG)
    const anonClient = createClient(SUPA_URL, ANON, { auth: { persistSession: false } })
    const { data: aRows } = await anonClient.from('price_benchmarks').select('*').eq('category_slug', CAT_SLUG)
    check('the row has NO id or user column at all: every column is an aggregate / key / timestamp (service role and a stranger through RLS read the same columns; anon reads nothing)', cols.length > 0 && cols.every((c) => !ID_LIKE.test(c)) && !sErr && (sRows ?? []).length === 2 && Object.keys((sRows ?? [])[0] ?? {}).every((c) => !ID_LIKE.test(c)) && (aRows ?? []).length === 0, JSON.stringify({ cols, stranger: (sRows ?? []).length, sErr: sErr?.message, anon: (aRows ?? []).length }))

    // ── display on: the same line on both sides ──
    await setSetting('benchmark_display_enabled', true)
    const want = benchmarkLine({ scope: 'state', state: 'TS', p25_paise: R(20_500), p75_paise: R(25_500), p25_delivery_days: 6, p75_delivery_days: 8, sample_n: 40, providers_n: 10 }, 'en')
    const bp = await page(buyers[0]!.email, `/app/rfq/${rfqTS}`)
    const pp = await page(providers[0]!.email, `/partner/rfqs/${rfqTS}`)
    const ab = await json(await api(buyers[0]!.token, `/api/v1/rfq/${rfqTS}`))
    const ap = await json(await api(providers[0]!.token, `/api/v1/rfq/${rfqTS}`))
    const vb = benchmarkViewSchema.safeParse(ab['benchmark'])
    const vp = benchmarkViewSchema.safeParse(ap['benchmark'])
    const same = vb.success && vp.success && JSON.stringify({ ...vb.data, note: null }) === JSON.stringify({ ...vp.data, note: null })
    check(`display ON: the buyer page (above the compare table) and the provider page (summary card) carry the IDENTICAL line — "${want}"`, bp.html.includes('benchmark-line') && pp.html.includes('benchmark-line') && bp.html.includes(want) && pp.html.includes(want), JSON.stringify({ buyer: bp.html.includes(want), provider: pp.html.includes(want) }))
    check('display ON: GET /rfq/[id] carries the SAME strict benchmark view for the buyer and the matched provider (no id in it)', same && vb.success && vb.data.scope === 'state' && vb.data.state === 'TS' && Object.keys(ab['benchmark'] as object).every((k) => !ID_LIKE.test(k)), JSON.stringify({ buyer: ab['benchmark'], provider: ap['benchmark'] }))
    const ka = await json(await api(buyerKA.token, `/api/v1/rfq/${rfqKA}`))
    const kaView = benchmarkViewSchema.safeParse(ka['benchmark'])
    const kaPage = await page(buyerKA.email, `/app/rfq/${rfqKA}`)
    check('a buyer in another state (KA, no KA row) gets the national row: "Similar jobs across India …"', kaView.success && kaView.data.scope === 'national' && kaPage.html.includes('Similar jobs across India closed at ₹20,500–₹25,500'), JSON.stringify(ka['benchmark']))
    const sr = await api(stranger.token, `/api/v1/rfq/${rfqTS}`)
    await sr.text()
    check('a stranger (not the buyer, not matched) gets 404 on the request — nothing extra', sr.status === 404, `status ${sr.status}`)

    // ── the optional note (AGENT_ENABLED + agents_enabled.benchmark + cohort) ──
    if (agentOn) {
      const { data: aeRow } = await admin.from('agent_settings').select('value').eq('key', 'agents_enabled').maybeSingle()
      await setSetting('agents_enabled', { ...(((aeRow as any)?.value ?? {}) as Record<string, boolean>), benchmark: true })
      const { data: coRow } = await admin.from('agent_settings').select('value').eq('key', 'cohort_user_ids').maybeSingle()
      await setSetting('cohort_user_ids', [...new Set([...(((coRow as any)?.value ?? []) as string[]), buyers[0]!.uid])])
      await setSetting('budget_run_paise', 0)
      const failNote = await json(await api(buyers[0]!.token, `/api/v1/rfq/${rfqTS}`))
      const fv = benchmarkViewSchema.safeParse(failNote['benchmark'])
      check('the note FAILS (budget_run_paise = 0 → the bounded call refuses) → note null, the fixed line still served', fv.success && fv.data.note === null && benchmarkLine(fv.data, 'en') === want, JSON.stringify(failNote['benchmark']))
      await setSetting('budget_run_paise', AGENT_SETTING_DEFS.budget_run_paise.default)
      const okNote = await json(await api(buyers[0]!.token, `/api/v1/rfq/${rfqTS}`))
      const ov = benchmarkViewSchema.safeParse(okNote['benchmark'])
      const note = ov.success ? ov.data.note : null
      const cached = ((await benchRows()).find((r) => r.scope === 'state')?.notes ?? null) as any
      check('the note (keyless stub) passes the output policy (only the row\'s numbers, no advice word) and is cached on the row for this computed_at', !!note && benchmarkNoteViolations(note, ov.success ? ov.data : ({} as BenchmarkView)).length === 0 && cached?.by_locale?.en === note && cached?.computed_at === (ov.success ? ov.data.computed_at : ''), JSON.stringify({ note, cached }))
      const provNote = await json(await api(providers[0]!.token, `/api/v1/rfq/${rfqTS}`))
      check('the provider (not in the cohort) gets no note — but the SAME numbers and line', benchmarkViewSchema.safeParse(provNote['benchmark']).success && (provNote['benchmark'] as any).note === null && (provNote['benchmark'] as any).p25_paise === R(20_500), JSON.stringify(provNote['benchmark']))
    } else skip('the note (benchmark_explain@v1 stub + the failure fallback)', 'the server is dark (AGENT_ENABLED off) — runs against the flag-on server')
    skip('cron/benchmark-compute with the switch ON', 'not called: it would compute every real category on this DB — the compute library ran in-process restricted to the rig\'s category; the route is the thin wrapper proven as the flag-OFF no-op')
    skip('live benchmark_explain', 'keyless gateway → the stub note; the live gate is eval --set benchmark_explain (≥ 90 %, 0 policy violations) once the key exists')
    void BENCHMARK_DEFAULT_GATES
  } catch (e) {
    record('lifecycle aborted', 'FAIL', (e as Error).message)
  } finally {
    // ── cleanup (zero residue; CHECKED) ──────────────────────────────────────
    const errors: string[] = []
    const del = async (label: string, q: PromiseLike<{ error: { message: string } | null }>) => { const { error } = await q; if (error && !/Could not find the table|does not exist|schema cache/.test(error.message)) errors.push(`${label}: ${error.message}`) }
    try {
      const users = created.users.length ? created.users : [NIL]
      const pids = created.providerIds.length ? created.providerIds : [NIL]
      const mids = created.msmeIds.length ? created.msmeIds : [NIL]
      const rfqIds = created.rfqIds.length ? created.rfqIds : [NIL]
      const orderIds = created.orderIds.length ? created.orderIds : [NIL]
      if (has0046) await del('price_benchmarks', admin.from('price_benchmarks').delete().eq('category_slug', CAT_SLUG))
      await del('order_events', admin.from('order_events').delete().in('order_id', orderIds))
      await del('payments', admin.from('payments').delete().in('order_id', orderIds))
      await del('orders', admin.from('orders').delete().in('id', orderIds))
      await del('quotes', admin.from('quotes').delete().in('rfq_id', rfqIds))
      await del('rfq_matches', admin.from('rfq_matches').delete().in('rfq_id', rfqIds))
      await del('rfqs', admin.from('rfqs').delete().in('id', rfqIds))
      for (const id of created.rfqIds) await del('notifications(link)', admin.from('notifications').delete().like('link', `%${id}%`))
      await del('notifications(user)', admin.from('notifications').delete().in('user_id', users))
      await del('invocations(user)', admin.from('ai_invocations').delete().in('user_id', users))
      await del('runs', admin.from('agent_runs').delete().in('user_id', users))
      await del('audit', admin.from('audit_logs').delete().in('actor_id', users))
      await del('packages', admin.from('packages').delete().in('provider_id', pids))
      await del('provider_categories', admin.from('provider_categories').delete().in('provider_id', pids))
      await del('provider_profiles', admin.from('provider_profiles').delete().in('id', pids))
      await del('msme_profiles', admin.from('msme_profiles').delete().in('id', mids))
      if (created.categoryId) await del('category', admin.from('categories').delete().eq('id', created.categoryId))
      for (const [key, before] of settingsBefore) {
        if (before.existed) await admin.from('agent_settings').upsert({ key, value: before.value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
        else await admin.from('agent_settings').delete().eq('key', key)
      }
      // the heartbeat the flag-off leg recorded: back to what it was (absent → absent)
      if (hbBefore) await admin.from('cron_heartbeats').upsert(hbBefore, { onConflict: 'name' })
      else await del('heartbeat', admin.from('cron_heartbeats').delete().eq('name', 'benchmark-compute'))
      for (const uid of created.users) {
        await del('users', admin.from('users').delete().eq('id', uid))
        const { error } = await admin.auth.admin.deleteUser(uid)
        if (error) errors.push(`auth ${uid}: ${error.message}`)
      }
      const residue: string[] = []
      const { count: u } = await admin.from('users').select('id', { count: 'exact', head: true }).like('email', `${tag}%`)
      if (u) residue.push(`users=${u}`)
      for (const [table, col, ids] of [['orders', 'id', orderIds], ['order_events', 'order_id', orderIds], ['payments', 'order_id', orderIds], ['rfqs', 'id', rfqIds], ['rfq_matches', 'rfq_id', rfqIds], ['quotes', 'rfq_id', rfqIds], ['notifications', 'user_id', users], ['agent_runs', 'user_id', users], ['ai_invocations', 'user_id', users], ['provider_profiles', 'id', pids], ['packages', 'provider_id', pids], ['msme_profiles', 'id', mids]] as const) {
        const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true }).in(col, [...ids])
        if (count && !error) residue.push(`${table}=${count}`)
      }
      const { count: cc } = await admin.from('categories').select('id', { count: 'exact', head: true }).eq('slug', CAT_SLUG)
      if (cc) residue.push(`categories=${cc}`)
      if (has0046) {
        const { count: bc } = await admin.from('price_benchmarks').select('category_slug', { count: 'exact', head: true }).eq('category_slug', CAT_SLUG)
        if (bc) residue.push(`price_benchmarks=${bc}`)
      }
      for (const key of ['benchmark_compute_enabled', 'benchmark_display_enabled', 'budget_run_paise']) {
        const before = settingsBefore.get(key)
        if (before && !before.existed) {
          const { data } = await admin.from('agent_settings').select('key').eq('key', key).maybeSingle()
          if (data) residue.push(`agent_settings.${key}`)
        }
      }
      if (errors.length) record('cleanup', 'FAIL', errors.join(' | '))
      else check(`cleanup: zero residue (${created.users.length} users, ${created.orderIds.length} orders, ${created.rfqIds.length} RFQs, the test category and its benchmark rows; settings + the heartbeat restored)`, residue.length === 0, residue.join(', '))
    } catch (e) {
      record('cleanup', 'FAIL', (e as Error).message)
    }
  }
}

async function main() {
  offline()
  await http()
  console.log('')
  for (const r of rows) console.log(`${r.status === 'pass' ? '✓' : r.status === 'skip' ? '⏭' : '✗'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
  const skipped = rows.filter((r) => r.status === 'skip').length
  console.log(`\n${rows.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`)
  process.exitCode = failed === 0 ? 0 : 1
}
main().catch((e) => { console.error(e); process.exitCode = 2 })
