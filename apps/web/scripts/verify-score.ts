/**
 * verify-score.ts — AMC Score v1 (BUILD_PROMPTS S2.4, ADR-010) against a running server on the prod DB.
 *
 *   offline  — the formula from fixtures (components, scores, gates → null, redistribution), exact paise for the
 *              reliability adjustment, ordering stability, tips + note + growth copy completeness.
 *   flag OFF — every score switch off (the prod default): cron/score-compute is a no-op heartbeat that writes nothing,
 *              GET /partner/score 404, compare orders by price (mode 'price', ids = the price order), and no buyer-
 *              reachable route or the public view carries a score field (assertNoScoreFields).
 *   flag ON  — fixtures with KNOWN answers (provider A 100, B 44, C below the gate; buyer X 100, Y 9): the compute
 *              (driven in-process, restricted to the fixtures) writes snapshots, today's history and gate events; a
 *              second run the same day changes nothing; RLS (a provider reads only their own row, never a buyer score;
 *              a buyer reads none); the card (B's weakest two + tips, C's gate, 404 for a buyer); the coaching note
 *              (null with Munshi off; the stub note passes the output policy with Munshi on); compare above the
 *              threshold → reliability [A, B] (B cheaper, lower score), below → price; no score field anywhere a buyer
 *              can reach; the admin block + stats; the Munshi growth nudge (one a week, priority order, STOP stops
 *              WhatsApp, disable stops everything).
 *
 * Needs migration 0044 for everything but the offline laws, the 404 and the price-order legs — recorded skips until
 * applied. Legs that need AGENT_ENABLED on the server (the note, the stats tile, the growth nudge) are recorded skips
 * against a dark server. The cron route is NOT called with the compute switch on: it would score every real
 * provider; the compute library is driven in-process restricted to the fixtures (`only`) and the route is proven as a
 * no-op wrapper flag-off.
 *
 * Every row it creates is tagged and deleted; the last row is the zero-residue recount.
 *
 * Run: BASE_URL=http://localhost:3100 VERIFY_CRON_SECRET=<server CRON_SECRET> [AGENT_RUNTIME_SECRET=<same throwaway as the server>] pnpm --filter @amclub/web trust:verify:score
 */
import Module from 'node:module'
import path from 'node:path'
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
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
  GROWTH_PROFILE_FIELDS,
  MUNSHI_SCOPES,
  QUOTE_STATUS,
  PROVIDER_COMPONENTS,
  SCORE_TIPS,
  SCORE_TIP_LOCALES,
  compareOrdering,
  growthNudgeLine,
  priceOrder,
  reliabilityAdjustedTotal,
  reliabilityOrder,
  scoreBuyer,
  scoreFieldPaths,
  scoreNoteProblems,
  scoreProvider,
  stubScoreNote,
  type OrderStatus,
  type QuoteStatus,
  type RfqStatus,
} from '@amclub/shared'

config({ path: path.resolve(__dirname, '../.env.local') })

const BASE = (process.env['BASE_URL'] || '').replace(/\/$/, '')
const SUPA_URL = process.env['NEXT_PUBLIC_SUPABASE_URL'] || ''
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] || ''
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY'] || ''
const CRON_SECRET = process.env['VERIFY_CRON_SECRET'] || ''
const RIG_RUNTIME_SECRET = process.env['AGENT_RUNTIME_SECRET'] || ''
const NIL = '00000000-0000-0000-0000-000000000000'
const H = 3600 * 1000
const D = 24 * H

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
  // the fixture design below, scored by the pure formula: the SAME numbers the flag-on leg must read back
  const a = scoreProvider({ response_samples: 4, median_response_hours: 1, delivered_orders: 4, on_time_deliveries: 4, completed_orders: 4, confirmed_by_buyer: 4, auto_accepted: 0, closed_orders: 4, disputes_at_fault: 0, matches_decided_or_closed: 4, matches_quoted: 4, matches_declined_with_reason: 0 })
  const b = scoreProvider({ response_samples: 4, median_response_hours: 48, delivered_orders: 4, on_time_deliveries: 2, completed_orders: 4, confirmed_by_buyer: 2, auto_accepted: 2, closed_orders: 5, disputes_at_fault: 1, matches_decided_or_closed: 6, matches_quoted: 4, matches_declined_with_reason: 0 })
  const c = scoreProvider({ response_samples: 0, median_response_hours: null, delivered_orders: 1, on_time_deliveries: 1, completed_orders: 1, confirmed_by_buyer: 1, auto_accepted: 0, closed_orders: 2, disputes_at_fault: 0, matches_decided_or_closed: 0, matches_quoted: 0, matches_declined_with_reason: 0 })
  check('formula: provider A (all 100) → 100', a.score === 100, String(a.score))
  check('formula: provider B → components 25 / 50 / 75 / 20 / 67, score 44 (25·25 + 25·50 + 20·75 + 20·20 + 10·66.7 = 44.4)', b.score === 44 && b.components.responsiveness.value === 25 && b.components.on_time.value === 50 && b.components.buyer_confirmation.value === 75 && b.components.dispute_record.value === 20 && b.components.decision_rate.value === 67, JSON.stringify(Object.fromEntries(PROVIDER_COMPONENTS.map((k) => [k, b.components[k].value]))) + ` → ${b.score}`)
  check('formula: provider C below the gate (2 closed, 0 response samples) → null, gated, components still computed', c.score === null && c.gated && c.components.on_time.value === 100, JSON.stringify(c.sample))
  const x = scoreBuyer({ confirmation_samples: 8, median_confirmation_hours: 12, rfqs_with_quotes: 8, rfqs_followed_through: 8, closed_orders: 9, disputes_unfounded: 0, checkout_subjects_decided: 0, checkout_subjects_paid: 0 })
  const y = scoreBuyer({ confirmation_samples: 1, median_confirmation_hours: 60, rfqs_with_quotes: 2, rfqs_followed_through: 0, closed_orders: 2, disputes_unfounded: 1, checkout_subjects_decided: 0, checkout_subjects_paid: 0 })
  check('formula: buyer X → 100 (payment component null, its weight redistributed)', x.score === 100 && x.components.payment_follow_through.value === null, String(x.score))
  check('formula: buyer Y → 25 / 0 / 0 → 9 (30·25 ÷ 80 = 9.4)', y.score === 9, String(y.score))
  check('reliabilityAdjustedTotal exact paise: ₹1,00,000 @ 90 → ₹1,01,500; ₹95,000 @ 40 → ₹1,03,550; null → the prior 60 (+6 %)', reliabilityAdjustedTotal(10_000_000, 90, { nullPrior: 60, kBps: 1500 }) === 10_150_000 && reliabilityAdjustedTotal(9_500_000, 40, { nullPrior: 60, kBps: 1500 }) === 10_355_000 && reliabilityAdjustedTotal(10_000_000, null, { nullPrior: 60, kBps: 1500 }) === 10_600_000)
  const q = [{ id: 'z', normalizedTotalPaise: 5, providerScore: 60 }, { id: 'y', normalizedTotalPaise: 5, providerScore: 60 }]
  check('ordering is stable (ties → total → id) whatever the input order; price order keeps input order on ties', reliabilityOrder(q, { nullPrior: 60, kBps: 1500 }).join() === 'y,z' && reliabilityOrder([...q].reverse(), { nullPrior: 60, kBps: 1500 }).join() === 'y,z' && priceOrder(q).join() === 'z,y')
  check('compareOrdering below the threshold / switch off → price, never a score in the result', compareOrdering(q, { enabled: false, thresholdPaise: 0, nullPrior: 60, kBps: 1500 }).mode === 'price' && scoreFieldPaths(compareOrdering(q, { enabled: true, thresholdPaise: 0, nullPrior: 60, kBps: 1500 })).length === 0)
  const holes: string[] = []
  for (const l of SCORE_TIP_LOCALES) for (const k of PROVIDER_COMPONENTS) if (!SCORE_TIPS[l][k] || /\d|\{/.test(SCORE_TIPS[l][k])) holes.push(`tip ${l}.${k}`)
  for (const l of SCORE_TIP_LOCALES) for (const k of [...PROVIDER_COMPONENTS, null] as const) if (scoreNoteProblems(stubScoreNote(l, k).note, []).length) holes.push(`note ${l}.${k}`)
  for (const l of SCORE_TIP_LOCALES) for (const field of GROWTH_PROFILE_FIELDS) if (/\{|undefined/.test(growthNudgeLine({ kind: 'profile_field', field }, l))) holes.push(`growth ${l}.${field}`)
  check('tips, stub notes and growth lines complete in en / hi / te / ta (no numbers in tips, no placeholders, stub notes pass their own rules)', holes.length === 0, holes.slice(0, 6).join(', '))
}

/** Import a web server lib outside Next: `server-only` resolves to its empty build (the S1.5 rig's trick). */
async function loadCompute(): Promise<null | typeof import('../lib/score/compute')> {
  try {
    const m = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string }
    const orig = m._resolveFilename
    const empty = path.join(path.dirname(require.resolve('server-only')), 'empty.js')
    m._resolveFilename = function (request: string, ...rest: unknown[]) {
      if (request === 'server-only') return empty
      return orig.call(this, request, ...rest)
    }
    return (await import('../lib/score/compute')) as typeof import('../lib/score/compute')
  } catch (e) {
    console.error('  (direct import of lib/score/compute not possible here:', (e as Error).message.split('\n')[0], ')')
    return null
  }
}

// ── http ─────────────────────────────────────────────────────────────────────

async function http() {
  if (!BASE || !SUPA_URL || !ANON || !SERVICE) {
    skip('HTTP checks', 'set BASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
    return
  }
  const admin: SupabaseClient = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } })
  const tag = `kt_score_${Date.now().toString(36)}`
  const TAG = tag.toUpperCase()
  const created = { users: [] as string[], providerIds: [] as string[], msmeIds: [] as string[], rfqIds: [] as string[], orderIds: [] as string[], convIds: [] as string[] }
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
  const { data: hbBefore } = await admin.from('cron_heartbeats').select('name, last_ok_at, last_result').eq('name', 'score-compute').maybeSingle()
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
  const api = (token: string | null, p: string, body?: unknown, method = 'GET') =>
    fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const asUser = (token: string) => createClient(SUPA_URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } } })
  const missingRelation = (e: { message: string } | null | undefined) => !!e && /Could not find|does not exist|schema cache/.test(e.message)

  console.log(`\nverify-score → ${BASE}\n`)
  const probe = await fetch(`${BASE}/api/v1/agent/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  const probeBody = await json(probe)
  if (probe.status >= 500 && !(probe.status === 503 && probeBody['error'] === 'agent_not_configured')) {
    record('server probe', 'FAIL', `POST /api/v1/agent/token → ${probe.status}: the server is broken (env?)`)
    return
  }
  const agentOn = probe.status !== 404
  // a real select (a head count on a missing table returns an EMPTY error message — it would read as present)
  const t44 = await admin.from('provider_scores').select('provider_id').limit(1)
  const has0044 = !t44.error
  if (t44.error && !missingRelation(t44.error)) console.warn('  (provider_scores probe error:', t44.error.message, ')')
  const NEEDS_0044 = '0044 not applied on this DB yet — runs at the gate (after the migration, before the push)'
  const NEEDS_AGENT = 'the server is dark (AGENT_ENABLED off) — runs against the flag-on server'
  const compute = has0044 ? await loadCompute() : null

  try {
    const { data: cats } = await admin.from('categories').select('id, slug').in('slug', ['tax-accounting', 'legal'])
    const catId = (slug: string) => ((cats ?? []) as { id: string; slug: string }[]).find((c) => c.slug === slug)!.id
    // ── fixtures ────────────────────────────────────────────────────────────
    async function mkBuyer(label: string, state = 'KA') {
      const u = await mkUser(label, ['msme'])
      const { data: m, error } = await admin.from('msme_profiles').insert({ user_id: u.uid, business_name: `${label} Co`, state, sector: 'services' }).select('id').single()
      if (error) throw new Error(`msme ${label}: ${error.message}`)
      created.msmeIds.push(m!.id)
      return { ...u, msmeId: m!.id as string }
    }
    async function mkProvider(label: string, state = 'KA') {
      const u = await mkUser(label, ['provider'])
      const { data: p, error } = await admin.from('provider_profiles').insert({ user_id: u.uid, legal_name: `${label} Pvt`, display_name: `KT ${label}`, slug: `${tag}-${label}`, state, status: 'active' }).select('id').single()
      if (error) throw new Error(`provider ${label}: ${error.message}`)
      created.providerIds.push(p!.id)
      await admin.from('provider_categories').insert({ provider_id: p!.id, category_id: catId('tax-accounting') })
      return { ...u, providerId: p!.id as string }
    }
    const T0 = Date.now() - 10 * D
    const iso = (ms: number) => new Date(ms).toISOString()
    let rfqSeq = 0
    async function mkRfq(msmeId: string, o: { status: RfqStatus; quoteCount: number; createdAt: number; category?: string; open?: boolean }) {
      const { data, error } = await admin.from('rfqs').insert({ msme_id: msmeId, category_id: catId(o.category ?? 'tax-accounting'), title: `${tag} rfq ${++rfqSeq}`, details: { additional_details: 'kill-test fixture' }, status: o.status, quote_count: o.quoteCount, max_quotes: 7, created_at: iso(o.createdAt), fanout_at: iso(o.createdAt), expires_at: iso(o.open ? Date.now() + 3 * D : o.createdAt + 3 * D) }).select('id').single()
      if (error) throw new Error(`rfq: ${error.message}`)
      created.rfqIds.push(data!.id)
      return data!.id as string
    }
    async function mkMatch(rfqId: string, providerId: string, notifiedAt: number, declined?: { at: number; reason: string }) {
      const { error } = await admin.from('rfq_matches').insert({ rfq_id: rfqId, provider_id: providerId, notified_at: iso(notifiedAt), ...(declined ? { declined_at: iso(declined.at), decline_reason: declined.reason } : {}) })
      if (error) throw new Error(`match: ${error.message}`)
    }
    async function mkQuote(rfqId: string, providerId: string, pricePaise: number, createdAt: number, status: QuoteStatus) {
      const { data, error } = await admin.from('quotes').insert({ rfq_id: rfqId, provider_id: providerId, price_paise: pricePaise, delivery_days: 5, scope: 'Monthly GST return filing for one GSTIN (kill-test fixture).', status, created_at: iso(createdAt) }).select('id').single()
      if (error) throw new Error(`quote: ${error.message}`)
      return data!.id as string
    }
    let orderSeq = 0
    async function mkOrder(msmeId: string, providerId: string, o: { status: OrderStatus; dueAt: number; completedAt?: number; createdAt: number }) {
      const n = ++orderSeq
      const { data, error } = await admin.from('orders').insert({ order_number: `${TAG}-${n}`, msme_id: msmeId, provider_id: providerId, source: 'package', title: `Score kill-test ${n}`, scope_snapshot: { items: ['kill-test'] }, price_paise: 1000000, discount_paise: 0, gst_paise: 180000, total_paise: 1180000, commission_bps: 500, commission_paise: 50000, provider_earning_paise: 950000, delivery_days: 5, status: o.status, due_at: iso(o.dueAt), created_at: iso(o.createdAt), ...(o.completedAt ? { completed_at: iso(o.completedAt) } : {}) }).select('id').single()
      if (error) throw new Error(`order ${n}: ${error.message}`)
      created.orderIds.push(data!.id)
      return data!.id as string
    }
    async function ev(orderId: string, event: string, at: number) {
      const { error } = await admin.from('order_events').insert({ order_id: orderId, event, created_at: iso(at), payload: { kill_test: true } })
      if (error) throw new Error(`event ${event}: ${error.message}`)
    }
    async function mkDispute(orderId: string, raisedBy: string, resolution: string, resolvedAt: number) {
      const { error } = await admin.from('disputes').insert({ order_id: orderId, raised_by: raisedBy, reason: 'quality', status: 'resolved', resolution, resolved_at: iso(resolvedAt), created_at: iso(resolvedAt - D) })
      if (error) throw new Error(`dispute: ${error.message}`)
    }

    const A = await mkProvider('a')
    const B = await mkProvider('b', 'LD')
    const C = await mkProvider('c')
    const X = await mkBuyer('x')
    const Y = await mkBuyer('y')
    const adminU = await mkUser('admin', ['admin'])

    // A: 4 quotes 1 h after the match; 4 orders on time, all confirmed by the buyer (X)
    // B: 4 quotes 48 h after; 2 window-lapsed matches on expired requests; 4 orders (2 late, 2 auto-accepted) + 1 refunded dispute
    for (const [p, hours] of [[A, 1], [B, 48]] as const) {
      for (let i = 0; i < 4; i++) {
        const t = T0 + i * H
        const r = await mkRfq(X.msmeId, { status: 'accepted', quoteCount: 1, createdAt: t })
        await mkMatch(r, p.providerId, t)
        await mkQuote(r, p.providerId, 1000000, t + hours * H, QUOTE_STATUS.accepted)
        const late = p === B && i < 2
        const auto = p === B && i >= 2
        const o = await mkOrder(X.msmeId, p.providerId, { status: 'completed', dueAt: t + 3 * D, createdAt: t + 2 * D, completedAt: t + 5 * D })
        const delivered = late ? t + 4 * D : t + 2.5 * D
        await ev(o, 'deliver', delivered)
        await ev(o, auto ? 'auto_accepted' : 'accept_delivery', delivered + (auto ? 72 : 12) * H)
      }
    }
    for (let i = 0; i < 2; i++) {
      const t = T0 + (10 + i) * H
      const r = await mkRfq(X.msmeId, { status: 'expired', quoteCount: 0, createdAt: t })
      await mkMatch(r, B.providerId, t, { at: t + 2 * D, reason: 'window_lapsed' })
    }
    const bDisputed = await mkOrder(X.msmeId, B.providerId, { status: 'resolved_refund', dueAt: T0 + 3 * D, createdAt: T0 + D })
    await mkDispute(bDisputed, X.uid, 'refund_full', T0 + 6 * D)
    // C with Y: one completed order confirmed after 60 h, one resolved in C's favour on a dispute Y raised (unfounded)
    const cDone = await mkOrder(Y.msmeId, C.providerId, { status: 'completed', dueAt: T0 + 3 * D, createdAt: T0 + D, completedAt: T0 + 6 * D })
    await ev(cDone, 'deliver', T0 + 2 * D)
    await ev(cDone, 'accept_delivery', T0 + 2 * D + 60 * H)
    const cDisputed = await mkOrder(Y.msmeId, C.providerId, { status: 'resolved_release', dueAt: T0 + 3 * D, createdAt: T0 + D })
    await mkDispute(cDisputed, Y.uid, 'release', T0 + 7 * D)
    for (let i = 0; i < 2; i++) await mkRfq(Y.msmeId, { status: 'expired', quoteCount: 1, createdAt: T0 + i * H })
    // compare fixtures: two open requests from X quoted by A and B — one above the ₹25,000 threshold, one below. Their
    // matches and quotes are dated OUTSIDE the 90-day window so they never move the scores the checks above expect.
    const OLD = Date.now() - 100 * D
    const rfqHi = await mkRfq(X.msmeId, { status: 'quoted', quoteCount: 2, createdAt: OLD, open: true })
    const rfqLo = await mkRfq(X.msmeId, { status: 'quoted', quoteCount: 2, createdAt: OLD, open: true })
    const q: Record<string, string> = {}
    for (const [r, key, pa, pb] of [[rfqHi, 'hi', 3_000_000, 2_900_000], [rfqLo, 'lo', 1_000_000, 950_000]] as const) {
      await mkMatch(r, A.providerId, OLD)
      await mkMatch(r, B.providerId, OLD)
      q[`${key}A`] = await mkQuote(r, A.providerId, pa, OLD + 4 * H, QUOTE_STATUS.submitted)
      q[`${key}B`] = await mkQuote(r, B.providerId, pb, OLD + 4 * H, QUOTE_STATUS.submitted)
    }

    // ── the privacy guard: no buyer-reachable payload carries a score field ──
    async function privacySweep(label: string) {
      const targets: [string, Promise<Response>][] = [
        [`GET /rfq/[id] (buyer)`, api(X.token, `/api/v1/rfq/${rfqHi}`)],
        [`GET /rfq/[id]/compare (buyer)`, api(X.token, `/api/v1/rfq/${rfqHi}/compare`)],
        ['GET /rfq/mine (buyer)', api(X.token, '/api/v1/rfq/mine')],
        ['GET /orders?role=msme (buyer)', api(X.token, '/api/v1/orders?role=msme')],
        ['GET /orders/[id] (buyer)', api(X.token, `/api/v1/orders/${bDisputed}`)],
        ['GET /profile/me (buyer)', api(X.token, '/api/v1/profile/me')],
        ['GET /catalog/provider/[slug] (public)', api(null, `/api/v1/catalog/provider/${tag}-b`)],
        ['GET /catalog/search (public)', api(null, '/api/v1/catalog/search?q=GST')],
      ]
      const leaks: string[] = []
      const statuses: string[] = []
      for (const [name, p] of targets) {
        const r = await p
        const body = await r.json().catch(() => null)
        statuses.push(`${name.split(' ')[1]}=${r.status}`)
        const hits = scoreFieldPaths(body)
        if (hits.length) leaks.push(`${name}: ${hits.slice(0, 3).join(', ')}`)
      }
      const { data: pub } = await createClient(SUPA_URL, ANON, { auth: { persistSession: false } }).from('public_providers').select('*').limit(50)
      const pubHits = scoreFieldPaths(pub ?? [])
      if (pubHits.length) leaks.push(`public_providers: ${pubHits.slice(0, 3).join(', ')}`)
      check(`${label}: no score / components / buyer-score field in any buyer-reachable payload (8 routes + the public_providers view)`, leaks.length === 0, leaks.join(' | ') || statuses.join(' '))
    }

    // ── flag OFF (every score switch off — the prod default) ────────────────
    for (const k of ['score_compute_enabled', 'score_card_enabled', 'reliability_rank_enabled', 'growth_nudge_enabled']) await setSetting(k, false)
    if (CRON_SECRET) {
      const before = has0044 ? (await admin.from('provider_scores').select('provider_id', { count: 'exact', head: true })).count ?? 0 : 0
      const r = await fetch(`${BASE}/api/v1/cron/score-compute`, { headers: { Authorization: `Bearer ${CRON_SECRET}` } })
      const b = await json(r)
      const after = has0044 ? (await admin.from('provider_scores').select('provider_id', { count: 'exact', head: true })).count ?? 0 : 0
      const { data: hb } = await admin.from('cron_heartbeats').select('last_result').eq('name', 'score-compute').maybeSingle()
      check('flag OFF: cron/score-compute → 200 { enabled: false }, writes no snapshot, records the no-op heartbeat', r.status === 200 && b['enabled'] === false && after === before && (hb as any)?.last_result?.enabled === false, `status ${r.status} ${JSON.stringify(b)} rows ${before}→${after}`)
    } else skip('flag OFF: cron/score-compute no-op', 'set VERIFY_CRON_SECRET (= the server CRON_SECRET)')
    const noAuth = await fetch(`${BASE}/api/v1/cron/score-compute`)
    await json(noAuth)
    check('cron/score-compute refuses an unauthenticated call (403)', noAuth.status === 403, `status ${noAuth.status}`)
    const card0 = await api(B.token, '/api/v1/partner/score')
    await json(card0)
    check('flag OFF: GET /partner/score → 404 (score_card_enabled off)', card0.status === 404, `status ${card0.status}`)
    const cmp0 = await json(await api(X.token, `/api/v1/rfq/${rfqHi}/compare`))
    check('flag OFF: compare above the threshold still orders by price (mode price; B cheaper first) — byte-identical to the price sort', (cmp0['ordering'] as any)?.mode === 'price' && ((cmp0['ordering'] as any)?.ids ?? []).join() === [q['hiB'], q['hiA']].join(), JSON.stringify(cmp0['ordering']))
    if (compute) {
      const r = await compute.computeScores(admin, { only: { providers: [A.providerId, B.providerId, C.providerId], buyers: [X.msmeId, Y.msmeId] } })
      check('flag OFF: computeScores is a no-op (enabled false, nothing written)', r.enabled === false && r.providers === 0, JSON.stringify(r))
    }
    await privacySweep('flag OFF')

    // ── flag ON ─────────────────────────────────────────────────────────────
    if (!has0044 || !compute) {
      skip('flag ON: compute, RLS, card, note, compare, admin, growth', !has0044 ? NEEDS_0044 : 'lib/score/compute could not be imported')
      return
    }
    await setSetting('score_compute_enabled', true)
    await setSetting('score_card_enabled', true)
    await setSetting('reliability_rank_enabled', true)
    await setSetting('reliability_rank_threshold_paise', 2_500_000)
    await setSetting('reliability_rank_k_bps', 1500)
    await setSetting('score_null_prior', 60)
    const only = { providers: [A.providerId, B.providerId, C.providerId], buyers: [X.msmeId, Y.msmeId] }
    const r1 = await compute.computeScores(admin, { only })
    const snap = async (table: 'provider_scores' | 'buyer_scores', idCol: string, id: string) => (await admin.from(table).select('score, gated, components, sample').eq(idCol, id).eq('score_version', 'v1').maybeSingle()).data as any
    const [sA, sB, sC, sX, sY] = await Promise.all([snap('provider_scores', 'provider_id', A.providerId), snap('provider_scores', 'provider_id', B.providerId), snap('provider_scores', 'provider_id', C.providerId), snap('buyer_scores', 'msme_id', X.msmeId), snap('buyer_scores', 'msme_id', Y.msmeId)])
    check('compute (SQL functions → the formula): A 100, B 44, C null (gated), X 100, Y 9 — exactly the offline answers', sA?.score === 100 && sB?.score === 44 && sC?.score === null && sC?.gated === true && sX?.score === 100 && sY?.score === 9, JSON.stringify({ A: sA?.score, B: sB?.score, C: [sC?.score, sC?.gated], X: sX?.score, Y: sY?.score, r1 }))
    check("B's components read back from the SQL counts: 25 / 50 / 75 / 20 / 67 with raw counts (e.g. on_time 2 of 4, dispute 1 at fault of 5 closed)", sB?.components?.responsiveness?.value === 25 && sB?.components?.on_time?.value === 50 && sB?.components?.buyer_confirmation?.value === 75 && sB?.components?.dispute_record?.value === 20 && sB?.components?.decision_rate?.value === 67 && sB?.components?.on_time?.raw?.on_time_deliveries === 2 && sB?.components?.dispute_record?.raw?.closed_orders === 5, JSON.stringify(sB?.components ?? null).slice(0, 240))
    const subjects = [A.providerId, B.providerId, C.providerId, X.msmeId, Y.msmeId]
    const histCount = async () => (await admin.from('score_history').select('id', { count: 'exact', head: true }).in('subject_id', subjects)).count ?? 0
    const evCount = async () => (await admin.from('score_events').select('id', { count: 'exact', head: true }).in('subject_id', subjects)).count ?? 0
    const h1 = await histCount()
    const e1 = await evCount()
    check('today\'s history: one row per subject (5); score_events: one gate event per subject that got a score (A, B, X, Y — not C)', h1 === 5 && e1 === 4 && r1.events === 4, `history ${h1}, events ${e1}`)
    const r2 = await compute.computeScores(admin, { only })
    check('a second run the same day changes nothing (0 changed, 0 events, history unchanged)', r2.changed === 0 && r2.events === 0 && (await histCount()) === h1 && (await evCount()) === e1, JSON.stringify(r2))
    const { error: upErr } = await admin.from('score_events').update({ delta: 99 }).in('subject_id', subjects)
    check('score_events is append-only (an UPDATE, even by the service role, is refused by the trigger)', !!upErr && /append-only/i.test(upErr.message), upErr?.message)

    // RLS
    const aRows = await asUser(A.token).from('provider_scores').select('provider_id')
    const aOnB = await asUser(A.token).from('provider_scores').select('provider_id').eq('provider_id', B.providerId)
    const aBuyers = await asUser(A.token).from('buyer_scores').select('msme_id')
    const xProv = await asUser(X.token).from('provider_scores').select('provider_id')
    const xBuy = await asUser(X.token).from('buyer_scores').select('msme_id')
    const adminProv = await asUser(adminU.token).from('provider_scores').select('provider_id').in('provider_id', only.providers)
    const adminBuy = await asUser(adminU.token).from('buyer_scores').select('msme_id').in('msme_id', only.buyers)
    check('RLS: provider A reads exactly its own row, 0 of B, 0 buyer scores; buyer X reads no provider score and no buyer score (not even its own); admin reads both sides', (aRows.data ?? []).length === 1 && (aRows.data as any[])[0].provider_id === A.providerId && (aOnB.data ?? []).length === 0 && (aBuyers.data ?? []).length === 0 && (xProv.data ?? []).length === 0 && (xBuy.data ?? []).length === 0 && (adminProv.data ?? []).length === 3 && (adminBuy.data ?? []).length === 2, JSON.stringify({ a: aRows.data?.length, aOnB: aOnB.data?.length, aBuy: aBuyers.data?.length, xP: xProv.data?.length, xB: xBuy.data?.length, admP: adminProv.data?.length, admB: adminBuy.data?.length }))
    const hRows = await asUser(A.token).from('score_history').select('subject_id').in('subject_id', subjects)
    check('RLS: provider A reads only its own history rows (never B\'s, never a buyer\'s)', (hRows.data ?? []).length === 1, `${hRows.data?.length}`)

    // the card
    const cardB = await json(await api(B.token, '/api/v1/partner/score?locale=en'))
    check("card (B): score 44, five components with weights, the two weakest (dispute_record 20, responsiveness 25) with their tips, gate have 5 closed, a trend point", cardB['score'] === 44 && (cardB['components'] as any[])?.length === 5 && ((cardB['weakest'] as string[]) ?? []).join() === 'dispute_record,responsiveness' && (cardB['tips'] as any[])?.length === 2 && (cardB['tips'] as any[])[0]?.text === SCORE_TIPS.en.dispute_record && (cardB['gate'] as any)?.have?.closed_orders === 5 && ((cardB['trend'] as any[]) ?? []).length >= 1, JSON.stringify({ s: cardB['score'], w: cardB['weakest'] }))
    const cardC = await json(await api(C.token, '/api/v1/partner/score'))
    check('card (C, below the gate): score null, gated, "2 of 3 closed orders" — never a number', cardC['score'] === null && cardC['gated'] === true && (cardC['gate'] as any)?.have?.closed_orders === 2 && (cardC['gate'] as any)?.needed?.closed_orders === 3, JSON.stringify(cardC['gate']))
    const cardX = await api(X.token, '/api/v1/partner/score')
    await json(cardX)
    check('card: a buyer (no provider profile) → 404', cardX.status === 404, `status ${cardX.status}`)
    check('coaching note: null while Munshi is off for B', cardB['note'] === null, String(cardB['note']))
    if (agentOn) {
      await remember('agents_enabled')
      await remember('cohort_user_ids')
      const en = (settingsBefore.get('agents_enabled')?.value ?? {}) as Record<string, boolean>
      const co = (settingsBefore.get('cohort_user_ids')?.value ?? []) as string[]
      await setSetting('agents_enabled', { ...en, munshi: true })
      await setSetting('cohort_user_ids', [...new Set([...co, B.uid])])
      const cardN = await json(await api(B.token, '/api/v1/partner/score?locale=en'))
      const note = cardN['note'] as string | null
      const allowed = [100, 44, 5, 3, ...((cardN['components'] as any[]) ?? []).flatMap((c) => [c.value, c.weight].filter((v) => typeof v === 'number'))]
      const { data: cached } = await admin.from('provider_scores').select('note').eq('provider_id', B.providerId).maybeSingle()
      check('coaching note (Munshi on, stub): one sentence that passes the output policy (no promise, only input numbers), cached on the snapshot for today', typeof note === 'string' && note.length > 0 && note.length <= 280 && scoreNoteProblems(note, allowed).length === 0 && (cached as any)?.note?.text === note, note ?? 'null')
    } else skip('coaching note with Munshi on', NEEDS_AGENT)

    // compare
    const cmpHi = await json(await api(X.token, `/api/v1/rfq/${rfqHi}/compare`))
    const cmpLo = await json(await api(X.token, `/api/v1/rfq/${rfqLo}/compare`))
    check('compare above ₹25,000 → reliability: A (₹30,000, score 100) before B (₹29,000, score 44); the response carries no score', (cmpHi['ordering'] as any)?.mode === 'reliability' && ((cmpHi['ordering'] as any)?.ids ?? []).join() === [q['hiA'], q['hiB']].join() && scoreFieldPaths(cmpHi).length === 0, JSON.stringify(cmpHi['ordering']))
    check('compare below the threshold → price (B cheaper first), identical to the price sort', (cmpLo['ordering'] as any)?.mode === 'price' && ((cmpLo['ordering'] as any)?.ids ?? []).join() === [q['loB'], q['loA']].join(), JSON.stringify(cmpLo['ordering']))
    await privacySweep('flag ON (scores exist, reliability ordering live)')

    // admin
    const blockB = await json(await api(adminU.token, `/api/v1/admin/score/provider/${B.providerId}`))
    const blockX = await json(await api(adminU.token, `/api/v1/admin/score/buyer/${X.msmeId}`))
    const blockDenied = await api(X.token, `/api/v1/admin/score/buyer/${X.msmeId}`)
    await json(blockDenied)
    check('admin block: provider B (44, raw counts, the gate event) and buyer X (100); a buyer asking for its own buyer score → 403', blockB['score'] === 44 && ((blockB['events'] as any[]) ?? []).some((e) => e.reason === 'gate') && ((blockB['components'] as any[]) ?? []).some((c) => c.raw && Object.keys(c.raw).length) && blockX['score'] === 100 && blockDenied.status === 403, `${blockB['score']} / ${blockX['score']} / ${blockDenied.status}`)
    if (agentOn) {
      const st = await json(await api(adminU.token, '/api/v1/agent/admin/score/stats'))
      check('stats tile: provider scored ≥ 2 (A, B), histogram of 10 buckets, a median; buyers scored ≥ 2', ((st['provider'] as any)?.scored ?? 0) >= 2 && ((st['provider'] as any)?.histogram ?? []).length === 10 && typeof (st['provider'] as any)?.median === 'number' && ((st['buyer'] as any)?.scored ?? 0) >= 2, JSON.stringify(st).slice(0, 200))
    } else skip('stats tile', NEEDS_AGENT)

    // the Munshi growth nudge (runtime in-process)
    if (!agentOn) skip('Munshi growth nudge (runtime in-process)', NEEDS_AGENT)
    else {
      process.env['AGENT_ENABLED'] = 'true'
      process.env['API_URL'] = BASE
      process.env['WHATSAPP_DRIVER'] = 'stub'
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const rt = require('../../agent-runtime/src/agents/munshi/index') as typeof import('../../agent-runtime/src/agents/munshi/index')
      loadDefaultPrompts()
      const store = new Map<string, number>()
      const memRedis: RedisLike = {
        async incrby(k, v) { const x = (store.get(k) ?? 0) + v; store.set(k, x); return x },
        async expire() { return 1 },
        async mget<T = unknown>(...keys: string[]) { return keys.map((k) => (store.has(k) ? (store.get(k) as unknown as T) : null)) },
      }
      const tokens = new Map<string, string>([[B.uid, B.token]])
      const core: RunAgentDeps = { ledger: createSupabaseLedger(admin), gateway: createGateway(), makeBudget: ({ runId, userId, agentName }) => createRedisBudget({ redis: memRedis, caps: async () => resolveCaps({}, agentName), runId, userId }), apiBaseUrl: BASE, makeToken: async ({ userId }) => tokens.get(userId) ?? '' }
      const deps: import('../../agent-runtime/src/agents/munshi/index').MunshiRuntimeDeps = { core, admin, whatsapp: makeStubDriver(() => undefined), apiUrl: BASE, agentEnabled: true, tokenFor: async ({ userId }) => tokens.get(userId) ?? '', mediaBucket: 'wa-media', runtimeSecret: RIG_RUNTIME_SECRET, capture: () => undefined }
      await setSetting('growth_nudge_enabled', true)
      const consent = { locale: 'en', surface: 'rig', text_version: 'munshi-v1-2026-09-22', at: new Date().toISOString() }
      await admin.from('agent_grants').insert({ user_id: B.uid, persona: 'provider', scopes: [...MUNSHI_SCOPES], channel: 'web', channel_identity: null, consent })
      await admin.from('agent_grants').insert({ user_id: B.uid, persona: 'provider', scopes: [...MUNSHI_SCOPES], channel: 'whatsapp', channel_identity: `+91${B.digits}`, consent })
      await admin.from('munshi_provider_state').upsert({ provider_id: B.providerId, user_id: B.uid, locale: 'en' }, { onConflict: 'provider_id' })
      const { data: conv } = await admin.from('wa_conversations').insert({ phone_e164: `91${B.digits}`, user_id: B.uid, locale: 'en', last_inbound_at: new Date().toISOString(), window_open_until: new Date(Date.now() + D).toISOString() }).select('id').single()
      created.convIds.push(conv!.id)
      // three requests in B's state (Lakshadweep: no real provider or buyer there) in a category B does not list, none matched
      const Z = await mkBuyer('z', 'LD')
      for (let i = 0; i < 3; i++) await mkRfq(Z.msmeId, { status: 'expired', quoteCount: 0, createdAt: Date.now() - (5 + i) * D, category: 'legal' })
      const outbound = async () => ((await admin.from('wa_messages').select('body, payload').eq('conversation_id', conv!.id).eq('direction', 'out').order('created_at', { ascending: true })).data ?? []) as any[]
      const inApp = async () => ((await admin.from('notifications').select('kind').eq('user_id', B.uid).eq('kind', 'munshi_growth')).data ?? []).length
      const rewind = () => admin.from('munshi_provider_state').update({ last_growth_at: new Date(Date.now() - 8 * D).toISOString() }).eq('provider_id', B.providerId)
      const g1 = await rt.runMunshiGrowth(deps)
      const o1 = await outbound()
      check('growth #1: B\'s profile has gaps → profile_field "about" (priority 1); WhatsApp line + (runtime credential) in-app munshi_growth', g1.status === 'ok' && (g1 as any).detail.kinds?.profile_field === 1 && o1.at(-1)?.payload?.growth === 'profile_field' && (RIG_RUNTIME_SECRET ? (await inApp()) === 1 : true), JSON.stringify((g1 as any).detail))
      const g2 = await rt.runMunshiGrowth(deps)
      check('growth: a second run the same week sends nothing (last_growth_at)', (g2 as any).detail?.recent === 1 && (g2 as any).detail?.sent === 0 && (await outbound()).length === o1.length, JSON.stringify((g2 as any).detail))
      await admin.from('provider_profiles').update({ about: 'We file GST returns and keep books for traders and small manufacturers in the islands.', logo_url: 'https://example.invalid/logo.png', city: 'Kavaratti', languages: ['en'], years_experience: 6 }).eq('id', B.providerId)
      await rewind()
      const g3 = await rt.runMunshiGrowth(deps)
      const l3 = String((await outbound()).at(-1)?.body ?? '')
      check('growth #2: profile complete → category_demand (3 unmatched "legal" requests in Lakshadweep, a category B does not list) — the line names the count, no buyer', (g3 as any).detail?.kinds?.category_demand === 1 && l3.includes('3 requests'), l3)
      await admin.from('provider_categories').insert({ provider_id: B.providerId, category_id: catId('legal') })
      await rewind()
      const g4 = await rt.runMunshiGrowth(deps)
      const l4 = String((await outbound()).at(-1)?.body ?? '')
      check('growth #3: nothing unmatched left → the weakest component\'s tip (dispute_record 20 < 70)', (g4 as any).detail?.kinds?.score_tip === 1 && l4 === SCORE_TIPS.en.dispute_record, l4)
      await admin.from('agent_grants').update({ revoked_at: new Date().toISOString() }).eq('user_id', B.uid).eq('channel', 'whatsapp')
      await rewind()
      const before5 = (await outbound()).length
      const g5 = await rt.runMunshiGrowth(deps)
      check('growth after STOP (WhatsApp grant revoked): the nudge is picked but NOT sent on WhatsApp (in-app only)', (g5 as any).detail?.sent === 1 && (g5 as any).detail?.whatsapp === 0 && (await outbound()).length === before5, JSON.stringify((g5 as any).detail))
      await admin.from('agent_grants').update({ revoked_at: new Date().toISOString() }).eq('user_id', B.uid).is('revoked_at', null)
      await rewind()
      const g6 = await rt.runMunshiGrowth(deps)
      check('growth after disable (web grant revoked): B is not enumerated — nothing picked, nothing sent', (g6 as any).detail?.providers === 0 && (g6 as any).detail?.sent === 0, JSON.stringify((g6 as any).detail))
      await setSetting('growth_nudge_enabled', false)
      const g7 = await rt.runMunshiGrowth(deps)
      check('growth_nudge_enabled off → the job is a no-op', (g7 as any).detail?.skipped === 'growth_nudge_disabled', JSON.stringify((g7 as any).detail))
      if (!RIG_RUNTIME_SECRET) skip('growth in-app notification (runtime-credential route)', 'set AGENT_RUNTIME_SECRET to the same throwaway value on this rig and the local server')
    }
    skip('cron/score-compute with the switch ON', 'not called: it would score every real provider on this DB — the compute library ran in-process restricted to the fixtures; the route is a thin wrapper proven as the flag-off no-op')
    skip('live coaching note', 'keyless gateway → the deterministic stub note; the live gate is eval --set score_note (≥ 90 %, 0 policy violations) once the key exists')
  } catch (e) {
    // a lifecycle throw is a FAIL row, never an escape before the rows print
    record('lifecycle', 'FAIL', (e as Error).message.split('\n')[0])
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
      const convIds = created.convIds.length ? created.convIds : [NIL]
      const subjects = [...pids, ...mids]
      await del('score_events', admin.from('score_events').delete().in('subject_id', subjects))
      await del('score_history', admin.from('score_history').delete().in('subject_id', subjects))
      await del('provider_scores', admin.from('provider_scores').delete().in('provider_id', pids))
      await del('buyer_scores', admin.from('buyer_scores').delete().in('msme_id', mids))
      await del('disputes', admin.from('disputes').delete().in('order_id', orderIds))
      await del('order_events', admin.from('order_events').delete().in('order_id', orderIds))
      await del('orders', admin.from('orders').delete().in('id', orderIds))
      const { data: qs } = await admin.from('quotes').select('id').in('rfq_id', rfqIds)
      const quoteIds = ((qs ?? []) as { id: string }[]).map((x) => x.id)
      if (quoteIds.length) {
        await del('quote_events', admin.from('quote_events').delete().in('quote_id', quoteIds))
        await del('price_book(quote)', admin.from('provider_price_book').delete().in('source_quote_id', quoteIds))
      }
      await del('quotes', admin.from('quotes').delete().in('rfq_id', rfqIds))
      await del('rfq_matches', admin.from('rfq_matches').delete().in('rfq_id', rfqIds))
      await del('rfqs', admin.from('rfqs').delete().in('id', rfqIds))
      for (const id of [...created.orderIds, ...created.rfqIds]) await del('notifications(link)', admin.from('notifications').delete().like('link', `%${id}%`))
      await del('notifications(user)', admin.from('notifications').delete().in('user_id', users))
      const { data: runs } = await admin.from('agent_runs').select('id').in('user_id', users)
      const runIds = ((runs ?? []) as { id: string }[]).map((r) => r.id)
      if (runIds.length) {
        await del('events', admin.from('agent_events').delete().in('run_id', runIds))
        await del('invocations(run)', admin.from('ai_invocations').delete().in('run_id', runIds))
        await del('runs(children)', admin.from('agent_runs').delete().in('parent_run_id', runIds))
      }
      await del('invocations(user)', admin.from('ai_invocations').delete().in('user_id', users))
      await del('runs', admin.from('agent_runs').delete().in('user_id', users))
      await del('wa_messages', admin.from('wa_messages').delete().in('conversation_id', convIds))
      await del('wa_conversations', admin.from('wa_conversations').delete().in('id', convIds))
      await del('munshi_state', admin.from('munshi_provider_state').delete().in('provider_id', pids))
      await del('grants', admin.from('agent_grants').delete().in('user_id', users))
      await del('audit', admin.from('audit_logs').delete().in('actor_id', users))
      await del('provider_categories', admin.from('provider_categories').delete().in('provider_id', pids))
      await del('provider_profiles', admin.from('provider_profiles').delete().in('id', pids))
      await del('msme_profiles', admin.from('msme_profiles').delete().in('id', mids))
      for (const [key, before] of settingsBefore) {
        if (before.existed) await admin.from('agent_settings').upsert({ key, value: before.value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
        else await admin.from('agent_settings').delete().eq('key', key)
      }
      // the cron heartbeat the flag-off leg recorded: back to what it was (absent → absent)
      if (hbBefore) await admin.from('cron_heartbeats').upsert(hbBefore, { onConflict: 'name' })
      else await del('heartbeat', admin.from('cron_heartbeats').delete().eq('name', 'score-compute'))
      for (const uid of created.users) {
        await del('users', admin.from('users').delete().eq('id', uid))
        const { error } = await admin.auth.admin.deleteUser(uid)
        if (error) errors.push(`auth ${uid}: ${error.message}`)
      }
      const residue: string[] = []
      const { count: u } = await admin.from('users').select('id', { count: 'exact', head: true }).like('email', `${tag}%`)
      if (u) residue.push(`users=${u}`)
      for (const [table, col, ids] of [['score_events', 'subject_id', subjects], ['score_history', 'subject_id', subjects], ['provider_scores', 'provider_id', pids], ['buyer_scores', 'msme_id', mids], ['orders', 'id', orderIds], ['order_events', 'order_id', orderIds], ['disputes', 'order_id', orderIds], ['rfqs', 'id', rfqIds], ['rfq_matches', 'rfq_id', rfqIds], ['quotes', 'rfq_id', rfqIds], ['notifications', 'user_id', users], ['agent_runs', 'user_id', users], ['agent_grants', 'user_id', users], ['wa_conversations', 'id', convIds], ['provider_profiles', 'id', pids], ['msme_profiles', 'id', mids]] as const) {
        const { count, error } = await admin.from(table).select('*', { count: 'exact', head: true }).in(col, [...ids])
        if (count && !error) residue.push(`${table}=${count}`)
      }
      if (errors.length) record('cleanup', 'FAIL', errors.join(' | '))
      else check(`cleanup: zero residue (${created.users.length} users, ${created.orderIds.length} orders, ${created.rfqIds.length} RFQs, every score row by subject, settings + the heartbeat restored)`, residue.length === 0, residue.join(', '))
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
