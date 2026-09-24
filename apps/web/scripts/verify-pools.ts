/**
 * S3.4 (ADR 024) — demand aggregation acceptance. Drives the real routes with per-user Bearer tokens against the
 * AGENT-ON server (BASE_URL, started with AGENT_ENABLED=true) and proves the flag-off path on the ordinary server
 * (FLAG_OFF_BASE_URL). Fixtures live in Lakshadweep (LD), a state no other rig uses; every row is removed in
 * `finally` and the agent settings it touches are restored.
 *
 *   0  inert: flag off (and switch off) → 404s, the cron is a no-op
 *   1  detection: four same-service requests → one forming group, four invites; must-haves / other service excluded
 *   2  joining: three joins → ai_decisions (demand_pool / join_pool) and the group opens; replay → 409; dismiss
 *   3  offers: incoherent tiers → 400, short validity → 422, second offer → 409, sealed provider view, cohort gate
 *   4  choices: server tier figures = quoteChargeAmounts; a dismissed member / foreign offer is refused; withdraw
 *      clears commitments
 *   5  close: exactly one ORDINARY quote per committed member at the tier reached; quote_count +1 each; replay writes
 *      nothing; members linked; the offer records count + price
 *   6  pay: a member accepts & pays the group quote through the ordinary checkout; total = quoteChargeAmounts
 *   7  lapse and cancel
 *
 * Run (CI): BASE_URL=http://localhost:3001 FLAG_OFF_BASE_URL=http://localhost:3000 tsx scripts/verify-pools.ts
 */
import { config } from 'dotenv'
import path from 'path'
import { randomUUID } from 'crypto'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'
import { quoteChargeAmounts } from '@amclub/shared'

const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const BASE = process.env['BASE_URL'] ?? 'http://localhost:3001'
const OFF = process.env['FLAG_OFF_BASE_URL'] ?? 'http://localhost:3000'
const CRON = process.env['CRON_SECRET'] ?? ''
if (!URL_ || !SERVICE || !ANON) { console.error('Supabase env missing'); process.exit(2) }
if (/supabase\.co/.test(URL_) && process.env['POOLS_ALLOW_HOSTED'] !== '1') { console.error('Refusing to run against a hosted Supabase (POOLS_ALLOW_HOSTED=1 to override).'); process.exit(2) }
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })

let pass = 0
let fail = 0
const check = (n: string, ok: boolean, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${!ok && extra ? ' — ' + extra : ''}`); if (ok) pass++; else fail++ }
const tag = `poolv_${Date.now()}`
const STATE = 'LD'
const created = { users: [] as string[], providerIds: [] as string[], msmeIds: [] as string[], rfqIds: [] as string[] }
const savedSettings = new Map<string, unknown>()

interface U { uid: string; token: string }
async function mkUser(label: string, roles: string[]): Promise<U> {
  const email = `${tag}_${label}@killtest.amclub`
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error || !data.user) throw new Error(`${label}: ${error?.message}`)
  created.users.push(data.user.id)
  await admin.from('users').insert({ id: data.user.id, email, roles })
  const anon = createClient(URL_, ANON, { auth: { persistSession: false } })
  const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
  return { uid: data.user.id, token: s.session!.access_token }
}

const call = (base: string, token: string | null, p: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
  fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const api = (token: string, p: string, body?: unknown, method?: string) => call(BASE, token, p, body, method)
const cron = (base = BASE) => fetch(`${base}/api/v1/cron/agent-demand-pools`, { headers: { Authorization: `Bearer ${CRON}` } })
const json = async (r: Response) => (await r.json().catch(() => ({}))) as Record<string, unknown>

async function setSetting(key: string, value: unknown) {
  if (!savedSettings.has(key)) {
    const { data } = await admin.from('agent_settings').select('value').eq('key', key).maybeSingle()
    savedSettings.set(key, data ? data.value : undefined)
  }
  const { error } = await admin.from('agent_settings').upsert({ key, value }, { onConflict: 'key' })
  if (error) throw new Error(`agent_settings ${key}: ${error.message}`)
}

async function newRfq(buyer: U, service: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await api(buyer.token, '/api/v1/rfq', {
    category_slug: 'tax-accounting',
    title: `ITR filing for FY 2025-26 (${service})`,
    details: { filing_type: 'ITR Filing', financial_year: '2025-26', turnover_range: '₹1–5 crore', service_slug: service },
    attachments: [],
    ...extra,
  })
  const d = await json(r)
  if (!r.ok || typeof d['rfqId'] !== 'string') throw new Error(`rfq create ${r.status} ${JSON.stringify(d)}`)
  created.rfqIds.push(d['rfqId'] as string)
  return d['rfqId'] as string
}

async function main() {
  console.log(`\nS3.4 demand pools → ${BASE} (flag-off server: ${OFF})\n`)
  if (!CRON) throw new Error('CRON_SECRET is required (the cron drives detection and the close)')
  const { data: cat } = await admin.from('categories').select('id, commission_bps').eq('slug', 'tax-accounting').single()
  const commissionBps = (cat!.commission_bps as number | null) ?? 1000

  // ── fixtures ──────────────────────────────────────────────────────────────
  const buyers: Array<U & { msmeId: string }> = []
  for (let i = 1; i <= 5; i++) {
    const u = await mkUser(`b${i}`, ['msme'])
    const { data: m } = await admin.from('msme_profiles').insert({ user_id: u.uid, business_name: `Pool Buyer ${i}`, state: STATE, sector: 'services' }).select('id').single()
    created.msmeIds.push(m!.id)
    buyers.push({ ...u, msmeId: m!.id as string })
  }
  async function mkProvider(label: string, state: string): Promise<U & { providerId: string }> {
    const u = await mkUser(label, ['provider'])
    const { data: p } = await admin.from('provider_profiles').insert({ user_id: u.uid, legal_name: `Pool ${label}`, display_name: `Pool ${label} ${tag}`, slug: `${tag}-${label}`, state, status: 'active', languages: ['en'] }).select('id').single()
    created.providerIds.push(p!.id)
    await admin.from('provider_categories').insert({ provider_id: p!.id, category_id: cat!.id })
    return { ...u, providerId: p!.id as string }
  }
  const pA = await mkProvider('pa', STATE)
  const pB = await mkProvider('pb', STATE)
  const pC = await mkProvider('pc', STATE) // matched but NOT in the cohort
  const ops = await mkUser('ops', ['msme', 'admin'])
  const [b1, b2, b3, b4, b5] = buyers as [U & { msmeId: string }, U & { msmeId: string }, U & { msmeId: string }, U & { msmeId: string }, U & { msmeId: string }]

  // ── 0. inert while the switch is off ──────────────────────────────────────
  console.log('0 — inert')
  {
    const { data: ae } = await admin.from('agent_settings').select('value').eq('key', 'agents_enabled').maybeSingle()
    const enabled = { ...((ae?.value as Record<string, boolean> | undefined) ?? {}), demand_aggregation: false }
    await setSetting('agents_enabled', enabled)
    const r = await cron()
    const d = await json(r)
    check('switch off: the cron is a no-op heartbeat', r.status === 200 && d['enabled'] === false, `${r.status} ${JSON.stringify(d)}`)
    const g = await api(b1.token, `/api/v1/pools/${randomUUID()}`)
    check('switch off: pool routes 404', g.status === 404, `${g.status}`)
    const off = await call(OFF, b1.token, `/api/v1/pools/${randomUUID()}`)
    const offCron = await cron(OFF)
    const offD = await json(offCron)
    check('AGENT_ENABLED off: routes 404 and the cron touches no pool table', off.status === 404 && offCron.status === 200 && offD['enabled'] === false, `${off.status} ${offCron.status} ${JSON.stringify(offD)}`)
    await setSetting('agents_enabled', { ...enabled, demand_aggregation: true })
    await setSetting('cohort_user_ids', [...buyers.map((b) => b.uid), pA.uid, pB.uid, ops.uid])
    await setSetting('pool_min_members', 3)
  }

  // ── 1. detection ──────────────────────────────────────────────────────────
  console.log('1 — detection')
  const rfq1 = await newRfq(b1, 'itr-filing')
  const rfq2 = await newRfq(b2, 'itr-filing')
  const rfq3 = await newRfq(b3, 'itr-filing')
  const rfq4 = await newRfq(b4, 'itr-filing')
  const rfq5 = await newRfq(b5, 'itr-filing', { must_haves: { credentials: [], languages: ['ta'], onSite: false, inStateOnly: false } })
  const c1 = await json(await cron())
  const { data: pools1 } = await admin.from('service_pools').select('id, status, min_members, form_by').eq('state', STATE).eq('service_slug', 'itr-filing')
  const pool = (pools1 ?? [])[0] as { id: string; status: string } | undefined
  const { data: mem1 } = pool ? await admin.from('service_pool_members').select('rfq_id, status').eq('pool_id', pool.id) : { data: [] }
  const memberRfqs = new Set((mem1 ?? []).map((m) => m.rfq_id as string))
  check('four same-service requests → one forming group with four invites', (pools1?.length ?? 0) === 1 && pool?.status === 'forming' && memberRfqs.size === 4 && [rfq1, rfq2, rfq3, rfq4].every((r) => memberRfqs.has(r)), `${JSON.stringify(c1)} pools=${pools1?.length} members=${memberRfqs.size}`)
  check('a request with must-haves is never grouped', !memberRfqs.has(rfq5))
  const again = await json(await cron())
  const { count: poolCount } = await admin.from('service_pools').select('id', { count: 'exact', head: true }).eq('state', STATE)
  check('a second detection run proposes nothing new', poolCount === 1 && again['proposed'] === 0, JSON.stringify(again))
  if (!pool) throw new Error('no pool — later sections depend on it')
  const card = await json(await api(b1.token, `/api/v1/rfq/${rfq1}/pool`))
  check('the buyer sees an invitation on their own request', (card['pool'] as { memberStatus?: string } | null)?.memberStatus === 'invited', JSON.stringify(card))
  const notMine = await api(b1.token, `/api/v1/rfq/${rfq2}/pool`)
  check("another buyer's request shows no group to b1", ((await json(notMine))['pool'] ?? null) === null)

  // ── 2. joining ────────────────────────────────────────────────────────────
  console.log('2 — joining')
  const j1 = await json(await api(b1.token, `/api/v1/pools/${pool.id}/membership`, { action: 'join' }))
  const j2 = await json(await api(b2.token, `/api/v1/pools/${pool.id}/membership`, { action: 'join' }))
  check('joins below the minimum keep the group forming', j1['poolStatus'] === 'forming' && j2['poolStatus'] === 'forming', `${JSON.stringify(j1)} ${JSON.stringify(j2)}`)
  const replay = await api(b1.token, `/api/v1/pools/${pool.id}/membership`, { action: 'join' })
  check('a repeated join is refused (409)', replay.status === 409, `${replay.status}`)
  const j3 = await json(await api(b3.token, `/api/v1/pools/${pool.id}/membership`, { action: 'join' }))
  const { data: opened } = await admin.from('service_pools').select('status, opened_at, closes_at').eq('id', pool.id).single()
  check('the third join opens the group with a close time', j3['poolStatus'] === 'open' && opened?.status === 'open' && !!opened?.closes_at, JSON.stringify(opened))
  const { data: decisions } = await admin.from('ai_decisions').select('id, tool').eq('feature', 'demand_pool').in('decided_by', [b1.uid, b2.uid, b3.uid])
  const { data: linked } = await admin.from('service_pool_members').select('decision_id').eq('pool_id', pool.id).eq('status', 'joined')
  check('each join is ONE ai_decisions row (demand_pool / join_pool) linked to the membership', decisions?.length === 3 && decisions.every((d) => d.tool === 'join_pool') && (linked ?? []).every((m) => !!m.decision_id), `decisions=${decisions?.length} linked=${JSON.stringify(linked)}`)
  const dis = await api(b4.token, `/api/v1/pools/${pool.id}/membership`, { action: 'dismiss' })
  check('an invitee can say no thanks', dis.status === 200, `${dis.status}`)

  // ── 3. offers ─────────────────────────────────────────────────────────────
  console.log('3 — offers')
  const validUntil = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10)
  const base = { delivery_days: 6, scope: 'ITR-3 preparation and e-filing, computation, and one revision if the department asks.', gst_included: false, valid_until: validUntil }
  const bad = await api(pA.token, `/api/v1/pools/${pool.id}/offer`, { ...base, tiers: [{ min_members: 1, price_paise: 10_000_00 }, { min_members: 3, price_paise: 11_000_00 }] })
  check('a dearer higher tier is incoherent (400 tiers_incoherent)', bad.status === 400 && (await json(bad))['error'] === 'tiers_incoherent', `${bad.status}`)
  const short = await api(pA.token, `/api/v1/pools/${pool.id}/offer`, { ...base, valid_until: new Date(Date.now() - 86400_000).toISOString().slice(0, 10), tiers: [{ min_members: 1, price_paise: 10_000_00 }] })
  check('an offer that expires before the close is refused (422)', short.status === 422, `${short.status}`)
  const offA = await json(await api(pA.token, `/api/v1/pools/${pool.id}/offer`, { ...base, tiers: [{ min_members: 1, price_paise: 10_000_00 }, { min_members: 3, price_paise: 8_000_00 }] }))
  const dupA = await api(pA.token, `/api/v1/pools/${pool.id}/offer`, { ...base, tiers: [{ min_members: 1, price_paise: 9_000_00 }] })
  check('provider A makes one offer; a second is refused (409)', typeof offA['offerId'] === 'string' && dupA.status === 409, `${JSON.stringify(offA)} ${dupA.status}`)
  const offB = await json(await api(pB.token, `/api/v1/pools/${pool.id}/offer`, { ...base, gst_included: true, tiers: [{ min_members: 1, price_paise: 9_500_00 }] }))
  const cView = await api(pC.token, `/api/v1/pools/${pool.id}`)
  check('a matched provider outside the cohort cannot see the group (404)', cView.status === 404, `${cView.status}`)
  const aViewRaw = await api(pA.token, `/api/v1/pools/${pool.id}`)
  const aViewText = await aViewRaw.text()
  check("sealed: provider A's view carries its own offer and never B's", aViewRaw.ok && aViewText.includes(offA['offerId'] as string) && !aViewText.includes(offB['offerId'] as string), aViewText.slice(0, 200))

  // ── 4. choices ────────────────────────────────────────────────────────────
  console.log('4 — choices')
  const bv = await json(await api(b1.token, `/api/v1/pools/${pool.id}`))
  const offers = ((bv['pool'] as { offers?: Array<{ id: string; gstIncluded: boolean; tiers: Array<{ pricePaise: number; totalPaise: number }> }> })?.offers) ?? []
  const figuresOk = offers.length === 2 && offers.every((o) => o.tiers.every((t) => t.totalPaise === quoteChargeAmounts({ pricePaise: t.pricePaise, gstIncluded: o.gstIncluded, commissionBps }).totalPaise))
  check('the buyer sees both offers with the checkout\'s own figure per tier', figuresOk, JSON.stringify(offers).slice(0, 300))
  const b4c = await api(b4.token, `/api/v1/pools/${pool.id}/commit`, { offer_id: offA['offerId'] })
  check('a member who did not join cannot choose (409)', b4c.status === 409, `${b4c.status}`)
  const foreign = await api(b1.token, `/api/v1/pools/${pool.id}/commit`, { offer_id: randomUUID() })
  check('an offer from outside the group is refused (409 offer_unavailable)', foreign.status === 409, `${foreign.status}`)
  await api(b3.token, `/api/v1/pools/${pool.id}/commit`, { offer_id: offB['offerId'] })
  const wd = await api(pB.token, `/api/v1/pools/${pool.id}/offer`, undefined, 'DELETE')
  const { data: b3m } = await admin.from('service_pool_members').select('committed_offer_id').eq('pool_id', pool.id).eq('msme_id', b3.msmeId).single()
  check("withdrawing an offer clears the choices made for it", wd.status === 200 && b3m?.committed_offer_id === null, `${wd.status} ${JSON.stringify(b3m)}`)
  for (const b of [b1, b2, b3]) await api(b.token, `/api/v1/pools/${pool.id}/commit`, { offer_id: offA['offerId'] })
  const { data: commits } = await admin.from('service_pool_members').select('committed_offer_id').eq('pool_id', pool.id).eq('committed_offer_id', offA['offerId'] as string)
  check('three members choose provider A', commits?.length === 3, `${commits?.length}`)

  // ── 5. the close ──────────────────────────────────────────────────────────
  console.log('5 — close')
  const counts = async () => {
    const { data } = await admin.from('rfqs').select('id, quote_count').in('id', [rfq1, rfq2, rfq3])
    return new Map((data ?? []).map((r) => [r.id as string, r.quote_count as number]))
  }
  const before = await counts()
  await admin.from('service_pools').update({ closes_at: new Date(Date.now() - 60_000).toISOString() }).eq('id', pool.id)
  const cl = await json(await cron())
  const { data: closedPool } = await admin.from('service_pools').select('status').eq('id', pool.id).single()
  const { data: groupQuotes } = await admin.from('quotes').select('id, rfq_id, price_paise, status, gst_included').eq('provider_id', pA.providerId).in('rfq_id', [rfq1, rfq2, rfq3])
  const after = await counts()
  check('the close writes exactly one ORDINARY quote per committed member, at the 3-member tier (₹8,000)', closedPool?.status === 'closed' && groupQuotes?.length === 3 && groupQuotes.every((q) => Number(q.price_paise) === 8_000_00 && q.status === 'submitted' && q.gst_included === false), `${JSON.stringify(cl)} ${closedPool?.status} ${JSON.stringify(groupQuotes)}`)
  check("each request's quote_count moved by exactly one (the 7-cap claim path)", [rfq1, rfq2, rfq3].every((r) => (after.get(r) ?? 0) === (before.get(r) ?? 0) + 1), `${JSON.stringify([...before])} → ${JSON.stringify([...after])}`)
  const { data: offerRow } = await admin.from('service_pool_offers').select('achieved_count, achieved_min_members, achieved_price_paise').eq('id', offA['offerId'] as string).single()
  check('the offer records the count and the price it reached', offerRow?.achieved_count === 3 && offerRow?.achieved_min_members === 3 && Number(offerRow?.achieved_price_paise) === 8_000_00, JSON.stringify(offerRow))
  const { data: members } = await admin.from('service_pool_members').select('rfq_id, quote_id, status, claim_state').eq('pool_id', pool.id).not('quote_id', 'is', null)
  const { data: evts } = await admin.from('quote_events').select('payload').in('quote_id', (groupQuotes ?? []).map((q) => q.id)).eq('event_type', 'submitted')
  check('members are linked to their quotes and each quote event names the group', members?.length === 3 && members.every((m) => m.status === 'released' && m.claim_state === 'claimed') && (evts ?? []).length === 3 && (evts ?? []).every((e) => (e.payload as Record<string, unknown>)?.['pool_id'] === pool.id), `${JSON.stringify(members)}`)
  await admin.from('service_pools').update({ status: 'closing' }).eq('id', pool.id) // force a resumed close
  await cron()
  const { count: quoteReplay } = await admin.from('quotes').select('id', { count: 'exact', head: true }).eq('provider_id', pA.providerId).in('rfq_id', [rfq1, rfq2, rfq3])
  const replayCounts = await counts()
  check('a replayed close writes nothing new', quoteReplay === 3 && [rfq1, rfq2, rfq3].every((r) => replayCounts.get(r) === after.get(r)), `quotes=${quoteReplay}`)

  // ── 6. pay through the ordinary checkout ─────────────────────────────────
  console.log('6 — pay')
  const q1 = (groupQuotes ?? []).find((q) => q.rfq_id === rfq1)!
  const co = await json(await api(b1.token, '/api/v1/checkout', { quoteId: q1.id, idempotencyKey: randomUUID() }))
  let orderId = ''
  if (co['simulated']) orderId = (await json(await api(b1.token, '/api/v1/checkout/simulate', { checkoutSessionId: co['checkoutSessionId'] })))['orderId'] as string
  const { data: order } = orderId ? await admin.from('orders').select('status, quote_id, total_paise, price_paise').eq('id', orderId).maybeSingle() : { data: null }
  const expected = quoteChargeAmounts({ pricePaise: 8_000_00, gstIncluded: false, commissionBps }).totalPaise
  const { data: q1After } = await admin.from('quotes').select('status').eq('id', q1.id).single()
  check('the group quote is paid through the ordinary checkout; total = quoteChargeAmounts(₹8,000)', order?.status === 'placed' && order?.quote_id === q1.id && Number(order?.total_paise) === expected && q1After?.status === 'accepted', `${JSON.stringify(co)} ${JSON.stringify(order)} expected=${expected}`)
  const admList = await json(await api(ops.token, '/api/v1/agent/admin/pools'))
  const row = ((admList['pools'] as Array<{ id: string; quoted: number; paid: number }> | undefined) ?? []).find((p) => p.id === pool.id)
  check('ops sees the committed → quoted → paid numbers', row?.quoted === 3 && row?.paid === 1, JSON.stringify(row))

  // ── 7. lapse and cancel ───────────────────────────────────────────────────
  console.log('7 — lapse and cancel')
  for (const b of [b1, b2, b3]) await newRfq(b, 'gst-filing')
  for (const b of [b1, b2, b3]) await newRfq(b, 'bookkeeping')
  await cron()
  const { data: p2 } = await admin.from('service_pools').select('id, status').eq('state', STATE).eq('service_slug', 'gst-filing').maybeSingle()
  const { data: p3 } = await admin.from('service_pools').select('id, status').eq('state', STATE).eq('service_slug', 'bookkeeping').maybeSingle()
  check('two more groups are proposed', p2?.status === 'forming' && p3?.status === 'forming', `${JSON.stringify(p2)} ${JSON.stringify(p3)}`)
  if (p2 && p3) {
    await api(b1.token, `/api/v1/pools/${p2.id}/membership`, { action: 'join' })
    await admin.from('service_pools').update({ form_by: new Date(Date.now() - 60_000).toISOString() }).eq('id', p2.id)
    await cron()
    const { data: lapsed } = await admin.from('service_pools').select('status').eq('id', p2.id).single()
    const { data: rel } = await admin.from('service_pool_members').select('status').eq('pool_id', p2.id)
    check('a group short of members lapses at form_by and releases everyone', lapsed?.status === 'lapsed' && (rel ?? []).every((m) => m.status === 'released'), `${lapsed?.status} ${JSON.stringify(rel)}`)
    const notOps = await api(b1.token, `/api/v1/agent/admin/pools/${p3.id}/cancel`, { reason: 'test' })
    const can = await api(ops.token, `/api/v1/agent/admin/pools/${p3.id}/cancel`, { reason: 'duplicate of a manual group' })
    const canAgain = await api(ops.token, `/api/v1/agent/admin/pools/${p3.id}/cancel`, { reason: 'again' })
    const { data: cancelled } = await admin.from('service_pools').select('status, cancelled_reason').eq('id', p3.id).single()
    check('only ops can cancel; a cancel is final (second → 409)', notOps.status === 403 && can.status === 200 && canAgain.status === 409 && cancelled?.status === 'cancelled', `${notOps.status} ${can.status} ${canAgain.status} ${JSON.stringify(cancelled)}`)
  }
  const offPool = await call(OFF, b1.token, `/api/v1/pools/${pool.id}`)
  check('the flag-off server still 404s a real group', offPool.status === 404, `${offPool.status}`)
}

async function cleanup() {
  console.log('\n🧹 cleanup…')
  const t = async (p: PromiseLike<unknown>) => { try { const r = (await p) as { error?: { message: string } | null } | null; if (r?.error) console.error('  ! delete error', r.error.message) } catch (e) { console.error('  ! delete error', (e as Error)?.message ?? e) } }
  await t(admin.from('service_pools').delete().eq('state', STATE)) // cascades members, offers, tiers, events
  for (const mid of created.msmeIds) {
    await t(admin.from('checkout_sessions').delete().eq('msme_id', mid))
    const { data: orders } = await admin.from('orders').select('id').eq('msme_id', mid)
    for (const o of orders ?? []) {
      await t(admin.from('payouts').delete().eq('order_id', o.id))
      const { data: pays } = await admin.from('payments').select('id').eq('order_id', o.id)
      for (const pay of pays ?? []) await t(admin.from('refunds').delete().eq('payment_id', pay.id))
      await t(admin.from('payments').delete().eq('order_id', o.id))
      await t(admin.from('invoices').delete().eq('order_id', o.id))
      await t(admin.from('order_events').delete().eq('order_id', o.id))
      await t(admin.from('order_documents').delete().eq('order_id', o.id))
      await t(admin.from('orders').delete().eq('id', o.id))
    }
    await t(admin.from('checkout_sessions').delete().eq('msme_id', mid))
    await t(admin.from('conversations').delete().eq('msme_id', mid))
  }
  if (created.rfqIds.length) {
    const { data: qs } = await admin.from('quotes').select('id').in('rfq_id', created.rfqIds)
    const qids = (qs ?? []).map((q) => q.id as string)
    if (qids.length) await t(admin.from('provider_price_book').delete().in('source_quote_id', qids))
  }
  for (const id of created.rfqIds) await t(admin.from('rfqs').delete().eq('id', id))
  if (created.users.length) await t(admin.from('ai_decisions').delete().in('decided_by', created.users))
  for (const id of created.providerIds) {
    await t(admin.from('provider_price_book').delete().eq('provider_id', id))
    await t(admin.from('provider_categories').delete().eq('provider_id', id))
    await t(admin.from('provider_profiles').delete().eq('id', id))
  }
  for (const mid of created.msmeIds) await t(admin.from('msme_profiles').delete().eq('id', mid))
  for (const uid of created.users) {
    await t(admin.from('notifications').delete().eq('user_id', uid))
    await t(admin.from('audit_logs').delete().eq('actor_id', uid))
    await t(admin.from('users').delete().eq('id', uid))
    await admin.auth.admin.deleteUser(uid).catch(() => {})
  }
  for (const [key, value] of savedSettings) {
    if (value === undefined) await t(admin.from('agent_settings').delete().eq('key', key))
    else await t(admin.from('agent_settings').upsert({ key, value }, { onConflict: 'key' }))
  }
}

main()
  .catch((e) => { fail++; console.error(e) })
  .finally(async () => {
    await cleanup().catch((e) => console.error('cleanup failed', e))
    console.log(`\n${fail === 0 ? '✅ S3.4 DEMAND POOLS — ALL CRITERIA PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`)
    process.exit(fail === 0 ? 0 : 1)
  })
