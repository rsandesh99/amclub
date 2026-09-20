/**
 * verify-payout-dossier — S1.4 Payout-Evidence agent (verify-* convention).
 *
 * Three modes, like verify-agents:
 *   OFFLINE (always): recommendDossier table; dHash duplicate detection on the
 *     golden fixtures (needs sharp — apps/web has it); computeDossierChecks on
 *     the fixture evidence payloads (all-good → approve; missing work_complete
 *     photo / amount mismatch / open dispute / duplicate photo / screenshot
 *     finding → hold; goods all-good → approve). No server, no secrets.
 *   HTTP flag-OFF (BASE_URL): every /api/v1/agent/admin/dossiers* → 404; the
 *     evidence GET is an ORDINARY admin read (NOT an agent surface) so it
 *     answers 401 unauthenticated (and 404-for-a-missing-order with
 *     AGENT_VERIFY_ADMIN_TOKEN) — not 404-by-flag.
 *   LIVE (DOSSIER_VERIFY_LIVE=1 + BASE_URL + AGENT_RUNTIME_URL + AGENT_RUNTIME_SECRET
 *     + NEXT_PUBLIC_SUPABASE_URL/ANON_KEY + SUPABASE_SERVICE_ROLE_KEY; BASE_URL
 *     must be localhost unless DOSSIER_VERIFY_ALLOW_REMOTE=1): kill-test users +
 *     a services order through the S0.3 lifecycle → payout held → job → poll the
 *     dossier → 'approve' (stub) → the ops token CANNOT release (403) → founder
 *     Approve with dossier_id → payout leaves held, ai_decisions row, dossier
 *     decision 'approve' → second Approve 409 → a second order's dossier →
 *     Hold → decision 'hold', payout still held → notification rows == dossiers.
 *     Settings touched are restored and every row removed in finally.
 *
 * Run: pnpm --filter @amclub/web agents:verify:dossier
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { existsSync, readFileSync } from 'fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  DOSSIER_CHECK_NAMES,
  duplicatePhotoAnomaly,
  recommendDossier,
  type DossierCheck,
  type OrderEvidence,
  type PhotoFinding,
} from '@amclub/shared'
import {
  computeDossierChecks,
  dhashFromImage,
  goodsEvidenceFixture,
  hammingHex,
  servicesEvidenceFixture,
  sharpAvailable,
  signRuntimeCredential,
} from '@amclub/agent-core'

const BASE = (process.env['BASE_URL'] || '').replace(/\/$/, '')
const LIVE = process.env['DOSSIER_VERIFY_LIVE'] === '1'
const RUNTIME_URL = process.env['AGENT_RUNTIME_URL'] || ''
const RUNTIME_SECRET = process.env['AGENT_RUNTIME_SECRET'] || ''
const ADMIN_TOKEN = process.env['AGENT_VERIFY_ADMIN_TOKEN'] || ''
const SUPA_URL = process.env['NEXT_PUBLIC_SUPABASE_URL'] || ''
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'] || ''
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY'] || ''
const NIL = '00000000-0000-0000-0000-000000000000'
const PHOTOS = path.resolve(__dirname, '../../../packages/agent-core/golden/photos')

type Status = 'pass' | 'FAIL' | 'skip'
const rows: { name: string; status: Status; detail?: string }[] = []
let failed = 0
function record(name: string, status: Status, detail?: string) {
  rows.push({ name, status, ...(detail ? { detail } : {}) })
  if (status === 'FAIL') failed++
}
const check = (name: string, cond: boolean, detail?: string) => record(name, cond ? 'pass' : 'FAIL', detail)
const drain = (res: Response) => res.json().catch(() => null) as Promise<unknown>
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── OFFLINE ──────────────────────────────────────────────────────────────────
const okFinding = (doc_id: string): PhotoFinding => ({ doc_id, looks_like_work: true, matches_stage: true, is_screenshot_or_document: false, concerns: [], confidence: 0.9 })
const allOk = (): DossierCheck[] => DOSSIER_CHECK_NAMES.map((name) => ({ name, ok: true, detail: null }))
const findingsFor = (ev: OrderEvidence) => [...ev.milestones.filter((m) => m.photo).map((m) => okFinding(m.photo!.doc_id)), ...(ev.goods_evidence?.photos ?? []).map((p) => okFinding(p.doc_id))]
function evaluate(ev: OrderEvidence, over: { findings?: PhotoFinding[]; duplicates?: { doc_id: string; prior_doc_id: string; distance: number }[] } = {}) {
  const findings = over.findings ?? findingsFor(ev)
  const r = computeDossierChecks({ evidence: ev, findings, duplicates: over.duplicates ?? [] })
  return { ...r, rec: recommendDossier({ checks: r.checks, findings, anomalies: r.anomalies }) }
}

async function offline() {
  // recommendDossier table
  check('rule: all ok → approve', recommendDossier({ checks: allOk(), findings: [okFinding('a')], anomalies: [] }).recommendation === 'approve')
  check('rule: failing check → hold', recommendDossier({ checks: allOk().map((c) => (c.name === 'buyer_confirmed' ? { ...c, ok: false } : c)), findings: [], anomalies: [] }).recommendation === 'hold')
  check('rule: missing check → hold', recommendDossier({ checks: allOk().slice(1), findings: [], anomalies: [] }).rationale[0] === `check_missing:${DOSSIER_CHECK_NAMES[0]}`)
  check('rule: anomaly → hold', recommendDossier({ checks: allOk(), findings: [], anomalies: [duplicatePhotoAnomaly('a', 'b')] }).recommendation === 'hold')
  check('rule: low-confidence finding → hold', recommendDossier({ checks: allOk(), findings: [{ ...okFinding('a'), confidence: 0.5 }], anomalies: [] }).recommendation === 'hold')
  check('rule: perfect finding cannot rescue a failing check', recommendDossier({ checks: allOk().map((c) => (c.name === 'no_open_dispute' ? { ...c, ok: false } : c)), findings: [{ ...okFinding('a'), confidence: 1 }], anomalies: [] }).recommendation === 'hold')

  // checks() on fixture evidence
  const s0 = evaluate(servicesEvidenceFixture())
  check('checks: all-good services → approve', s0.rec.recommendation === 'approve' && s0.checks.length === 10, s0.rec.rationale.join(','))
  const s1 = servicesEvidenceFixture()
  s1.milestones = s1.milestones.map((m) => (m.kind === 'work_complete' ? { ...m, photo: null } : m))
  check('checks: missing work_complete photo → hold', evaluate(s1).rec.rationale.includes('check:work_complete_photo'))
  const s2 = servicesEvidenceFixture()
  s2.payments = [{ ...s2.payments[0]!, amount_paise: 1 }]
  const r2 = evaluate(s2)
  check('checks: amount mismatch → hold + anomaly', r2.rec.recommendation === 'hold' && r2.anomalies.includes('amount_mismatch'))
  const s3 = servicesEvidenceFixture()
  s3.disputes = [{ id: NIL, status: 'open', reason: 'quality', opened_at: '2026-09-06T00:00:00Z' }]
  const r3 = evaluate(s3)
  check('checks: open dispute → hold + anomaly', r3.rec.recommendation === 'hold' && r3.anomalies.includes('dispute_open'))
  const s4 = servicesEvidenceFixture()
  const wcDoc = s4.milestones.find((m) => m.kind === 'work_complete')!.photo!.doc_id
  const r4 = evaluate(s4, { duplicates: [{ doc_id: wcDoc, prior_doc_id: NIL, distance: 2 }] })
  check('checks: duplicate photo → hold + anomaly', r4.rec.recommendation === 'hold' && r4.anomalies.some((a) => a.startsWith('duplicate_photo:')))
  const s5 = servicesEvidenceFixture()
  const f5 = findingsFor(s5)
  f5[0] = { ...f5[0]!, is_screenshot_or_document: true }
  check('checks: screenshot finding → hold', evaluate(s5, { findings: f5 }).rec.rationale.includes(`photo:${f5[0]!.doc_id}:screenshot_or_document`))
  check('checks: all-good goods → approve', evaluate(goodsEvidenceFixture()).rec.recommendation === 'approve')

  // dHash on golden fixtures
  if (!(await sharpAvailable()) || !existsSync(path.join(PHOTOS, 'work_1.jpg'))) {
    record('dHash golden fixtures', 'skip', 'sharp or golden/photos absent')
    return
  }
  const h = async (f: string) => dhashFromImage(readFileSync(path.join(PHOTOS, f)))
  const base = await h('work_1.jpg')
  const dA = hammingHex(base, await h('dup_a.jpg'))
  const dB = hammingHex(base, await h('dup_b.jpg'))
  const dOther = hammingHex(base, await h('work_2.jpg'))
  const dDoc = hammingHex(base, await h('document_1.jpg'))
  check('dHash: dup_a within 6 bits of work_1', dA <= 6, `distance ${dA}`)
  check('dHash: dup_b within 6 bits of work_1', dB <= 6, `distance ${dB}`)
  check('dHash: a different work photo is > 6 bits away', dOther > 6, `distance ${dOther}`)
  check('dHash: a document is > 6 bits away', dDoc > 6, `distance ${dDoc}`)
}

// ── HTTP flag-OFF / flag-ON smoke ────────────────────────────────────────────
async function http(): Promise<'off' | 'on' | 'none'> {
  if (!BASE) {
    record('HTTP checks (no BASE_URL)', 'skip', 'set BASE_URL to a running server')
    return 'none'
  }
  const probe = await fetch(`${BASE}/api/v1/agent/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  await drain(probe)
  const flagOff = probe.status === 404
  const paths: Array<[string, string]> = [
    ['GET', '/api/v1/agent/admin/dossiers'],
    ['GET', '/api/v1/agent/admin/dossiers/stats'],
    ['GET', `/api/v1/agent/admin/dossiers/${NIL}`],
    ['POST', `/api/v1/agent/admin/dossiers/${NIL}/decision`],
    ['POST', `/api/v1/agent/admin/dossiers/${NIL}/notify`],
  ]
  if (flagOff) {
    for (const [m, p] of paths) {
      const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'Content-Type': 'application/json' }, ...(m === 'POST' ? { body: '{}' } : {}) })
      await drain(res)
      check(`${m} ${p} 404s (inert)`, res.status === 404, `status ${res.status}`)
    }
  } else {
    for (const [m, p] of paths) {
      const res = await fetch(`${BASE}${p}`, { method: m, headers: { 'Content-Type': 'application/json' }, ...(m === 'POST' ? { body: '{}' } : {}) })
      await drain(res)
      // notify takes only the runtime credential (401); the rest need an admin session (401).
      check(`${m} ${p} refuses an anonymous caller`, res.status === 401, `status ${res.status}`)
    }
  }
  // The evidence GET is an ORDINARY admin read (requireAdmin, no agentApiGate): 401, never 404-by-flag.
  const ev = await fetch(`${BASE}/api/v1/admin/orders/${NIL}/evidence`)
  await drain(ev)
  check('evidence GET is an admin read, not an agent surface (401 unauthenticated, flag-independent)', ev.status === 401, `status ${ev.status}`)
  if (ADMIN_TOKEN) {
    const evA = await fetch(`${BASE}/api/v1/admin/orders/${NIL}/evidence`, { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })
    await drain(evA)
    check('evidence GET reachable for an admin (404 for a missing order)', evA.status === 404, `status ${evA.status}`)
  } else {
    record('evidence GET as admin', 'skip', 'set AGENT_VERIFY_ADMIN_TOKEN')
  }
  return flagOff ? 'off' : 'on'
}

// ── LIVE lifecycle (kill-test rows only; zero residue) ───────────────────────
async function live() {
  if (!LIVE) {
    record('LIVE lifecycle', 'skip', 'set DOSSIER_VERIFY_LIVE=1 with a local server + runtime')
    return
  }
  const missing = [
    ['BASE_URL', BASE],
    ['AGENT_RUNTIME_URL', RUNTIME_URL],
    ['AGENT_RUNTIME_SECRET', RUNTIME_SECRET],
    ['NEXT_PUBLIC_SUPABASE_URL', SUPA_URL],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', ANON],
    ['SUPABASE_SERVICE_ROLE_KEY', SERVICE],
  ].filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) {
    record('LIVE lifecycle', 'skip', `missing ${missing.join(', ')}`)
    return
  }
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE) && process.env['DOSSIER_VERIFY_ALLOW_REMOTE'] !== '1') {
    record('LIVE lifecycle', 'skip', 'BASE_URL is not localhost (set DOSSIER_VERIFY_ALLOW_REMOTE=1 to override — it edits agent_settings)')
    return
  }

  const admin: SupabaseClient = createClient(SUPA_URL, SERVICE, { auth: { persistSession: false } })
  const tag = `kt_dossier_${Date.now().toString(36)}`
  const created = { users: [] as string[], msmeIds: [] as string[], providerIds: [] as string[], orderIds: [] as string[], docPaths: [] as string[], runIds: [] as string[] }
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
    await admin.from('users').insert({ id: data.user.id, email, roles })
    const anon = createClient(SUPA_URL, ANON, { auth: { persistSession: false } })
    const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
    return { uid: data.user.id, token: s.session!.access_token }
  }
  const api = (token: string, p: string, body?: unknown, method = 'POST') =>
    fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) })

  async function seedOrder(n: number, msmeId: string, msmeUid: string, providerId: string, providerUid: string) {
    const price = 100000
    const gst = 18000
    const total = price + gst
    const commission = 5000
    const earning = price - commission
    const { data: order, error } = await admin
      .from('orders')
      .insert({
        order_number: `${tag.toUpperCase()}-${n}`,
        msme_id: msmeId,
        provider_id: providerId,
        source: 'package',
        title: `Dossier kill-test ${n}`,
        scope_snapshot: { items: ['kill-test'] },
        price_paise: price,
        discount_paise: 0,
        gst_paise: gst,
        total_paise: total,
        commission_bps: 500,
        commission_paise: commission,
        provider_earning_paise: earning,
        delivery_days: 3,
        status: 'delivered',
      })
      .select('id')
      .single()
    if (error || !order) throw new Error(`order ${n}: ${error?.message}`)
    created.orderIds.push(order.id)
    await admin.from('payments').insert({ order_id: order.id, amount_paise: total, status: 'captured', idempotency_key: `${tag}-pay-${n}`, method: 'upi' })
    // Three evidence photos (distinct golden fixtures) + four milestones in order.
    const files = ['work_2.jpg', 'work_3.jpg', 'work_4.jpg']
    const kinds = ['site_or_materials', 'in_progress', 'work_complete'] as const
    const docIds: string[] = []
    for (let i = 0; i < files.length; i++) {
      const bytes = readFileSync(path.join(PHOTOS, files[i]!))
      const objPath = `${order.id}/${tag}-${i}.jpg`
      const up = await admin.storage.from('order-documents').upload(objPath, bytes, { contentType: 'image/jpeg', upsert: true })
      if (up.error) throw new Error(`upload: ${up.error.message}`)
      created.docPaths.push(objPath)
      const { data: doc, error: de } = await admin
        .from('order_documents')
        .insert({ order_id: order.id, uploaded_by: providerUid, file_url: objPath, file_name: files[i], mime: 'image/jpeg', size_bytes: bytes.length, kind: 'milestone_photo' })
        .select('id')
        .single()
      if (de || !doc) throw new Error(`doc: ${de?.message}`)
      docIds.push(doc.id)
    }
    const rowsMs = [
      { order_id: order.id, title: 'accepted', kind: 'accepted', note: null, photo_doc_id: null, created_by: providerUid, sort: 0 },
      ...kinds.map((k, i) => ({ order_id: order.id, title: k, kind: k, note: i === 2 ? 'Work done (kill-test note)' : null, photo_doc_id: docIds[i]!, created_by: providerUid, sort: i + 1 })),
    ]
    const { error: me } = await admin.from('order_milestones').insert(rowsMs)
    if (me) throw new Error(`milestones: ${me.message}`)
    await sleep(1100) // completion strictly after the last evidence photo
    void msmeUid
    return { orderId: order.id as string, earning }
  }

  try {
    // Settings: remember + set for the run.
    for (const k of ['ops_user_id', 'agents_enabled', 'cohort_user_ids', 'evidence_required_from']) await remember(k)

    const ops = await mkUser('ops', ['admin'])
    const buyer = await mkUser('buyer', ['msme'])
    const prov = await mkUser('prov', ['provider'])
    const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'Dossier Buyer Co', state: 'KA', sector: 'services' }).select('id').single()
    created.msmeIds.push(msme!.id)
    const { data: pp } = await admin
      .from('provider_profiles')
      .insert({ user_id: prov.uid, legal_name: 'Dossier Prov Pvt', display_name: 'Dossier Prov', slug: `${tag}-prov`, state: 'KA', city: 'X', languages: ['en'], status: 'active', gstin: '29AAAAA0000A1Z5' })
      .select('id')
      .single()
    created.providerIds.push(pp!.id)
    await admin.from('provider_bank_accounts').insert({ provider_id: pp!.id, account_number_enc: 'enc:killtest', ifsc: 'HDFC0000001', account_holder: 'Dossier Prov', penny_drop_verified: true, razorpay_route_account_id: 'acc_KILLTEST0000001' })

    // Ops grant (persona ops, web) — what the founder does from the profile grants section.
    await admin.from('agent_grants').insert({ user_id: ops.uid, persona: 'ops', scopes: ['read_order_evidence', 'recommend_payout_release'], channel: 'web', consent: { surface: 'verify', text_version: 'v1', at: new Date().toISOString() } })
    const enabledBefore = (settingsBefore.get('agents_enabled')?.value ?? {}) as Record<string, boolean>
    await setSetting('ops_user_id', ops.uid)
    await setSetting('agents_enabled', { ...enabledBefore, payout_dossier: true })
    const cohortBefore = (settingsBefore.get('cohort_user_ids')?.value ?? []) as string[]
    await setSetting('cohort_user_ids', [...new Set([...cohortBefore, ops.uid])])
    await setSetting('evidence_required_from', '2020-01-01')

    // Order 1 → buyer accepts delivery → payout held → job → dossier.
    const o1 = await seedOrder(1, msme!.id, buyer.uid, pp!.id, prov.uid)
    const acc = await api(buyer.token, `/api/v1/orders/${o1.orderId}/transition`, { action: 'accept_delivery' })
    const accBody = (await drain(acc)) as { error?: unknown } | null
    check('buyer accept_delivery → 200', acc.status === 200, `status ${acc.status} ${JSON.stringify(accBody).slice(0, 120)}`)
    const { data: pay1 } = await admin.from('payouts').select('id, status').eq('order_id', o1.orderId).maybeSingle()
    check('payout born held', pay1?.status === 'held', `payout ${pay1?.status ?? 'missing'}`)
    if (pay1?.status !== 'held') return

    type DossierPoll = { id: string; run_id: string | null; recommendation: string; decision: string | null; rationale: string[] }
    let dossier1: DossierPoll | null = null
    for (let i = 0; i < 45 && !dossier1; i++) {
      await sleep(2000)
      const { data } = await admin.from('payout_dossiers').select('id, run_id, recommendation, decision, rationale').eq('order_id', o1.orderId).maybeSingle()
      dossier1 = (data as DossierPoll | null) ?? null
    }
    check('dossier written by the runtime job (≤ 90 s)', !!dossier1, dossier1 ? `rec ${dossier1.recommendation}` : 'no dossier — is the runtime running with DATABASE_URL + AGENT_ENABLED and API_URL=BASE_URL?')
    if (!dossier1) return
    if (dossier1.run_id) created.runIds.push(dossier1.run_id)
    check('recommendation approve in stub mode', dossier1.recommendation === 'approve', dossier1.rationale.join(', '))

    // The ops token cannot release money.
    const cred = signRuntimeCredential(RUNTIME_SECRET, { userId: ops.uid, persona: 'ops', runId: dossier1.run_id ?? NIL })
    const tok = await fetch(`${BASE}/api/v1/agent/token`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `AMC-Runtime ${cred}` }, body: '{}' })
    const tokBody = (await drain(tok)) as { token?: string } | null
    check('ops token minted from the grant', tok.status === 200 && !!tokBody?.token, `status ${tok.status}`)
    if (tokBody?.token) {
      const rel = await api(tokBody.token, `/api/v1/admin/payouts/${pay1.id}`, { action: 'retry', dossier_id: dossier1.id })
      const relBody = (await drain(rel)) as { error?: string } | null
      check('ops (delegated) token CANNOT release the payout → 403 tool_out_of_scope', rel.status === 403 && relBody?.error === 'tool_out_of_scope', `status ${rel.status} ${relBody?.error ?? ''}`)
      const evR = await api(tokBody.token, `/api/v1/admin/orders/${o1.orderId}/evidence`, undefined, 'GET')
      await drain(evR)
      check('ops token CAN read the evidence (scope read_order_evidence)', evR.status === 200, `status ${evR.status}`)
    }

    // Founder Approve via the release route with dossier_id.
    const ap = await api(ops.token, `/api/v1/admin/payouts/${pay1.id}`, { action: 'retry', dossier_id: dossier1.id, note: 'kill-test approve' })
    const apBody = (await drain(ap)) as { status?: string; dossier_decision?: string } | null
    check('founder Approve (release route + dossier_id) → 200', ap.status === 200 && apBody?.dossier_decision === 'approve', `status ${ap.status} ${JSON.stringify(apBody).slice(0, 120)}`)
    const { data: payAfter } = await admin.from('payouts').select('status').eq('id', pay1.id).maybeSingle()
    check('payout left held (scheduled|paid|failed)', !!payAfter && payAfter.status !== 'held', `payout ${payAfter?.status}`)
    const { data: d1After } = await admin.from('payout_dossiers').select('decision, decision_id, decided_by').eq('id', dossier1.id).maybeSingle()
    check("dossier.decision = 'approve' with decision_id + decided_by", d1After?.decision === 'approve' && !!d1After?.decision_id && d1After?.decided_by === ops.uid)
    if (d1After?.decision_id) {
      const { data: dec } = await admin.from('ai_decisions').select('feature, run_id, tool, final').eq('id', d1After.decision_id).maybeSingle()
      check('ai_decisions row: feature payout_dossier, run_id set, tool recommend_payout_release', dec?.feature === 'payout_dossier' && dec?.run_id === dossier1.run_id && dec?.tool === 'recommend_payout_release' && (dec?.final as { decision?: string })?.decision === 'approve')
    }
    const ap2 = await api(ops.token, `/api/v1/admin/payouts/${pay1.id}`, { action: 'retry', dossier_id: dossier1.id })
    await drain(ap2)
    check('second Approve → 409 (decision written once)', ap2.status === 409, `status ${ap2.status}`)

    // Order 2 → dossier → Hold.
    const o2 = await seedOrder(2, msme!.id, buyer.uid, pp!.id, prov.uid)
    const acc2 = await api(buyer.token, `/api/v1/orders/${o2.orderId}/transition`, { action: 'accept_delivery' })
    await drain(acc2)
    let dossier2: DossierPoll | null = null
    for (let i = 0; i < 45 && !dossier2; i++) {
      await sleep(2000)
      const { data } = await admin.from('payout_dossiers').select('id, run_id, recommendation, decision, rationale').eq('order_id', o2.orderId).maybeSingle()
      dossier2 = (data as DossierPoll | null) ?? null
    }
    check('second dossier written', !!dossier2)
    if (dossier2) {
      if (dossier2.run_id) created.runIds.push(dossier2.run_id)
      const noNote = await api(ops.token, `/api/v1/agent/admin/dossiers/${dossier2.id}/decision`, { decision: 'approve' })
      await drain(noNote)
      check('decision route refuses approve (422)', noNote.status === 422, `status ${noNote.status}`)
      const hold = await api(ops.token, `/api/v1/agent/admin/dossiers/${dossier2.id}/decision`, { decision: 'hold', note: 'kill-test hold' })
      await drain(hold)
      check('founder Hold → 200', hold.status === 200, `status ${hold.status}`)
      const { data: pay2 } = await admin.from('payouts').select('status').eq('order_id', o2.orderId).maybeSingle()
      check('payout stays held after Hold', pay2?.status === 'held', `payout ${pay2?.status}`)
      const { data: d2 } = await admin.from('payout_dossiers').select('decision').eq('id', dossier2.id).maybeSingle()
      check("dossier.decision = 'hold'", d2?.decision === 'hold')
      const hold2 = await api(ops.token, `/api/v1/agent/admin/dossiers/${dossier2.id}/decision`, { decision: 'hold', note: 'again' })
      await drain(hold2)
      check('second Hold → 409', hold2.status === 409, `status ${hold2.status}`)
    }
    const { count: notifCount } = await admin.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', ops.uid).eq('kind', 'payout_dossier_ready')
    const dossierCount = dossier2 ? 2 : 1
    check(`notification rows created once per dossier (${dossierCount})`, notifCount === dossierCount, `count ${notifCount}`)
  } finally {
    // ── cleanup (zero residue) ───────────────────────────────────────────────
    try {
      if (created.orderIds.length) {
        await admin.from('payout_dossiers').delete().in('order_id', created.orderIds)
        await admin.from('evidence_photo_hashes').delete().in('order_id', created.orderIds)
        await admin.from('payouts').delete().in('order_id', created.orderIds)
        await admin.from('order_events').delete().in('order_id', created.orderIds)
        await admin.from('order_milestones').delete().in('order_id', created.orderIds)
        await admin.from('order_documents').delete().in('order_id', created.orderIds)
        await admin.from('invoices').delete().in('order_id', created.orderIds)
        await admin.from('payments').delete().in('order_id', created.orderIds)
        await admin.from('orders').delete().in('id', created.orderIds)
      }
      if (created.docPaths.length) await admin.storage.from('order-documents').remove(created.docPaths)
      if (created.runIds.length) {
        await admin.from('ai_decisions').delete().in('run_id', created.runIds)
        await admin.from('agent_events').delete().in('run_id', created.runIds)
        await admin.from('ai_invocations').delete().in('run_id', created.runIds)
        await admin.from('agent_runs').delete().in('id', created.runIds)
      }
      if (created.users.length) {
        await admin.from('agent_runs').delete().in('user_id', created.users)
        await admin.from('notifications').delete().in('user_id', created.users)
        await admin.from('agent_grants').delete().in('user_id', created.users)
        await admin.from('audit_logs').delete().in('actor_id', created.users)
      }
      if (created.providerIds.length) {
        await admin.from('provider_bank_accounts').delete().in('provider_id', created.providerIds)
        await admin.from('provider_profiles').delete().in('id', created.providerIds)
      }
      if (created.msmeIds.length) await admin.from('msme_profiles').delete().in('id', created.msmeIds)
      for (const [key, before] of settingsBefore) {
        if (before.existed) await setSetting(key, before.value)
        else await admin.from('agent_settings').delete().eq('key', key)
      }
      for (const uid of created.users) {
        await admin.from('users').delete().eq('id', uid)
        await admin.auth.admin.deleteUser(uid)
      }
      record('cleanup', 'pass', `${created.users.length} users, ${created.orderIds.length} orders, settings restored`)
    } catch (e) {
      record('cleanup', 'FAIL', (e as Error).message)
    }
  }
}

async function main() {
  await offline()
  await http()
  await live()
  console.log('\nverify-payout-dossier\n')
  for (const r of rows) {
    const mark = r.status === 'skip' ? '⏭' : r.status === 'pass' ? '✓' : '✗'
    console.log(`  ${mark} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
  }
  const skipped = rows.filter((r) => r.status === 'skip').length
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${rows.length} checks: ${rows.length - failed - skipped} pass, ${skipped} skipped, ${failed} FAIL\n`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 2
})
