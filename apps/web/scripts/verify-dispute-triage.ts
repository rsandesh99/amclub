/**
 * verify-dispute-triage — S1.7 party statements + Dispute-Triage agent (verify-* convention).
 *
 * OFFLINE (always): triageDeterministicChecks on the S1.4 fixtures + statement
 *   fixtures; clampTriage table; strict schema rejections; stubTriage.
 * HTTP flag-OFF (BASE_URL, AGENT_ENABLED=false server): /api/v1/agent/admin/triages*
 *   → 404; the statement route works for parties (spine): buyer POST → row +
 *   event + counter-party notification; provider POST; third user 403; second
 *   buyer POST 409; PATCH 200; contact info redacted; admin dispute GET carries
 *   statements + thread; raise_dispute unchanged (trigger → agent_disabled);
 *   NO dispute_triages row; resolve without triage_id byte-identical (refund
 *   partial paise-exact + idempotent `already`).
 * Flag-ON (AGENT_ENABLED=true server): the runtime agent driven IN-PROCESS
 *   (the same runAgent(disputeTriageAgent) the worker calls) with the ops
 *   user's OWN session token in place of the delegated one (no SUPABASE_JWT_
 *   SECRET here — recorded skips: HMAC mint, pg-boss queue, the scope-403
 *   refusal of a token lacking summarize_dispute). Proves: raise dispute →
 *   trigger gated; one ai_invocations row (task dispute_triage, frontier,
 *   run_id); dispute_triages row; disputes.triage_id; one statement missing →
 *   needs_more_info; second statement → re-triage, triage_id moves, history 2;
 *   PATCH after triage → 409; resolve with triage_id → one ai_decisions row
 *   (feature dispute_triage, run_id, tool summarize_dispute), decision columns
 *   once, second resolve `already` with no second decision, money path
 *   unchanged; foreign triage_id → 422; the 4th triage → terminal triage_cap.
 * Residue zero (checked, FK-ordered deletes; settings restored).
 *
 * Run: BASE_URL=<url> pnpm --filter @amclub/web agents:verify:triage
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  DISPUTE_TRIAGE_RECOMMENDATIONS,
  clampTriage,
  disputeTriageSchema,
  stubTriage,
  triageAllowedRefs,
  triageCheck,
  triageDeterministicChecks,
  type DisputeTriage,
} from '@amclub/shared'
import { createGateway, createNoopBudget, createSupabaseLedger, loadDefaultPrompts, runAgent, servicesEvidenceFixture, goodsEvidenceFixture, type RunAgentDeps } from '@amclub/agent-core'

const BASE = (process.env['BASE_URL'] || '').replace(/\/$/, '')
const SUPA_URL = process.env['NEXT_PUBLIC_SUPABASE_URL'] || ''
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] || ''
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY'] || ''
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
// ── OFFLINE ──────────────────────────────────────────────────────────────────
function offline() {
  const both = [{ role: 'buyer' as const }, { role: 'provider' as const }]
  const svc = servicesEvidenceFixture()
  svc.disputes = [{ id: NIL, status: 'open', reason: 'quality', opened_at: '2026-09-05T13:00:00Z' }]
  const c1 = triageDeterministicChecks(svc, both)
  check('checks: services fixture, both statements → every check ok', c1.every((c) => c.ok), c1.filter((c) => !c.ok).map((c) => c.name).join(','))
  const c2 = triageDeterministicChecks(svc, [{ role: 'buyer' }], { refundExists: true })
  check('checks: provider statement missing + refund exists flagged', triageCheck(c2, 'statement_missing_provider')?.ok === false && triageCheck(c2, 'refund_already_exists')?.ok === false)
  const g = goodsEvidenceFixture()
  g.disputes = [{ id: NIL, status: 'open', reason: 'damaged', opened_at: '2026-09-09T10:00:00Z' }]
  const c3 = triageDeterministicChecks(g, both)
  check('checks: goods return opened after the 48 h window → goods_return_window_expired', triageCheck(c3, 'goods_return_window_expired')?.ok === false && triageCheck(c3, 'delivered_before_dispute')?.ok === true)
  const refs = triageAllowedRefs({ eventIds: ['e1'], milestoneKinds: ['work_complete'], docIds: [], statementIds: ['s1', 's2'], messageIds: [] })
  const card: DisputeTriage = { timeline: [{ at: '2026-09-04T10:00:00Z', what: 'Provider marked delivered', ref: 'event:e1' }, { at: '2026-09-05T13:00:00Z', what: 'x', ref: 'event:nope' }], claims: [{ party: 'buyer', claim: 'not done', evidence: [{ ref: 'milestone:work_complete', supports: 'contradicts' }, { ref: 'doc:zzz', supports: 'supports' }], assessment: 'contradicted' }], gaps: [], recommendation: 'release', partial_band: '30_50', rationale: ['photo shows the filing'], confidence: 'high' }
  const clamped = clampTriage(card, c1, refs)
  check('clamp: unknown refs dropped from claims and timeline; band nulled off refund_partial', clamped.claims[0]!.evidence.length === 1 && clamped.timeline.length === 1 && clamped.partial_band === null)
  check('clamp: missing statement → needs_more_info', clampTriage(card, c2, refs).recommendation === 'needs_more_info')
  check('clamp: low confidence → needs_more_info', clampTriage({ ...card, confidence: 'low' }, c1, refs).recommendation === 'needs_more_info')
  check('clamp: refund_partial without a band → 30_50', clampTriage({ ...card, recommendation: 'refund_partial', partial_band: null }, c1, refs).partial_band === '30_50')
  check('schema: amount / resolution / tool keys rejected', !disputeTriageSchema.safeParse({ ...card, amount_paise: 1 }).success && !disputeTriageSchema.safeParse({ ...card, resolution: 'release' }).success && !disputeTriageSchema.safeParse({ ...card, tool: 'x' }).success && disputeTriageSchema.safeParse(card).success)
  check('schema: recommendation is one of the four classes only', DISPUTE_TRIAGE_RECOMMENDATIONS.length === 4 && !disputeTriageSchema.safeParse({ ...card, recommendation: 'refund_all' }).success)
  const stub = stubTriage(c1, { statementRefs: ['statement:s1', 'statement:s2'], deliveryRef: 'event:e1', openedAt: '2026-09-05T13:00:00Z' })
  check('stub: schema-valid, release when delivered + complete with both statements', disputeTriageSchema.safeParse(stub).success && stub.recommendation === 'release')
}

// ── HTTP + lifecycle ─────────────────────────────────────────────────────────
async function http() {
  if (!BASE || !SUPA_URL || !ANON || !SERVICE) {
    skip('HTTP checks', 'set BASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY')
    return
  }
  const admin: SupabaseClient = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } })
  const tag = `kt_tri_${Date.now().toString(36)}`
  const created = { users: [] as string[], msmeIds: [] as string[], providerIds: [] as string[], packageIds: [] as string[], orderIds: [] as string[] }
  const settingsBefore = new Map<string, { existed: boolean; value: unknown }>()
  async function remember(key: string) {
    const { data } = await admin.from('agent_settings').select('value').eq('key', key).maybeSingle()
    settingsBefore.set(key, { existed: !!data, value: data?.value ?? null })
  }
  async function setSetting(key: string, value: unknown) {
    await admin.from('agent_settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  }
  async function mkUser(label: string, roles: string[]) {
    const email = `${tag}_${label}@killtest.amclub`
    const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
    if (error) throw new Error(`${label}: ${error.message}`)
    created.users.push(data.user.id)
    await admin.from('users').insert({ id: data.user.id, email, roles, preferred_locale: 'en' })
    const anon = createClient(SUPA_URL, ANON, { auth: { persistSession: false } })
    const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
    return { uid: data.user.id, token: s.session!.access_token, email }
  }
  const api = (token: string, p: string, body?: unknown, method = 'POST') =>
    fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) })

  async function placeAndComplete(buyer: { token: string }, prov: { token: string }, packageId: string): Promise<string> {
    const co = await api(buyer.token, '/api/v1/checkout', { packageId, idempotencyKey: crypto.randomUUID() })
    const cod = (await json(co)) as any
    if (!cod.simulated) throw new Error(`checkout not simulated: ${co.status} ${JSON.stringify(cod).slice(0, 120)}`)
    const sim = (await json(await api(buyer.token, '/api/v1/checkout/simulate', { checkoutSessionId: cod.checkoutSessionId }))) as any
    const orderId = String(sim.orderId)
    created.orderIds.push(orderId)
    for (const [who, action] of [[prov, 'accept'], [buyer, 'submit_requirements'], [prov, 'start'], [prov, 'deliver'], [buyer, 'accept_delivery']] as const) {
      const r = await api(who.token, `/api/v1/orders/${orderId}/transition`, { action })
      await json(r)
      if (!r.ok) throw new Error(`${action} → ${r.status}`)
    }
    return orderId
  }
  const disputeOf = async (orderId: string) => {
    const { data } = await admin.from('disputes').select('id, status, resolution, resolution_amount_paise').eq('order_id', orderId).maybeSingle()
    if (!data) return null
    const { data: t } = await admin.from('disputes').select('triage_id').eq('id', (data as any).id).maybeSingle() // absent before 0037
    return { ...(data as any), triage_id: (t as any)?.triage_id ?? null }
  }
  // 0037 applied? (the statement route reads disputes.triage_id and writes dispute_statements — migration-first deploy rule)
  // A head-only count does not surface a missing table in supabase-js; a real select does.
  const migrated = !(await admin.from('dispute_statements').select('id').limit(1)).error
  const triagesOf = async (disputeId: string) => ((await admin.from('dispute_triages').select('id, run_id, triage, checks, decision, decision_id, notified_at, created_at, stub').eq('dispute_id', disputeId).order('created_at', { ascending: true })).data ?? []) as any[]

  console.log(`\nverify-dispute-triage → ${BASE}\n`)
  const probe = await fetch(`${BASE}/api/v1/agent/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  await json(probe)
  const flagOn = probe.status !== 404

  try {
    // Fixture: buyer, provider (active, bank verified), a third user, an admin/ops user; a package in a seeded category.
    const buyer = await mkUser('buyer', ['msme'])
    const prov = await mkUser('prov', ['provider'])
    const third = await mkUser('third', ['msme'])
    const ops = await mkUser('ops', ['admin', 'ops'])
    const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'Triage Buyer Co', state: 'KA', sector: 'services' }).select('id').single()
    created.msmeIds.push(msme!.id)
    const { data: msme3 } = await admin.from('msme_profiles').insert({ user_id: third.uid, business_name: 'Third Co', state: 'KA', sector: 'services' }).select('id').single()
    created.msmeIds.push(msme3!.id)
    const { data: pp } = await admin.from('provider_profiles').insert({ user_id: prov.uid, legal_name: 'Triage Prov Pvt', display_name: 'Triage Prov', slug: `${tag}-prov`, state: 'KA', city: 'X', languages: ['en'], status: 'active' }).select('id').single()
    created.providerIds.push(pp!.id)
    await admin.from('provider_bank_accounts').insert({ provider_id: pp!.id, account_number_enc: 'enc:killtest', ifsc: 'HDFC0000001', account_holder: 'Triage Prov', penny_drop_verified: true, razorpay_route_account_id: 'acc_KILLTEST0000002' })
    const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
    await admin.from('provider_categories').insert({ provider_id: pp!.id, category_id: cat!.id })
    const { data: pkg } = await admin.from('packages').insert({ provider_id: pp!.id, category_id: cat!.id, slug: `${tag}-pkg`, title_i18n: { en: 'Triage pkg', hi: 'T' }, price_paise: 100000, discount_bps: 0, delivery_days: 3, revision_count: 1, status: 'active', scope_included: ['x'], scope_excluded: [], deliverables: ['y'] }).select('id').single()
    created.packageIds.push(pkg!.id)

    // Agent surface inert while dark / statements are spine either way.
    for (const [m, p] of [['GET', '/api/v1/agent/admin/triages'], ['GET', '/api/v1/agent/admin/triages/stats'], ['GET', `/api/v1/agent/admin/triages/${NIL}`], ['POST', `/api/v1/agent/admin/triages/${NIL}/notify`]] as const) {
      const r = await fetch(`${BASE}${p}`, { method: m, headers: { 'Content-Type': 'application/json' }, ...(m === 'POST' ? { body: '{}' } : {}) })
      await json(r)
      if (!flagOn) check(`flag OFF: ${m} ${p} 404s`, r.status === 404, `status ${r.status}`)
      else check(`flag ON: ${m} ${p} refuses an anonymous caller`, r.status === 401 || r.status === 503, `status ${r.status}`)
    }

    // Order 1: dispute + statements (spine).
    const o1 = await placeAndComplete(buyer, prov, pkg!.id)
    const { data: ord1 } = await admin.from('orders').select('total_paise, provider_earning_paise').eq('id', o1).single()
    const total = Number(ord1!.total_paise), earning = Number(ord1!.provider_earning_paise)
    if (migrated) {
      const stmtBefore = await api(buyer.token, `/api/v1/orders/${o1}/dispute/statement`, { body: 'The GST return they filed used the wrong turnover figure and I now face a notice.' })
      await json(stmtBefore)
      check('statement before a dispute → 409 dispute_not_open', stmtBefore.status === 409, `status ${stmtBefore.status}`)
    }
    const raise = await api(buyer.token, `/api/v1/orders/${o1}/transition`, { action: 'raise_dispute', disputeReason: 'quality' })
    const raiseBody = await json(raise)
    const d1 = await disputeOf(o1)
    if (!d1) throw new Error(`raise_dispute did not create a dispute row: ${raise.status} ${JSON.stringify(raiseBody).slice(0, 200)}`)
    check('raise_dispute → dispute row open, payout held (unchanged)', raise.status === 200 && d1?.status === 'open' && ((await admin.from('payouts').select('status').eq('order_id', o1).maybeSingle()).data as any)?.status === 'held')
    const invBefore = ((await admin.from('ai_invocations').select('id').eq('task_class', 'dispute_triage')).data ?? []).length

    if (!migrated) {
      // Pre-0037 (the pre-approval flag-off run): the spine needs disputes.triage_id + dispute_statements. Prove what does
      // not depend on it and skip the rest with the reason; the post-0037 flag-off run in the gate proves the spine dark.
      skip('statement spine (POST/PATCH/GET, masking, 403/409, admin GET statements + thread)', '0037 not applied yet on this DB — proven in the post-migration flag-off run')
      const { error: triErr } = await admin.from('dispute_triages').select('id').limit(1)
      check('no dispute_triages table while dark (pre-0037: table absent)', !!triErr, triErr ? triErr.message.slice(0, 60) : 'table exists')
      const refundX0 = 20_000
      const expPaid0 = Math.round((earning * (total - refundX0)) / total)
      const q1 = (await json(await api(ops.token, `/api/v1/admin/disputes/${d1.id}/resolve`, { resolution: 'refund_partial', amountPaise: refundX0 }))) as any
      const q2 = (await json(await api(ops.token, `/api/v1/admin/disputes/${d1.id}/resolve`, { resolution: 'refund_partial', amountPaise: refundX0 }))) as any
      const { data: pay0 } = await admin.from('payments').select('id').eq('order_id', o1).single()
      const { data: refunds0 } = await admin.from('refunds').select('amount_paise').eq('payment_id', pay0!.id)
      const { data: payout0 } = await admin.from('payouts').select('status, amount_paise').eq('order_id', o1).single()
      check('resolve without triage_id: refund partial paise-exact, provider paid, second call `already` (byte-identical money path)', q1.ok === true && !('triage_id' in q1) && (refunds0 ?? []).length === 1 && Number(refunds0![0]!.amount_paise) === refundX0 && Number(payout0!.amount_paise) === expPaid0 && q2.already === true, `refunds ${refunds0?.length} payout ${payout0?.amount_paise}/${payout0?.status} exp ${expPaid0}`)
      skip('flag ON lifecycle', flagOn ? '0037 not applied yet' : 'server is dark (AGENT_ENABLED=false)')
      return
    }

    const s1 = await api(buyer.token, `/api/v1/orders/${o1}/dispute/statement`, { body: 'The GST return they filed used the wrong turnover figure and I now face a notice. Call me on 98765 43210.' })
    const s1b = (await json(s1)) as any
    check('buyer POST statement → 201, contact masked, event + counter-party notification', s1.status === 201 && s1b.redacted === true && !JSON.stringify(s1b.statements).includes('98765') && ((await admin.from('order_events').select('id').eq('order_id', o1).eq('event', 'dispute_statement')).data ?? []).length === 1 && ((await admin.from('notifications').select('id').eq('user_id', prov.uid).eq('kind', 'dispute_statement')).data ?? []).length === 1, `status ${s1.status} ${JSON.stringify(s1b).slice(0, 120)}`)
    const s1again = await api(buyer.token, `/api/v1/orders/${o1}/dispute/statement`, { body: 'A second statement from the same party must be refused.' })
    await json(s1again)
    check('second buyer POST → 409 statement_exists', s1again.status === 409, `status ${s1again.status}`)
    const s3 = await api(third.token, `/api/v1/orders/${o1}/dispute/statement`, { body: 'I am not a party to this order at all, sorry.' })
    await json(s3)
    check('a third user → 403', s3.status === 403, `status ${s3.status}`)
    const bad = await api(buyer.token, `/api/v1/orders/${o1}/dispute/statement`, { body: 'Edited statement with a document that is not on this order.', document_ids: [NIL] }, 'PATCH')
    await json(bad)
    check('PATCH with a foreign document id → 422', bad.status === 422, `status ${bad.status}`)
    const patch = await api(buyer.token, `/api/v1/orders/${o1}/dispute/statement`, { body: 'The GST return they filed used the wrong turnover figure; the notice is attached below.' }, 'PATCH')
    await json(patch)
    check('PATCH while open and untriaged → 200', patch.status === 200, `status ${patch.status}`)
    const getS = (await json(await api(prov.token, `/api/v1/orders/${o1}/dispute/statement`, undefined, 'GET'))) as any
    check("GET as the provider → the buyer's (redacted) statement, editable, role provider", getS.role === 'provider' && getS.editable === true && getS.statements?.length === 1 && getS.statements[0].role === 'buyer')

    if (!flagOn) {
      // Provider statement, admin GET, no triage rows, resolve byte-identical.
      const s2 = await api(prov.token, `/api/v1/orders/${o1}/dispute/statement`, { body: 'We filed GSTR-3B with the figures the buyer sent on 3 September; the ARN is attached.' })
      const s2b = (await json(s2)) as any
      check('provider POST → 201; the re-triage request reports agent_disabled', s2.status === 201 && s2b.retriage?.reason === 'agent_disabled', JSON.stringify(s2b.retriage))
      const adm = (await json(await api(ops.token, `/api/v1/admin/disputes/${d1.id}`, undefined, 'GET'))) as any
      check('admin dispute GET carries both statements + thread + events with actor roles; no triage key while dark', Array.isArray(adm.statements) && adm.statements.length === 2 && Array.isArray(adm.thread) && !('triage' in adm) && adm.events?.every((e: any) => typeof e.actor_role === 'string'))
      const { count: tri } = await admin.from('dispute_triages').select('id', { count: 'exact', head: true }).eq('dispute_id', d1.id)
      check('no dispute_triages row while dark', (tri ?? 0) === 0)
      const refundX = 20_000
      const expPaid = Math.round((earning * (total - refundX)) / total)
      const r1 = (await json(await api(ops.token, `/api/v1/admin/disputes/${d1.id}/resolve`, { resolution: 'refund_partial', amountPaise: refundX }))) as any
      const r2 = (await json(await api(ops.token, `/api/v1/admin/disputes/${d1.id}/resolve`, { resolution: 'refund_partial', amountPaise: refundX }))) as any
      const { data: pay } = await admin.from('payments').select('id').eq('order_id', o1).single()
      const { data: refunds } = await admin.from('refunds').select('amount_paise').eq('payment_id', pay!.id)
      const { data: payout } = await admin.from('payouts').select('status, amount_paise').eq('order_id', o1).single()
      check('resolve without triage_id: refund partial paise-exact, provider paid, second call `already` (byte-identical money path)', r1.ok === true && !('triage_id' in r1) && (refunds ?? []).length === 1 && Number(refunds![0]!.amount_paise) === refundX && Number(payout!.amount_paise) === expPaid && r2.already === true, `refunds ${refunds?.length} payout ${payout?.amount_paise}/${payout?.status} exp ${expPaid}`)
      const locked = await api(buyer.token, `/api/v1/orders/${o1}/dispute/statement`, { body: 'Trying to edit after the dispute was resolved.' }, 'PATCH')
      await json(locked)
      check('PATCH after resolution → 409 dispute_not_open', locked.status === 409, `status ${locked.status}`)
      skip('flag ON lifecycle', 'server is dark (AGENT_ENABLED=false)')
      return
    }

    // ── flag ON: the agent in-process ────────────────────────────────────────
    for (const k of ['ops_user_id', 'agents_enabled', 'cohort_user_ids']) await remember(k)
    const enabledBefore = (settingsBefore.get('agents_enabled')?.value ?? {}) as Record<string, boolean>
    const cohortBefore = (settingsBefore.get('cohort_user_ids')?.value ?? []) as string[]
    await setSetting('ops_user_id', ops.uid)
    await setSetting('agents_enabled', { ...enabledBefore, dispute_triage: true })
    await setSetting('cohort_user_ids', [...new Set([...cohortBefore, ops.uid])])
    await admin.from('agent_grants').insert({ user_id: ops.uid, persona: 'ops', scopes: ['read_order_evidence', 'summarize_dispute'], channel: 'web', consent: { surface: 'verify', text_version: 'v1', at: new Date().toISOString() } })
    process.env['AGENT_ENABLED'] = 'true'
    process.env['API_URL'] = BASE
    loadDefaultPrompts()
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rt = require('../../agent-runtime/src/agents/dispute-triage/index') as typeof import('../../agent-runtime/src/agents/dispute-triage/index')
    const deps: RunAgentDeps = { ledger: createSupabaseLedger(admin), gateway: createGateway(), makeBudget: () => createNoopBudget(), apiBaseUrl: BASE, makeToken: async () => ops.token }
    const runTriage = (disputeId: string, orderId: string) => runAgent(rt.disputeTriageAgent, deps, { userId: ops.uid, surface: 'system', subjectType: 'dispute', subjectId: disputeId }, { disputeId, orderId })

    // The web trigger is gated correctly but cannot reach a runtime here (enqueue → not_configured).
    const { maybeEnqueueDisputeTriage } = await loadTrigger()
    if (maybeEnqueueDisputeTriage) {
      const trig = await maybeEnqueueDisputeTriage(admin, { orderId: o1, disputeId: d1.id })
      check('trigger: gates pass (flag + ops_user_id + agent + cohort) and it reaches the enqueue (not_configured here)', trig.enqueued === false && trig.reason === 'not_configured', JSON.stringify(trig))
    } else skip('trigger gates', 'lib/agent/triage-trigger not importable on this rig')

    // Triage 1: only the buyer's statement → needs_more_info.
    const t1 = await runTriage(d1.id, o1)
    const tri1 = await triagesOf(d1.id)
    const inv1 = ((await admin.from('ai_invocations').select('run_id, tier, status').eq('task_class', 'dispute_triage')).data ?? []) as any[]
    check('triage 1 (one statement) → run completed, ONE ai_invocations row (task dispute_triage, frontier, run_id), dispute_triages row, disputes.triage_id set', t1.status === 'completed' && tri1.length === 1 && inv1.length === invBefore + 1 && inv1.some((i) => i.run_id === t1.runId && i.tier === 'frontier') && (await disputeOf(o1))?.triage_id === tri1[0].id, JSON.stringify(t1).slice(0, 160))
    check('triage 1 recommends needs_more_info (provider silent) with the missing-statement check failed; strict card', tri1[0]?.triage?.recommendation === 'needs_more_info' && tri1[0]?.checks?.some((c: any) => c.name === 'statement_missing_provider' && !c.ok) && disputeTriageSchema.safeParse(tri1[0]?.triage).success)
    check('notify: the runtime asked the web to notify (no runtime secret here → not notified; notified_at null)', tri1[0]?.notified_at === null)
    const locked1 = await api(buyer.token, `/api/v1/orders/${o1}/dispute/statement`, { body: 'Trying to edit my statement after the triage card exists.' }, 'PATCH')
    await json(locked1)
    check('statement PATCH after a triage → 409 triage_exists', locked1.status === 409, `status ${locked1.status}`)

    // Provider statement → the route asks for a re-triage (gated; not_configured here) → run it in-process.
    const s2 = await api(prov.token, `/api/v1/orders/${o1}/dispute/statement`, { body: 'We filed GSTR-3B with the figures the buyer sent on 3 September; the ARN is attached as the work-complete photo.' })
    const s2b = (await json(s2)) as any
    check('provider POST → 201 and the re-triage request passed every gate (not_configured = the enqueue itself)', s2.status === 201 && s2b.retriage?.reason === 'not_configured', JSON.stringify(s2b.retriage))
    const t2 = await runTriage(d1.id, o1)
    const tri2 = await triagesOf(d1.id)
    check('re-triage → a second row, triage_id moves to it, history length 2, both statements on the card', t2.status === 'completed' && tri2.length === 2 && (await disputeOf(o1))?.triage_id === tri2[1].id && tri2[1]?.checks?.every((c: any) => !c.name.startsWith('statement_missing') || c.ok))
    check('triage 2 recommends release (delivered + work-complete on record; stub card) with no band', tri2[1]?.triage?.recommendation === 'release' && tri2[1]?.triage?.partial_band === null)
    const adm = (await json(await api(ops.token, `/api/v1/admin/disputes/${d1.id}`, undefined, 'GET'))) as any
    check('admin dispute GET carries the latest triage + history(2) + statements', adm.triage?.id === tri2[1].id && adm.triage_history?.length === 2 && adm.statements?.length === 2)
    const list = (await json(await api(ops.token, '/api/v1/agent/admin/triages?status=pending', undefined, 'GET'))) as any
    check('GET /agent/admin/triages lists the pending triages with dispute + order summary', Array.isArray(list.triages) && list.triages.some((x: any) => x.triage?.id === tri2[1].id && x.order?.id === o1))

    // Resolve with a foreign triage_id → 422 before any money moves.
    const o2 = await placeAndComplete(buyer, prov, pkg!.id)
    await json(await api(buyer.token, `/api/v1/orders/${o2}/transition`, { action: 'raise_dispute', disputeReason: 'other' }))
    const d2 = await disputeOf(o2)
    const foreign = await api(ops.token, `/api/v1/admin/disputes/${d2.id}/resolve`, { resolution: 'release', triage_id: tri2[1].id })
    await json(foreign)
    check('resolve with a foreign triage_id → 422 triage_mismatch (dispute still open, no money moved)', foreign.status === 422 && (await disputeOf(o2))?.status === 'open', `status ${foreign.status}`)

    // Resolve dispute 1 with its triage → one ai_decisions row, decision columns once, money path unchanged.
    const refundX = 20_000
    const expPaid = Math.round((earning * (total - refundX)) / total)
    const decBefore = ((await admin.from('ai_decisions').select('id').eq('feature', 'dispute_triage')).data ?? []).length
    const r1 = (await json(await api(ops.token, `/api/v1/admin/disputes/${d1.id}/resolve`, { resolution: 'refund_partial', amountPaise: refundX, triage_id: tri2[1].id }))) as any
    const decs = ((await admin.from('ai_decisions').select('id, feature, tool, run_id, proposed, final').eq('feature', 'dispute_triage')).data ?? []) as any[]
    const dec = decs.find((d) => d.id === r1.triage_decision_id)
    const tri3 = await triagesOf(d1.id)
    check('resolve with triage_id → ONE ai_decisions row (feature dispute_triage, run_id = the triage run, tool summarize_dispute, proposed class, final resolution + amount)', r1.ok === true && decs.length === decBefore + 1 && !!dec && dec.tool === 'summarize_dispute' && dec.run_id === tri2[1].run_id && dec.proposed?.recommendation === 'release' && dec.final?.resolution === 'refund_partial' && dec.final?.amount_paise === refundX, JSON.stringify(r1).slice(0, 160))
    check('triage decision columns written once (decision, decided_by, decision_id); the earlier triage untouched', tri3[1]?.decision === 'refund_partial' && tri3[1]?.decision_id === dec?.id && tri3[0]?.decision === null)
    const { data: pay } = await admin.from('payments').select('id').eq('order_id', o1).single()
    const { data: refunds } = await admin.from('refunds').select('amount_paise').eq('payment_id', pay!.id)
    const { data: payout } = await admin.from('payouts').select('status, amount_paise').eq('order_id', o1).single()
    check('money path unchanged: one refund row paise-exact, provider paid the retained share', (refunds ?? []).length === 1 && Number(refunds![0]!.amount_paise) === refundX && Number(payout!.amount_paise) === expPaid, `refunds ${refunds?.length} payout ${payout?.amount_paise} exp ${expPaid}`)
    const r2 = (await json(await api(ops.token, `/api/v1/admin/disputes/${d1.id}/resolve`, { resolution: 'refund_partial', amountPaise: refundX, triage_id: tri2[1].id }))) as any
    const decsAfter = ((await admin.from('ai_decisions').select('id').eq('feature', 'dispute_triage')).data ?? []).length
    check('second resolve → `already`, no second decision row, no second money move', r2.already === true && decsAfter === decBefore + 1 && ((await admin.from('refunds').select('id').eq('payment_id', pay!.id)).data ?? []).length === 1)
    const resolvedTriage = await runTriage(d1.id, o1)
    check('a triage job on a resolved dispute fails terminally (dispute_resolved)', resolvedTriage.status === 'failed' && resolvedTriage.error === 'dispute_resolved', JSON.stringify(resolvedTriage).slice(0, 120))

    // Cap: dispute 2 → three triages, the fourth is refused.
    const runs2 = [await runTriage(d2.id, o2), await runTriage(d2.id, o2), await runTriage(d2.id, o2)]
    const fourth = await runTriage(d2.id, o2)
    check('cap: three triages per dispute, the fourth fails terminally with triage_cap', runs2.every((r) => r.status === 'completed') && (await triagesOf(d2.id)).length === 3 && fourth.status === 'failed' && fourth.error === 'triage_cap', JSON.stringify(fourth).slice(0, 100))
    const capTrig = maybeEnqueueDisputeTriage ? await maybeEnqueueDisputeTriage(admin, { orderId: o2, disputeId: d2.id }) : null
    check('the web trigger also refuses past the cap (triage_cap)', capTrig?.reason === 'triage_cap', JSON.stringify(capTrig))
    await json(await api(ops.token, `/api/v1/admin/disputes/${d2.id}/resolve`, { resolution: 'release' }))
    skip('delegated token without summarize_dispute scope → 403; HMAC mint; pg-boss queue; runtime notify', 'agent driven in-process with the ops session token (no SUPABASE_JWT_SECRET / AGENT_RUNTIME_SECRET here) — the scope refusal is the S1.4 route pattern')
    skip('goods dispute (kind goods, goods_evidence in the trusted parts)', 'MART_ENABLED is off on this rig; the parts builder covers goods in its unit test and the golden set')
  } finally {
    const errors: string[] = []
    const del = async (label: string, q: PromiseLike<{ error: { message: string } | null }>) => { const { error } = await q; if (error && !/Could not find the table/.test(error.message)) errors.push(`${label}: ${error.message}`) }
    try {
      const users = created.users
      const { data: runs } = users.length ? await admin.from('agent_runs').select('id').in('user_id', users) : { data: [] }
      const runIds = ((runs ?? []) as { id: string }[]).map((r) => r.id)
      for (const oid of created.orderIds) {
        const { data: disp } = await admin.from('disputes').select('id').eq('order_id', oid).maybeSingle()
        if (disp) {
          await del('triages', admin.from('dispute_triages').delete().eq('dispute_id', disp.id))
          await del('statements', admin.from('dispute_statements').delete().eq('dispute_id', disp.id))
        }
      }
      if (users.length) await del('decisions', admin.from('ai_decisions').delete().in('decided_by', users))
      for (const mid of created.msmeIds) await del('checkout_sessions', admin.from('checkout_sessions').delete().eq('msme_id', mid))
      for (const oid of created.orderIds) {
        const { data: pays } = await admin.from('payments').select('id').eq('order_id', oid)
        for (const p of pays ?? []) await del('refunds', admin.from('refunds').delete().eq('payment_id', p.id))
        await del('disputes', admin.from('disputes').delete().eq('order_id', oid))
        await del('payout_dossiers', admin.from('payout_dossiers').delete().eq('order_id', oid))
        await del('payouts', admin.from('payouts').delete().eq('order_id', oid))
        await del('payments', admin.from('payments').delete().eq('order_id', oid))
        await del('invoices', admin.from('invoices').delete().eq('order_id', oid))
        await del('order_events', admin.from('order_events').delete().eq('order_id', oid))
        await del('order_milestones', admin.from('order_milestones').delete().eq('order_id', oid))
        await del('order_documents', admin.from('order_documents').delete().eq('order_id', oid))
        await del('orders', admin.from('orders').delete().eq('id', oid))
      }
      if (runIds.length) {
        await del('events', admin.from('agent_events').delete().in('run_id', runIds))
        await del('invocations', admin.from('ai_invocations').delete().in('run_id', runIds))
      }
      if (users.length) {
        await del('invocations(user)', admin.from('ai_invocations').delete().in('user_id', users))
        await del('runs', admin.from('agent_runs').delete().in('user_id', users))
        await del('grants', admin.from('agent_grants').delete().in('user_id', users))
        await del('notifications', admin.from('notifications').delete().in('user_id', users))
        await del('audit', admin.from('audit_logs').delete().in('actor_id', users))
      }
      for (const id of created.packageIds) await del('packages', admin.from('packages').delete().eq('id', id))
      for (const id of created.providerIds) {
        await del('bank', admin.from('provider_bank_accounts').delete().eq('provider_id', id))
        await del('provider_categories', admin.from('provider_categories').delete().eq('provider_id', id))
        await del('provider_profiles', admin.from('provider_profiles').delete().eq('id', id))
      }
      for (const mid of created.msmeIds) await del('msme_profiles', admin.from('msme_profiles').delete().eq('id', mid))
      for (const [key, before] of settingsBefore) {
        if (before.existed) await setSetting(key, before.value)
        else await admin.from('agent_settings').delete().eq('key', key)
      }
      for (const uid of users) {
        await del('users', admin.from('users').delete().eq('id', uid))
        const { error } = await admin.auth.admin.deleteUser(uid)
        if (error) errors.push(`auth ${uid}: ${error.message}`)
      }
      const residue: string[] = []
      const { count: u } = await admin.from('users').select('id', { count: 'exact', head: true }).like('email', `${tag}%`)
      if (u) residue.push(`users=${u}`)
      if (created.orderIds.length) {
        for (const [table, col] of [['orders', 'id'], ['disputes', 'order_id'], ['dispute_triages', 'order_id'], ['dispute_statements', 'order_id'], ['payouts', 'order_id']] as const) {
          const { count } = await admin.from(table).select('*', { count: 'exact', head: true }).in(col, created.orderIds)
          if (count) residue.push(`${table}=${count}`)
        }
      }
      if (users.length) {
        for (const [table, col] of [['agent_runs', 'user_id'], ['ai_decisions', 'decided_by'], ['ai_invocations', 'user_id'], ['agent_grants', 'user_id'], ['provider_profiles', 'user_id']] as const) {
          const { count } = await admin.from(table).select('*', { count: 'exact', head: true }).in(col, users)
          if (count) residue.push(`${table}=${count}`)
        }
      }
      if (errors.length) record('cleanup', 'FAIL', errors.join(' | '))
      else check(`cleanup: zero residue (${created.users.length} users, ${created.orderIds.length} orders, settings restored)`, residue.length === 0, residue.join(', '))
    } catch (e) {
      record('cleanup', 'FAIL', (e as Error).message)
    }
  }
}

/** The web trigger outside Next: `server-only` resolved to its empty build (the S1.5 loadRelease pattern). */
async function loadTrigger(): Promise<{ maybeEnqueueDisputeTriage: ((admin: SupabaseClient, d: { orderId: string; disputeId: string }) => Promise<{ enqueued: boolean; reason?: string }>) | null }> {
  try {
    const Module = (await import('node:module')).default as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string }
    const orig = Module._resolveFilename
    const empty = path.join(path.dirname(require.resolve('server-only')), 'empty.js')
    Module._resolveFilename = function (request: string, ...rest: unknown[]) {
      if (request === 'server-only') return empty
      return orig.call(this, request, ...rest)
    }
    const mod = (await import('../lib/agent/triage-trigger')) as { maybeEnqueueDisputeTriage: (admin: SupabaseClient, d: { orderId: string; disputeId: string }) => Promise<{ enqueued: boolean; reason?: string }> }
    return { maybeEnqueueDisputeTriage: mod.maybeEnqueueDisputeTriage }
  } catch (e) {
    console.error('  (trigger import not possible here:', (e as Error).message.split('\n')[0], ')')
    return { maybeEnqueueDisputeTriage: null }
  }
}

async function main() {
  offline()
  try {
    await http()
  } catch (e) {
    record('lifecycle aborted', 'FAIL', (e as Error).message)
  }
  console.log(`\nverify-dispute-triage ${BASE ? `→ ${BASE}` : '(offline)'}\n`)
  for (const r of rows) console.log(`  ${r.status === 'pass' ? '✓' : r.status === 'skip' ? '⏭' : '✗'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
  const skipped = rows.filter((r) => r.status === 'skip').length
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${rows.length} checks: ${rows.length - failed - skipped} pass, ${skipped} skipped, ${failed} FAIL\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 2
})
/* eslint-enable @typescript-eslint/no-explicit-any */
