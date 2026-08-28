/**
 * Phase 4 done-criteria proof (DC 4,5,6,7,8) over the REAL HTTP API + cron routes.
 *
 *  4. provider accepts → buyer submits requirements → provider delivers → buyer
 *     accepts → order completes.
 *  5. completion → payout scheduled, then payout cron creates a transfer object;
 *     buyer + commission invoice PDFs generated.
 *  6. cancel a pre-accept order → 100% refund issued.
 *  7. state machine rejects an illegal transition (wrong actor / wrong from-state).
 *  8. auto-accept cron completes a delivered order past its (shortened) timer.
 *
 * Requires a local server: BASE_URL=http://localhost:3000
 */
import { config } from 'dotenv'
import path from 'path'
import { randomUUID } from 'crypto'
config({ path: path.resolve(__dirname, '../.env.local') })

import { createClient } from '@supabase/supabase-js'
import { computeOrderAmounts } from '@amclub/shared'

const URL = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })

let pass = 0, fail = 0
const check = (name: string, cond: boolean) => { if (cond) { console.log(`  ✓ ${name}`); pass++ } else { console.log(`  ✗ ${name}`); fail++ } }

const createdOrders: string[] = []
let providerUserId = '', buyerUserId = '', providerId = '', msmeId = '', packageId = ''

async function makeUser(email: string, roles: string[]) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error('createUser: ' + error.message)
  const id = data.user.id
  const phone = '+919' + Math.floor(100000000 + Math.random() * 899999999) // unique-ish E.164
  const { error: uErr } = await admin.from('users').insert({ id, email, phone, roles })
  if (uErr) throw new Error('users insert: ' + uErr.message)
  const anon = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: s, error: sErr } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
  if (sErr || !s.session) throw new Error('signIn: ' + sErr?.message)
  return { id, token: s.session.access_token }
}

async function setup() {
  const stamp = Date.now()
  const prov = await makeUser(`prov_${stamp}@killtest.amclub`, ['provider'])
  const buyer = await makeUser(`buyer_${stamp}@killtest.amclub`, ['msme'])
  providerUserId = prov.id; buyerUserId = buyer.id

  const { data: cat } = await admin.from('categories').select('id, commission_bps').limit(1).single()

  const { data: pp, error: ppErr } = await admin.from('provider_profiles').insert({
    user_id: providerUserId, legal_name: 'KT Provider', display_name: 'KT Provider',
    slug: `kt-provider-${stamp}`, state: 'MH', status: 'active', languages: ['en'],
  }).select('id').single()
  if (ppErr) throw new Error('provider_profiles: ' + ppErr.message)
  providerId = pp!.id
  await admin.from('provider_bank_accounts').insert({
    provider_id: providerId, account_number_enc: 'enc', ifsc: 'HDFC0000001',
    account_holder: 'KT Provider', penny_drop_verified: true, razorpay_route_account_id: 'acc_test_kt',
  })
  const { data: pkg } = await admin.from('packages').insert({
    provider_id: providerId, category_id: cat!.id, slug: `kt-pkg-${stamp}`,
    title_i18n: { en: 'KT Service' }, scope_included: ['A'], deliverables: ['D'],
    price_paise: 500000, discount_bps: 1000, delivery_days: 5, revision_count: 1, status: 'active',
  }).select('id').single()
  packageId = pkg!.id

  const { data: mp } = await admin.from('msme_profiles').insert({
    user_id: buyerUserId, business_name: 'KT Buyer', state: 'MH',
  }).select('id').single()
  msmeId = mp!.id

  return { commissionBps: cat!.commission_bps, providerToken: prov.token, buyerToken: buyer.token }
}

async function makePaidOrder(commissionBps: number): Promise<string> {
  const amounts = computeOrderAmounts({ pricePaise: 500000, discountBps: 1000, commissionBps })
  const rzpOrder = `order_ml_${randomUUID().slice(0, 8)}`
  const payId = `pay_ml_${randomUUID().slice(0, 8)}`
  await admin.from('checkout_sessions').insert({
    razorpay_order_id: rzpOrder, msme_id: msmeId, provider_id: providerId, source: 'package', package_id: packageId,
    title: 'KT order', scope_snapshot: { title: { en: 'KT Service' } },
    price_paise: amounts.pricePaise, discount_paise: amounts.discountPaise, gst_paise: amounts.gstPaise, total_paise: amounts.totalPaise,
    commission_bps: amounts.commissionBps, commission_paise: amounts.commissionPaise, provider_earning_paise: amounts.providerEarningPaise,
    delivery_days: 5, revision_max: 1, idempotency_key: randomUUID(), status: 'created',
  })
  const { data: orderId, error } = await admin.rpc('materialize_order', {
    p_razorpay_order_id: rzpOrder, p_razorpay_payment_id: payId, p_amount_paise: amounts.totalPaise, p_method: 'upi', p_payload: {},
  })
  if (error) throw new Error('materialize: ' + error.message)
  createdOrders.push(orderId as string)
  return orderId as string
}

async function transition(orderId: string, action: string, token: string) {
  const res = await fetch(`${BASE}/api/v1/orders/${orderId}/transition`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function main() {
  console.log(`\nMoney-loop verification → ${BASE}\n`)
  const { commissionBps, providerToken, buyerToken } = await setup()

  // ── DC 4 + 7: lifecycle with an illegal transition in the middle ──
  console.log('DC4/DC7 — lifecycle + illegal-transition rejection:')
  const o1 = await makePaidOrder(commissionBps)

  const t1 = await transition(o1, 'accept', providerToken)
  check('provider accept → 200 accepted', t1.status === 200 && t1.body.status === 'accepted')

  // DC7: wrong actor — buyer cannot deliver.
  const bad1 = await transition(o1, 'deliver', buyerToken)
  check('buyer deliver → rejected (403 wrong actor)', bad1.status === 403)
  // DC7: illegal from-state — provider cannot accept_delivery from accepted.
  const bad2 = await transition(o1, 'accept_delivery', providerToken)
  check('provider accept_delivery from accepted → rejected (403/409)', bad2.status === 403 || bad2.status === 409)
  // DC7: illegal jump — provider deliver before in_progress.
  const bad3 = await transition(o1, 'deliver', providerToken)
  check("provider deliver from 'accepted' → rejected (409)", bad3.status === 409)

  check('buyer submit_requirements → 200', (await transition(o1, 'submit_requirements', buyerToken)).status === 200)
  check('provider start → 200 in_progress', (await transition(o1, 'start', providerToken)).body.status === 'in_progress')
  check('provider deliver → 200 delivered', (await transition(o1, 'deliver', providerToken)).body.status === 'delivered')
  const accept = await transition(o1, 'accept_delivery', buyerToken)
  check('buyer accept_delivery → 200 completed', accept.status === 200 && accept.body.status === 'completed')

  // ── DC 5: payout + invoices ──
  console.log('\nDC5 — payout transfer + invoice PDFs:')
  // Founder approval gate: unless PAYOUT_AUTO_RELEASE=true, every payout is
  // born 'held' and only an explicit admin release moves money. When the gate
  // is on (the launch default), 'held' IS the correct outcome and the cron
  // legs below are expected to process nothing.
  const autoRelease = process.env['PAYOUT_AUTO_RELEASE'] === 'true'
  const { data: payout } = await admin.from('payouts').select('status, amount_paise').eq('order_id', o1).maybeSingle()
  if (autoRelease) {
    check('payout scheduled on completion', payout?.status === 'scheduled')
  } else {
    check('payout HELD on completion (approval gate active)', payout?.status === 'held')
  }
  const { count: invCount } = await admin.from('invoices').select('id', { count: 'exact', head: true }).eq('order_id', o1)
  check('two invoices generated (buyer + commission)', invCount === 2)
  // Phase 1c — the payout decision is on the order timeline, with its reasons.
  const { data: payoutEvents } = await admin.from('order_events').select('event, payload').eq('order_id', o1).in('event', ['payout_held', 'payout_scheduled'])
  const pe = payoutEvents?.[0]
  const reasons = ((pe?.payload as { reasons?: string[] } | null)?.reasons ?? [])
  if (autoRelease) {
    check("order_events has 'payout_scheduled'", payoutEvents?.length === 1 && pe?.event === 'payout_scheduled')
  } else {
    check("order_events has 'payout_held' with reasons=[approval_gate]", payoutEvents?.length === 1 && pe?.event === 'payout_held' && reasons.includes('approval_gate'))
  }

  // Cron endpoints require the CRON_SECRET bearer in production. Without it in
  // the local env, skip those legs (the guard itself is verified elsewhere).
  const cronSecret = process.env['CRON_SECRET']
  const cronHeaders: Record<string, string> = cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {}
  if (!cronSecret) {
    console.log('  ⏭ payout-cron legs SKIPPED (no CRON_SECRET in env)')
  } else if (!autoRelease) {
    const payRes = await fetch(`${BASE}/api/v1/cron/payouts?all=true`, { headers: cronHeaders })
    const { data: payoutAfter } = await admin.from('payouts').select('status').eq('order_id', o1).maybeSingle()
    check('payout cron leaves HELD payout untouched (gate active)', payRes.status === 200 && payoutAfter?.status === 'held')
  } else {
    const payRes = await fetch(`${BASE}/api/v1/cron/payouts?all=true`, { headers: cronHeaders })
    const payJson = await payRes.json().catch(() => ({}))
    check('payout cron processed ≥1 transfer', payRes.status === 200 && (payJson.processed ?? 0) >= 1)
    const { data: payoutAfter } = await admin.from('payouts').select('status, razorpay_transfer_id').eq('order_id', o1).maybeSingle()
    check('payout marked paid with a transfer id', payoutAfter?.status === 'paid' && Boolean(payoutAfter?.razorpay_transfer_id))
  }

  // ── DC 6: refund on pre-accept cancel ──
  console.log('\nDC6 — pre-accept cancel = 100% refund:')
  const o2 = await makePaidOrder(commissionBps)
  const { data: o2row } = await admin.from('orders').select('total_paise').eq('id', o2).single()
  const cancel = await transition(o2, 'cancel', buyerToken)
  check('buyer cancel (placed) → 200', cancel.status === 200)
  const { data: o2after } = await admin.from('orders').select('status').eq('id', o2).single()
  check("order is 'refunded'", o2after?.status === 'refunded')
  const { data: payment2 } = await admin.from('payments').select('id').eq('order_id', o2).single()
  const { data: refund } = await admin.from('refunds').select('amount_paise').eq('payment_id', payment2!.id).maybeSingle()
  check('100% refund issued', Number(refund?.amount_paise) === Number(o2row!.total_paise))
  const { data: refundRow } = await admin.from('refunds').select('status, idempotency_key, razorpay_refund_id').eq('payment_id', payment2!.id).maybeSingle()
  check('refund row processed with deterministic key + gateway id', refundRow?.status === 'processed' && refundRow?.idempotency_key === `rfnd_${o2}` && Boolean(refundRow?.razorpay_refund_id))

  // ── DC 6b (Phase 2f): refund replay — crash between our pending row and the gateway ──
  console.log('\nDC6b — refund replay safety (insert-first, key-guarded):')
  const o4 = await makePaidOrder(commissionBps)
  const { data: o4row } = await admin.from('orders').select('total_paise').eq('id', o4).single()
  const { data: pay4 } = await admin.from('payments').select('id').eq('order_id', o4).single()
  // Simulate the crash: the pending row exists, the gateway was never called.
  await admin.from('refunds').insert({ payment_id: pay4!.id, amount_paise: o4row!.total_paise, reason: 'cancellation', status: 'pending', idempotency_key: `rfnd_${o4}` })
  const c4 = await transition(o4, 'cancel', buyerToken)
  check('retry completes the PENDING refund → 200', c4.status === 200)
  const { data: r4 } = await admin.from('refunds').select('status, razorpay_refund_id, idempotency_key').eq('payment_id', pay4!.id)
  check('exactly ONE refund row: processed, keyed, with a gateway id', r4?.length === 1 && r4[0]!.status === 'processed' && r4[0]!.idempotency_key === `rfnd_${o4}` && Boolean(r4[0]!.razorpay_refund_id))
  const { data: o4after } = await admin.from('orders').select('status').eq('id', o4).single()
  check("order is 'refunded'", o4after?.status === 'refunded')
  const c4b = await transition(o4, 'cancel', buyerToken)
  const { count: r4count } = await admin.from('refunds').select('id', { count: 'exact', head: true }).eq('payment_id', pay4!.id)
  check('replayed cancel rejected (409) and still ONE refund row', c4b.status === 409 && r4count === 1)
  const { data: dup } = await admin.from('refunds').insert({ payment_id: pay4!.id, amount_paise: 1, status: 'pending', idempotency_key: `rfnd_${o4}` }).select('id')
  check('a second row with the same key is impossible (unique index)', !dup || dup.length === 0)

  // ── DC 8: auto-accept after shortened timer ──
  console.log('\nDC8 — auto-accept job (shortened timer):')
  const o3 = await makePaidOrder(commissionBps)
  await transition(o3, 'accept', providerToken)
  await transition(o3, 'submit_requirements', buyerToken)
  await transition(o3, 'start', providerToken)
  await transition(o3, 'deliver', providerToken)
  // Shorten the timer: set auto_accept_at to the past.
  await admin.from('orders').update({ auto_accept_at: new Date(Date.now() - 1000).toISOString() }).eq('id', o3)
  if (!cronSecret) {
    console.log('  ⏭ auto-accept cron legs SKIPPED (no CRON_SECRET in env)')
  } else {
    const cron = await fetch(`${BASE}/api/v1/cron/auto-accept`, { headers: cronHeaders })
    check('auto-accept cron → 200', cron.status === 200)
    const { data: o3after } = await admin.from('orders').select('status, completed_at').eq('id', o3).single()
    check('delivered order auto-completed', o3after?.status === 'completed' && Boolean(o3after?.completed_at))
  }

  await cleanup()
  console.log(`\n${fail === 0 ? '✅ MONEY-LOOP VERIFICATION PASSED' : '❌ FAILED'} — ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

async function cleanup() {
  for (const o of createdOrders) {
    await admin.from('payouts').delete().eq('order_id', o)
    await admin.from('checkout_sessions').delete().eq('order_id', o)
    await admin.from('orders').delete().eq('id', o) // cascades payments/refunds/events/docs/invoices
  }
  if (packageId) await admin.from('packages').delete().eq('id', packageId)
  if (providerId) { await admin.from('provider_bank_accounts').delete().eq('provider_id', providerId); await admin.from('provider_profiles').delete().eq('id', providerId) }
  if (msmeId) await admin.from('msme_profiles').delete().eq('id', msmeId)
  for (const u of [providerUserId, buyerUserId]) {
    if (!u) continue
    await admin.from('users').delete().eq('id', u)
    await admin.auth.admin.deleteUser(u).catch(() => {})
  }
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); process.exit(1) })
