/**
 * Phase 7 (Admin & Ops) done-criteria proof against the deployed app. Sets up a
 * buyer + provider (bank-verified) + admin, drives the real admin APIs with
 * per-user Bearer tokens, and asserts all 6 criteria — including a full TEST-mode
 * dispute resolution with paise-exact money movement + idempotency.
 *
 * Run: BASE_URL=https://amclub-web.vercel.app tsx scripts/verify-phase7.ts
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

const URL = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++ }
const tag = `p7_${Date.now()}`
const created = { users: [] as string[], providerIds: [] as string[], msmeIds: [] as string[], packageIds: [] as string[], orderIds: [] as string[], categoryIds: [] as string[] }

async function mkUser(label: string, roles: string[] = ['msme']): Promise<{ uid: string; token: string }> {
  const email = `${tag}_${label}@killtest.amclub`
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error(`${label}: ${error.message}`)
  created.users.push(data.user.id)
  await admin.from('users').insert({ id: data.user.id, email, roles })
  const anon = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
  return { uid: data.user.id, token: s.session!.access_token }
}

const api = (token: string, p: string, body?: unknown, method = 'POST') =>
  fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) })

async function placeOrder(buyerToken: string, packageId: string): Promise<string> {
  const co = await api(buyerToken, '/api/v1/checkout', { packageId, idempotencyKey: crypto.randomUUID() })
  const cod = await co.json()
  if (cod.simulated) {
    const sim = await api(buyerToken, '/api/v1/checkout/simulate', { checkoutSessionId: cod.checkoutSessionId })
    return (await sim.json()).orderId
  }
  return ''
}

async function completeOrder(buyer: { token: string }, prov: { token: string }, orderId: string) {
  await api(prov.token, `/api/v1/orders/${orderId}/transition`, { action: 'accept' })
  await api(buyer.token, `/api/v1/orders/${orderId}/transition`, { action: 'submit_requirements' })
  await api(prov.token, `/api/v1/orders/${orderId}/transition`, { action: 'start' })
  await api(prov.token, `/api/v1/orders/${orderId}/transition`, { action: 'deliver' })
  await api(buyer.token, `/api/v1/orders/${orderId}/transition`, { action: 'accept_delivery' })
}

async function main() {
  console.log(`\nPhase 7 Admin & Ops verification → ${BASE}\n`)

  try {
  const adminUser = await mkUser('admin', ['admin', 'ops'])
  const buyer = await mkUser('buyer')
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'P7 Buyer Co', state: 'KA', sector: 'services' }).select('id').single()
  created.msmeIds.push(msme!.id)

  const prov = await mkUser('prov', ['provider'])
  const { data: provider } = await admin.from('provider_profiles').insert({
    user_id: prov.uid, legal_name: 'P7 Prov', display_name: 'P7 Prov', slug: `${tag}-prov`,
    state: 'KA', status: 'active', languages: ['en'],
  }).select('id').single()
  created.providerIds.push(provider!.id)
  // Bank verified so completion schedules the payout (not held for bank).
  await admin.from('provider_bank_accounts').insert({ provider_id: provider!.id, account_number_enc: 'enc_test', ifsc: 'HDFC0000001', account_holder: 'P7 Prov', penny_drop_verified: true })

  // Dedicated test category (commission 10%) via the admin API (also tests create + audit).
  // Category slug must be kebab-case (no underscores) per the route's schema.
  const catSlug = `${tag}-cat`.replace(/_/g, '-')
  const catRes = await api(adminUser.token, '/api/v1/admin/categories', {
    slug: catSlug, nameI18n: { en: 'P7 Test Cat', hi: 'P7' }, commissionBps: 1000, requiredCredentials: [],
  })
  const catJson = await catRes.json()
  const catId = catJson.category?.id as string
  if (!catId) throw new Error(`category create failed: ${catRes.status} ${JSON.stringify(catJson)}`)
  if (catId) created.categoryIds.push(catId)
  await admin.from('provider_categories').insert({ provider_id: provider!.id, category_id: catId })

  const { data: pkg } = await admin.from('packages').insert({
    provider_id: provider!.id, category_id: catId, slug: `${tag}-pkg`,
    title_i18n: { en: 'P7 pkg', hi: 'P7' }, price_paise: 1_000_000, discount_bps: 0, delivery_days: 3, revision_count: 1,
    status: 'active', scope_included: ['x'], scope_excluded: [], deliverables: ['y'],
  }).select('id').single()
  created.packageIds.push(pkg!.id)

  // ── Criterion 1: KPI dashboard ──────────────────────────────────────────────
  const o1 = await placeOrder(buyer.token, pkg!.id); created.orderIds.push(o1)
  await completeOrder(buyer, prov, o1)
  const kpi = await (await api(adminUser.token, `/api/v1/admin/kpi?from=${new Date(Date.now() - 86400000).toISOString()}&to=${new Date(Date.now() + 86400000).toISOString()}`, undefined, 'GET')).json()
  const liq = kpi.liquidityMatrix?.matrix?.[catSlug]?.['KA'] ?? 0
  check('1. KPI: GMV/take-rate/funnel + category×state liquidity render',
    kpi.financial?.gmvPaise > 0 && kpi.financial?.takeRateBps > 0 && kpi.funnel?.ordersPlaced >= 1 && liq >= 1,
    `gmv=${kpi.financial?.gmvPaise} take=${kpi.financial?.takeRateBps}bps orders=${kpi.funnel?.ordersPlaced} liq(KA)=${liq}`)

  // ── Criterion 2: suspend provider → listings vanish publicly; reactivate ─────
  // The public route sets s-maxage=300, so bust the CDN cache with a unique
  // query string per request to observe the live (data-layer) visibility.
  const pub = (cb: string) => fetch(`${BASE}/api/v1/catalog/provider/${tag}-prov?cb=${cb}-${Date.now()}`)
  const pubBefore = await pub('before')
  const susp = await api(adminUser.token, `/api/v1/admin/providers/${provider!.id}`, { action: 'suspend', reason: 'kill-test' })
  const pubAfter = await pub('after')
  const react = await api(adminUser.token, `/api/v1/admin/providers/${provider!.id}`, { action: 'reactivate' })
  const pubReact = await pub('react')
  check('2. Suspend hides listings publicly; reactivate restores (audit-logged)',
    pubBefore.status === 200 && susp.ok && pubAfter.status === 404 && react.ok && pubReact.status === 200,
    `before=${pubBefore.status} suspend=${susp.status} after=${pubAfter.status} reactivate=${react.status} restored=${pubReact.status}`)

  // ── Criterion 3: dispute end-to-end (TEST) + idempotency ────────────────────
  const o2 = await placeOrder(buyer.token, pkg!.id); created.orderIds.push(o2)
  await completeOrder(buyer, prov, o2)
  const { data: ordRow } = await admin.from('orders').select('total_paise, provider_earning_paise, commission_bps').eq('id', o2).single()
  const total = Number(ordRow!.total_paise), earning = Number(ordRow!.provider_earning_paise)
  // Raise dispute → payout should go on hold.
  await api(buyer.token, `/api/v1/orders/${o2}/transition`, { action: 'raise_dispute', disputeReason: 'quality' })
  const { data: payoutHeld } = await admin.from('payouts').select('status').eq('order_id', o2).maybeSingle()
  const { data: disp } = await admin.from('disputes').select('id').eq('order_id', o2).single()
  // Resolve partial: refund ₹2,000 (200000 paise) to buyer.
  const refundX = 200_000
  const expProviderPaid = Math.round((earning * (total - refundX)) / total)
  const r1 = await api(adminUser.token, `/api/v1/admin/disputes/${disp!.id}/resolve`, { resolution: 'refund_partial', amountPaise: refundX })
  const r1d = await r1.json()
  // Inspect money movement.
  const { data: payAfter } = await admin.from('payments').select('id').eq('order_id', o2).single()
  const { data: refundsA } = await admin.from('refunds').select('id, amount_paise').eq('payment_id', payAfter!.id)
  const { data: payoutA } = await admin.from('payouts').select('status, amount_paise').eq('order_id', o2).single()
  const { data: ordA } = await admin.from('orders').select('status').eq('id', o2).single()
  // Idempotency: resolve again, ensure no double-move.
  const r2 = await api(adminUser.token, `/api/v1/admin/disputes/${disp!.id}/resolve`, { resolution: 'refund_partial', amountPaise: refundX })
  const r2d = await r2.json()
  const { data: refundsB } = await admin.from('refunds').select('id, amount_paise').eq('payment_id', payAfter!.id)
  const { data: payoutB } = await admin.from('payouts').select('status, amount_paise').eq('order_id', o2).single()
  const ok3 =
    payoutHeld?.status === 'held' &&
    r1.ok && (refundsA ?? []).length === 1 && Number(refundsA![0]!.amount_paise) === refundX &&
    Number(payoutA!.amount_paise) === expProviderPaid && payoutA!.status === 'paid' &&
    ordA!.status === 'resolved_partial' &&
    r2d.already === true && (refundsB ?? []).length === 1 && Number(payoutB!.amount_paise) === expProviderPaid && payoutB!.status === 'paid'
  check('3. Dispute: hold → partial resolve (paise-exact) → idempotent re-resolve',
    ok3,
    `held=${payoutHeld?.status} refund=${refundsA?.[0]?.amount_paise}(×${refundsA?.length}) providerPaid=${payoutA?.amount_paise}(exp ${expProviderPaid},${payoutA?.status}) order=${ordA?.status} | reResolve already=${r2d.already} refunds=${refundsB?.length} payout=${payoutB?.amount_paise}/${payoutB?.status}`)

  // ── Criterion 3b (ADR-014 H3): a dispute after the payout is PAID never pays twice ──
  const o4 = await placeOrder(buyer.token, pkg!.id); created.orderIds.push(o4)
  await completeOrder(buyer, prov, o4)
  const { data: ord4 } = await admin.from('orders').select('provider_earning_paise').eq('id', o4).single()
  const earning4 = Number(ord4!.provider_earning_paise)
  const { data: payout4 } = await admin.from('payouts').select('id').eq('order_id', o4).single()
  const rel4 = await api(adminUser.token, `/api/v1/admin/payouts/${payout4!.id}`, { action: 'retry' })
  const { data: paid4 } = await admin.from('payouts').select('status, amount_paise, razorpay_transfer_id').eq('order_id', o4).single()
  await api(buyer.token, `/api/v1/orders/${o4}/transition`, { action: 'raise_dispute', disputeReason: 'quality' })
  const { data: disp4 } = await admin.from('disputes').select('id').eq('order_id', o4).single()
  const partial4 = await api(adminUser.token, `/api/v1/admin/disputes/${disp4!.id}/resolve`, { resolution: 'refund_partial', amountPaise: 200_000 })
  const partial4d = await partial4.json()
  const { data: ord4a } = await admin.from('orders').select('status').eq('id', o4).single()
  const release4 = await api(adminUser.token, `/api/v1/admin/disputes/${disp4!.id}/resolve`, { resolution: 'release' })
  const { data: payout4b } = await admin.from('payouts').select('status, amount_paise, razorpay_transfer_id').eq('order_id', o4).single()
  const { data: pay4 } = await admin.from('payments').select('id').eq('order_id', o4).single()
  const { data: refunds4 } = await admin.from('refunds').select('id').eq('payment_id', pay4!.id)
  const { count: sched4 } = await admin.from('order_events').select('id', { count: 'exact', head: true }).eq('order_id', o4).eq('event', 'payout_scheduled').eq('payload->>reason', 'dispute_resolution')
  const { data: ord4b } = await admin.from('orders').select('status').eq('id', o4).single()
  check('3b. Dispute on an already-PAID order: partial refused (409), release moves no money, no second transfer',
    rel4.ok && paid4?.status === 'paid' &&
    partial4.status === 409 && partial4d.error === 'provider_already_paid' && Number(partial4d.existingPaise) === earning4 && ord4a!.status === 'disputed' &&
    release4.ok && ord4b!.status === 'resolved_release' &&
    payout4b!.status === 'paid' && Number(payout4b!.amount_paise) === earning4 && payout4b!.razorpay_transfer_id === paid4!.razorpay_transfer_id &&
    (sched4 ?? 0) === 0 && (refunds4 ?? []).length === 0,
    `released=${rel4.status}/${paid4?.status} partial=${partial4.status}:${partial4d.error} order=${ord4a!.status} release=${release4.status}→${ord4b!.status} payout=${payout4b!.status}/${payout4b!.amount_paise}(exp ${earning4}) transferSame=${payout4b!.razorpay_transfer_id === paid4!.razorpay_transfer_id} reschedules=${sched4} refunds=${refunds4?.length}`)

  // ── Criterion 3c (ADR-014 H4): an earlier refund is a 409, never a silent no-op ──
  const o5 = await placeOrder(buyer.token, pkg!.id); created.orderIds.push(o5)
  await completeOrder(buyer, prov, o5)
  await api(buyer.token, `/api/v1/orders/${o5}/transition`, { action: 'raise_dispute', disputeReason: 'quality' })
  const { data: disp5 } = await admin.from('disputes').select('id').eq('order_id', o5).single()
  const man5 = await api(adminUser.token, `/api/v1/admin/orders/${o5}`, { action: 'manual_refund', amountPaise: 100_000 })
  const man5b = await api(adminUser.token, `/api/v1/admin/orders/${o5}`, { action: 'manual_refund', amountPaise: 50_000 })
  const man5bd = await man5b.json()
  const partial5 = await api(adminUser.token, `/api/v1/admin/disputes/${disp5!.id}/resolve`, { resolution: 'refund_partial', amountPaise: 200_000 })
  const partial5d = await partial5.json()
  const { data: ord5a } = await admin.from('orders').select('status').eq('id', o5).single()
  const release5 = await api(adminUser.token, `/api/v1/admin/disputes/${disp5!.id}/resolve`, { resolution: 'release' })
  const { data: pay5 } = await admin.from('payments').select('id').eq('order_id', o5).single()
  const { data: refunds5 } = await admin.from('refunds').select('amount_paise').eq('payment_id', pay5!.id)
  const { data: ord5b } = await admin.from('orders').select('status, provider_earning_paise').eq('id', o5).single()
  const { data: payout5 } = await admin.from('payouts').select('status, amount_paise').eq('order_id', o5).single()
  check('3c. Earlier refund: 2nd manual refund + refunding resolution refused (409 refund_exists); release closes it',
    man5.ok && man5b.status === 409 && man5bd.error === 'refund_exists' &&
    partial5.status === 409 && partial5d.error === 'refund_exists' && Number(partial5d.existingPaise) === 100_000 && ord5a!.status === 'disputed' &&
    release5.ok && ord5b!.status === 'resolved_release' &&
    (refunds5 ?? []).length === 1 && Number(refunds5![0]!.amount_paise) === 100_000 &&
    payout5!.status === 'paid' && Number(payout5!.amount_paise) === Number(ord5b!.provider_earning_paise),
    `manual=${man5.status} manual2=${man5b.status}:${man5bd.error} partial=${partial5.status}:${partial5d.error}(${partial5d.existingPaise}) order=${ord5a!.status} release=${release5.status}→${ord5b!.status} refunds=${(refunds5 ?? []).map((r) => r.amount_paise).join(',')} payout=${payout5!.status}/${payout5!.amount_paise}`)

  // ── Criterion 4: commission change affects NEW orders only ──────────────────
  const { data: existingOrd } = await admin.from('orders').select('commission_bps').eq('id', o2).single()
  await api(adminUser.token, '/api/v1/admin/categories', { id: catId, commissionBps: 1500 }, 'PATCH')
  const o3 = await placeOrder(buyer.token, pkg!.id); created.orderIds.push(o3)
  const { data: newOrd } = await admin.from('orders').select('commission_bps').eq('id', o3).single()
  const { data: existingNow } = await admin.from('orders').select('commission_bps').eq('id', o2).single()
  check('4. Commission change applies to NEW order only; existing frozen',
    existingOrd!.commission_bps === 1000 && newOrd!.commission_bps === 1500 && existingNow!.commission_bps === 1000,
    `existing(before)=${existingOrd!.commission_bps} new=${newOrd!.commission_bps} existing(after)=${existingNow!.commission_bps}`)

  // ── Criterion 5: every admin action appears in /admin/audit ─────────────────
  const auditRes = await (await api(adminUser.token, '/api/v1/admin/audit', undefined, 'GET')).json()
  const actions = new Set((auditRes.logs ?? []).map((l: { action: string }) => l.action))
  const needed = ['category_create', 'provider_suspend', 'provider_reactivate', 'dispute_refund_partial', 'category_update']
  const missing = needed.filter((a) => !actions.has(a))
  check('5. All admin actions audit-logged', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `present: ${needed.join(', ')}`)

  // ── Criterion 6: requireAdmin blocks non-admin (Bearer + unauth) ────────────
  const nonAdmin = await api(buyer.token, '/api/v1/admin/kpi', undefined, 'GET')
  const noAuth = await fetch(`${BASE}/api/v1/admin/kpi`)
  check('6. requireAdmin blocks non-admin (Bearer 403) + unauth (401)',
    nonAdmin.status === 403 && noAuth.status === 401, `nonAdmin=${nonAdmin.status} noAuth=${noAuth.status}`)

  } finally {
  // ── cleanup — ALWAYS runs (even on a thrown assertion) so no residue is left ──
  console.log('\n🧹 cleanup…')
  // Checked deletes (supabase-js resolves with { error } and never throws — the S1.2 residue lesson) and
  // checkout_sessions BEFORE orders (FK checkout_sessions.order_id), so a swallowed FK error cannot leave rows behind.
  const t = async (p: PromiseLike<{ error?: { message: string } | null } | unknown>) => {
    const r = (await Promise.resolve(p).catch((e) => ({ error: e }))) as { error?: { message?: string } | null }
    if (r && r.error) console.error('  cleanup:', r.error.message ?? String(r.error))
  }
  for (const mid of created.msmeIds) await t(admin.from('checkout_sessions').delete().eq('msme_id', mid))
  for (const oid of created.orderIds.filter(Boolean)) {
    await t(admin.from('checkout_sessions').delete().eq('order_id', oid))
    const { data: pays } = await admin.from('payments').select('id').eq('order_id', oid)
    for (const pay of pays ?? []) await t(admin.from('refunds').delete().eq('payment_id', pay.id))
    await t(admin.from('disputes').delete().eq('order_id', oid))
    await t(admin.from('payouts').delete().eq('order_id', oid))
    await t(admin.from('payments').delete().eq('order_id', oid))
    await t(admin.from('invoices').delete().eq('order_id', oid))
    await t(admin.from('order_events').delete().eq('order_id', oid))
    await t(admin.from('order_documents').delete().eq('order_id', oid))
    await t(admin.from('orders').delete().eq('id', oid))
  }
  for (const id of created.packageIds) await t(admin.from('packages').delete().eq('id', id))
  for (const id of created.providerIds) {
    await t(admin.from('provider_bank_accounts').delete().eq('provider_id', id))
    await t(admin.from('provider_categories').delete().eq('provider_id', id))
    await t(admin.from('provider_profiles').delete().eq('id', id))
  }
  for (const id of created.categoryIds) await t(admin.from('categories').delete().eq('id', id))
  for (const mid of created.msmeIds) await t(admin.from('msme_profiles').delete().eq('id', mid))
  for (const uid of created.users) {
    await t(admin.from('audit_logs').delete().eq('actor_id', uid))
    await t(admin.from('notifications').delete().eq('user_id', uid))
    await t(admin.from('users').delete().eq('id', uid))
    await admin.auth.admin.deleteUser(uid).catch(() => {})
  }

  }
  console.log(`\n${fail === 0 ? '✅ PHASE 7 — ALL CRITERIA PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
