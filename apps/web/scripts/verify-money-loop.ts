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
import { checkoutTimeoutSeconds, isSimulatedPayment, moneyMovementBlock, paymentsAvailable } from '../lib/payments/simulation'
import { signWebhookBody } from '../lib/payments/signature'
import { bundlePlan, computeOrderAmounts, computeRefundPaise, disputeSettlementPaise, packageCharge, type BundleMilestoneRow, type PackageAddonRow } from '@amclub/shared'

const URL = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'

const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })

let pass = 0, fail = 0
const check = (name: string, cond: boolean) => { if (cond) { console.log(`  ✓ ${name}`); pass++ } else { console.log(`  ✗ ${name}`); fail++ } }

const createdOrders: string[] = []
let providerUserId = '', buyerUserId = '', adminUserId = '', providerId = '', msmeId = '', packageId = ''
let adminToken = ''

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
  // Admin actor for dispute resolution + payout release (DC9/DC10).
  const adm = await makeUser(`admin_${stamp}@killtest.amclub`, ['msme', 'admin'])
  providerUserId = prov.id; buyerUserId = buyer.id; adminUserId = adm.id; adminToken = adm.token

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

  // ── ADR 023: the simulation gateway never takes a payment on the production deployment ──
  console.log('ADR 023 — simulated payments are refused on production:')
  check('no real keys on production → payments unavailable (no free paid order)', paymentsAvailable(false, 'production') === false)
  check('real keys on production → payments available', paymentsAvailable(true, 'production') === true)
  check('no real keys on a preview → simulation allowed', paymentsAvailable(false, 'preview') === true)
  check('no real keys off Vercel (CI, the rigs, local) → simulation allowed', paymentsAvailable(false, undefined) === true)

  // ── ADR 027 (audit M2): the same rule after checkout — refunds, payouts, reconcile ──
  console.log('ADR 027 — no refund or transfer through the simulation gateway on production, none for a simulated payment:')
  const simPay = { razorpay_payment_id: 'pay_sim_00000000-0000-0000-0000-000000000000', simulated: true }
  const realPay = { razorpay_payment_id: 'pay_Nx1Qk2WmHq9Zr0', simulated: null }
  check('a pay_sim_ id or payload.simulated marks a simulated payment; a Razorpay id does not', isSimulatedPayment(simPay) && isSimulatedPayment({ razorpay_payment_id: 'pay_x', webhook_payload: { simulated: true } }) && !isSimulatedPayment(realPay))
  check('mock gateway on production → payments_unavailable (the row is left as it is)', moneyMovementBlock(false, realPay, 'production') === 'payments_unavailable')
  check('real gateway + a simulated payment → payment_simulated (no real refund / transfer)', moneyMovementBlock(true, simPay, 'production') === 'payment_simulated')
  check('real gateway + a real payment → money may move', moneyMovementBlock(true, realPay, 'production') === null)
  check('CI / previews / the rigs (mock, not production) → simulation keeps working', moneyMovementBlock(false, simPay, undefined) === null && moneyMovementBlock(false, simPay, 'preview') === null)
  const t0 = Date.UTC(2026, 8, 24, 10, 0, 0)
  check('the Razorpay Checkout timeout is the time left on the session (M21); an expired one is 0', checkoutTimeoutSeconds(new Date(t0 + 600_000).toISOString(), t0) === 600 && checkoutTimeoutSeconds(new Date(t0 - 1).toISOString(), t0) === 0 && checkoutTimeoutSeconds(null, t0) === null)

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

  // ── E9 FR-9.3 (PRD Experience v3): "Buy again" is an ordinary Buy-now order at today's price ──
  console.log('\nE9 — buy again = a fresh Buy-now checkout at today’s server price:')
  const buyAgainUrl = `${BASE}/api/v1/orders/${o1}/buy-again`
  const bearer = { authorization: `Bearer ${buyerToken}` }
  if ((await fetch(buyAgainUrl, { headers: bearer })).status === 404) {
    console.log('  ⏭ buy-again legs SKIPPED (EXP_V3_HOME is off for this server)')
  } else {
    await admin.from('packages').update({ price_paise: 600000 }).eq('id', packageId)
    try {
      const now = computeOrderAmounts({ pricePaise: 600000, discountBps: 1000, commissionBps })
      const { data: o1row } = await admin.from('orders').select('total_paise').eq('id', o1).single()
      const b = (await (await fetch(buyAgainUrl, { headers: bearer })).json()) as { kind?: string; packageId?: string; priceChanged?: boolean; displayThen?: { totalPaise: number }; displayNow?: { totalPaise: number } }
      check('buy-again offers the same package with both prices (then = the order, now = today)', b.kind === 'package' && b.packageId === packageId && b.priceChanged === true && b.displayThen?.totalPaise === Number(o1row!.total_paise) && b.displayNow?.totalPaise === now.totalPaise)
      const start = async () => {
        const res = await fetch(`${BASE}/api/v1/checkout`, { method: 'POST', headers: { 'content-type': 'application/json', ...bearer }, body: JSON.stringify({ packageId: b.packageId, idempotencyKey: randomUUID() }) })
        return (await res.json().catch(() => ({}))) as { checkoutSessionId?: string; amountPaise?: number }
      }
      const again = await start()
      const fresh = await start()
      const cols = 'source, package_id, quote_id, price_paise, discount_paise, gst_paise, total_paise, commission_bps, commission_paise, provider_earning_paise, delivery_days, revision_max'
      const { data: sa } = await admin.from('checkout_sessions').select(cols).eq('id', again.checkoutSessionId ?? '').maybeSingle()
      const { data: sf } = await admin.from('checkout_sessions').select(cols).eq('id', fresh.checkoutSessionId ?? '').maybeSingle()
      check('a buy-again checkout is identical to a fresh Buy-now checkout', !!sa && JSON.stringify(sa) === JSON.stringify(sf))
      check('… and charges today’s server price (not the old order’s)', again.amountPaise === now.totalPaise && Number(sa?.total_paise) === now.totalPaise)
      for (const id of [again.checkoutSessionId, fresh.checkoutSessionId]) if (id) await admin.from('checkout_sessions').delete().eq('id', id)
    } finally {
      await admin.from('packages').update({ price_paise: 500000 }).eq('id', packageId)
    }
  }

  // ── E12a / ADR 019: package add-ons — one computeOrderAmounts on package + add-ons, frozen, invoiced ──
  console.log('\nE12a — add-ons: preview = order = invoice; tampered prices ignored; a changed add-on 409s; replay creates nothing:')
  {
    const { data: before } = await admin.from('agent_settings').select('value').eq('key', 'addons_enabled').maybeSingle()
    await admin.from('agent_settings').upsert({ key: 'addons_enabled', value: true, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` }
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) })
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
    }
    try {
      const { data: rows, error: addErr } = await admin.from('package_addons').insert([
        { package_id: packageId, label_i18n: { en: 'Delivered 2 days faster' }, price_paise: 50_000, days_delta: -2, extra_revisions: 0, sort: 0 },
        { package_id: packageId, label_i18n: { en: 'One more revision' }, price_paise: 30_000, days_delta: 1, extra_revisions: 1, sort: 1 },
      ]).select('id, label_i18n, price_paise, days_delta, extra_revisions')
      if (addErr || !rows || rows.length !== 2) {
        console.log(`  ⏭ add-on legs SKIPPED (package_addons unavailable: ${addErr?.message ?? 'no rows'})`)
      } else {
        const addons = rows as PackageAddonRow[]
        const ids = addons.map((a) => a.id)
        const expected = packageCharge({ pricePaise: 500000, discountBps: 1000, commissionBps, deliveryDays: 5, revisionCount: 1, addons })
        const pv = await post('/api/v1/checkout/preview', { packageId, addonIds: ids })
        const pvTotal = (pv.body['display'] as { totalPaise?: number } | undefined)?.totalPaise
        check(`preview = the shared rule (package + 2 add-ons → ${expected.amounts.totalPaise} paise, 4 days, 2 revisions)`, pv.status === 200 && pvTotal === expected.amounts.totalPaise && pv.body['deliveryDays'] === 4 && pv.body['revisionMax'] === 2)
        // The client "sends" its own prices and total: the server never reads them.
        const co = await post('/api/v1/checkout', { packageId, addonIds: ids, idempotencyKey: randomUUID(), addonPrices: { [ids[0]!]: 1, [ids[1]!]: 1 }, amountPaise: 100, totalPaise: 100 })
        check('checkout charges the preview total (tampered client prices ignored)', co.status === 200 && co.body['amountPaise'] === pvTotal)
        if (co.body['simulated'] && co.body['checkoutSessionId']) {
          const sim = await post('/api/v1/checkout/simulate', { checkoutSessionId: co.body['checkoutSessionId'] })
          const orderId = sim.body['orderId'] as string | undefined
          if (orderId) createdOrders.push(orderId)
          const replay = await post('/api/v1/checkout/simulate', { checkoutSessionId: co.body['checkoutSessionId'] })
          // …and the webhook's own path replayed with the same capture: materialize_order returns the same order.
          const { data: sess } = await admin.from('checkout_sessions').select('razorpay_order_id, total_paise').eq('id', co.body['checkoutSessionId'] as string).single()
          const { data: again } = await admin.rpc('materialize_order', { p_razorpay_order_id: sess!.razorpay_order_id, p_razorpay_payment_id: `pay_sim_${co.body['checkoutSessionId'] as string}`, p_amount_paise: sess!.total_paise, p_method: 'upi', p_payload: {} })
          const { count: nOrders } = await admin.from('orders').select('id', { count: 'exact', head: true }).eq('package_id', packageId).eq('total_paise', pvTotal ?? -1)
          check('a replayed capture creates nothing (same order, one order)', !!orderId && replay.body['orderId'] === orderId && again === orderId && nOrders === 1)
          const { data: ord } = await admin.from('orders').select('total_paise, price_paise, discount_paise, gst_paise, provider_earning_paise, delivery_days, revision_max, addons').eq('id', orderId ?? '').maybeSingle()
          const snap = (ord?.addons ?? []) as { id: string; pricePaise: number }[]
          check('order = preview: amounts, due days and revisions from the frozen snapshot', Number(ord?.total_paise) === pvTotal && Number(ord?.provider_earning_paise) === expected.amounts.providerEarningPaise && ord?.delivery_days === 4 && ord?.revision_max === 2 && snap.length === 2 && snap.map((a) => a.pricePaise).join() === '50000,30000')
          // Drive it to completion: the buyer invoice carries one line per add-on and sums to the order.
          for (const [action, token] of [['accept', providerToken], ['submit_requirements', buyerToken], ['start', providerToken], ['deliver', providerToken], ['accept_delivery', buyerToken]] as const) await transition(orderId!, action, token)
          const { data: inv } = await admin.from('invoices').select('totals').eq('order_id', orderId ?? '').eq('kind', 'buyer_invoice').maybeSingle()
          const totals = (inv?.totals ?? {}) as { lines?: { label: string; paise: number }[]; discount_paise?: number; gst_paise?: number; total_paise?: number }
          const lineSum = (totals.lines ?? []).reduce((a, l) => a + l.paise, 0)
          check('buyer invoice: the package line + one line per add-on; lines − discount + GST = the order total', (totals.lines ?? []).length === 3 && lineSum - Number(totals.discount_paise) + Number(totals.gst_paise) === Number(ord?.total_paise) && Number(totals.total_paise) === Number(ord?.total_paise))
        } else {
          console.log('  ⏭ capture legs SKIPPED (real gateway: no simulate)')
        }
        // An add-on paused between preview and payment → 409 addon_changed, no session.
        await admin.from('package_addons').update({ active: false }).eq('id', ids[0]!)
        const changedKey = randomUUID()
        const changed = await post('/api/v1/checkout', { packageId, addonIds: ids, idempotencyKey: changedKey })
        const { count: changedSessions } = await admin.from('checkout_sessions').select('id', { count: 'exact', head: true }).eq('idempotency_key', changedKey)
        check('an add-on paused after the preview → 409 addon_changed, no session', changed.status === 409 && changed.body['code'] === 'addon_changed' && changedSessions === 0)
        // The switch off → add-ons are refused outright (never silently dropped).
        await admin.from('agent_settings').upsert({ key: 'addons_enabled', value: false, updated_at: new Date().toISOString() }, { onConflict: 'key' })
        const off = await post('/api/v1/checkout', { packageId, addonIds: [ids[1]!], idempotencyKey: randomUUID() })
        const offPreview = await post('/api/v1/checkout/preview', { packageId, addonIds: [ids[1]!] })
        check('switch off → checkout refuses add-ons (409) and the preview is 404', off.status === 409 && offPreview.status === 404)
      }
    } finally {
      await admin.from('package_addons').delete().eq('package_id', packageId)
      if (before) await admin.from('agent_settings').upsert({ key: 'addons_enabled', value: before.value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
      else await admin.from('agent_settings').delete().eq('key', 'addons_enabled')
    }
  }

  // ── E12c / ADR 021: bundles — one payment → one child order per milestone; cancel remaining refunds exactly the rest ──
  console.log('\nE12c — bundles: 3 children from one capture (exact sums), replay creates nothing, future children never auto-cancel, cancel remaining refunds exactly 2 and 3:')
  {
    const { data: before } = await admin.from('agent_settings').select('value').eq('key', 'bundles_enabled').maybeSingle()
    await admin.from('agent_settings').upsert({ key: 'bundles_enabled', value: true, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` }
    const post = async (path: string, body?: unknown) => {
      const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: auth, ...(body ? { body: JSON.stringify(body) } : {}) })
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
    }
    let purchaseId: string | null = null
    try {
      const ms: BundleMilestoneRow[] = [
        { seq: 1, label_i18n: { en: 'Registration' }, due_offset_days: 15, share_bps: 4000 },
        { seq: 2, label_i18n: { en: 'Month 1 returns' }, due_offset_days: 45, share_bps: 3000 },
        { seq: 3, label_i18n: { en: 'Month 2 returns' }, due_offset_days: 75, share_bps: 3000 },
      ]
      const { error: msErr } = await admin.from('bundle_milestones').insert(ms.map((m) => ({ package_id: packageId, ...m })))
      if (msErr) {
        console.log(`  ⏭ bundle legs SKIPPED (bundle_milestones unavailable: ${msErr.message})`)
      } else {
        const co = await post('/api/v1/checkout', { packageId, idempotencyKey: randomUUID() })
        const whole = computeOrderAmounts({ pricePaise: 500000, discountBps: 1000, commissionBps })
        const plan = bundlePlan(whole, ms)
        if (co.body['simulated'] && co.body['checkoutSessionId']) {
          const sid = co.body['checkoutSessionId'] as string
          const sim = await post('/api/v1/checkout/simulate', { checkoutSessionId: sid })
          const carrier = sim.body['orderId'] as string | undefined
          const { data: bp } = await admin.from('bundle_purchases').select('id, total_paise, payment_id').eq('checkout_session_id', sid).maybeSingle()
          purchaseId = (bp?.id as string | undefined) ?? null
          const { data: kids } = await admin.from('orders').select('id, bundle_seq, status, total_paise, provider_earning_paise, delivery_days, available_at').eq('bundle_purchase_id', purchaseId ?? '').order('bundle_seq')
          for (const k of kids ?? []) createdOrders.push(k.id as string)
          const { data: pay } = await admin.from('payments').select('amount_paise').eq('id', (bp?.payment_id as string | undefined) ?? '').maybeSingle()
          const sum = (kids ?? []).reduce((a, k) => a + Number(k.total_paise), 0)
          check(`one capture → 3 child orders; Σ totals = the captured ${whole.totalPaise} paise, each = the frozen split`,
            co.body['amountPaise'] === whole.totalPaise && (kids ?? []).length === 3 && sum === Number(pay?.amount_paise) && sum === whole.totalPaise &&
            (kids ?? []).every((k, i) => Number(k.total_paise) === plan[i]!.amounts.totalPaise && Number(k.provider_earning_paise) === plan[i]!.amounts.providerEarningPaise && k.delivery_days === plan[i]!.deliveryDays) &&
            (kids ?? [])[0]?.id === carrier)
          const { data: sess } = await admin.from('checkout_sessions').select('razorpay_order_id, total_paise').eq('id', sid).single()
          const { data: again } = await admin.rpc('materialize_order', { p_razorpay_order_id: sess!.razorpay_order_id, p_razorpay_payment_id: `pay_sim_${sid}`, p_amount_paise: sess!.total_paise, p_method: 'upi', p_payload: {} })
          const { count: afterReplay } = await admin.from('orders').select('id', { count: 'exact', head: true }).eq('bundle_purchase_id', purchaseId ?? '')
          check('a replayed capture creates nothing (same carrier, still 3 children, one purchase)', again === carrier && afterReplay === 3)
          // A future milestone older than 24 h since purchase is NOT auto-cancelled: its clock starts when it becomes actionable.
          const k2 = (kids ?? [])[1]
          if (k2 && cronSecret) {
            await admin.from('orders').update({ created_at: new Date(Date.now() - 2 * 86_400_000).toISOString() }).eq('id', k2.id)
            await fetch(`${BASE}/api/v1/cron/auto-cancel`, { headers: cronHeaders })
            const { data: k2after } = await admin.from('orders').select('status').eq('id', k2.id).single()
            check('auto-cancel skips a milestone that is not actionable yet', k2after?.status === 'placed')
          }
          // Milestone 1 under way, then "cancel remaining": exactly children 2 and 3 are refunded in full, one row each.
          await transition(carrier!, 'accept', providerToken)
          await transition(carrier!, 'submit_requirements', buyerToken)
          await transition(carrier!, 'start', providerToken)
          const cr = await post(`/api/v1/bundles/${purchaseId}/cancel-remaining`)
          const ids = (kids ?? []).map((k) => k.id as string)
          const { data: after } = await admin.from('orders').select('id, status').in('id', ids)
          const status = new Map((after ?? []).map((o) => [o.id as string, o.status as string]))
          const { data: rfs } = await admin.from('refunds').select('idempotency_key, amount_paise, status').eq('payment_id', (bp?.payment_id as string | undefined) ?? '')
          const byKey = new Map((rfs ?? []).map((r) => [r.idempotency_key as string, r]))
          check('cancel remaining after milestone 1: 2 and 3 refunded in full (one row each), 1 untouched',
            cr.status === 200 && status.get(ids[0]!) === 'in_progress' && status.get(ids[1]!) === 'refunded' && status.get(ids[2]!) === 'refunded' &&
            (rfs ?? []).length === 2 && !byKey.has(`rfnd_${ids[0]}`) &&
            Number(byKey.get(`rfnd_${ids[1]}`)?.amount_paise) === plan[1]!.amounts.totalPaise && Number(byKey.get(`rfnd_${ids[2]}`)?.amount_paise) === plan[2]!.amounts.totalPaise)
          const cr2 = await post(`/api/v1/bundles/${purchaseId}/cancel-remaining`)
          const { count: rfCount } = await admin.from('refunds').select('id', { count: 'exact', head: true }).eq('payment_id', (bp?.payment_id as string | undefined) ?? '')
          check('a second cancel remaining refunds nothing more', cr2.status === 200 && rfCount === 2)
        } else {
          console.log('  ⏭ bundle capture legs SKIPPED (real gateway: no simulate)')
        }
      }
    } finally {
      await admin.from('bundle_milestones').delete().eq('package_id', packageId)
      if (purchaseId) {
        // Children point at the purchase; unlink them so the global cleanup can remove orders and sessions.
        await admin.from('orders').update({ bundle_purchase_id: null }).eq('bundle_purchase_id', purchaseId)
        await admin.from('bundle_purchases').delete().eq('id', purchaseId)
      }
      if (before) await admin.from('agent_settings').upsert({ key: 'bundles_enabled', value: before.value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
      else await admin.from('agent_settings').delete().eq('key', 'bundles_enabled')
    }
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

  // ── DC 9 (F1): split resolution — provider transfer BEFORE buyer refund, replay-safe ──
  console.log('\nDC9 — split dispute resolution (refund_partial): transfer-then-refund + replay:')
  const o6 = await makePaidOrder(commissionBps)
  await transition(o6, 'accept', providerToken)
  await transition(o6, 'submit_requirements', buyerToken)
  await transition(o6, 'start', providerToken)
  await transition(o6, 'deliver', providerToken)
  const disp = await fetch(`${BASE}/api/v1/orders/${o6}/transition`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` }, body: JSON.stringify({ action: 'raise_dispute', disputeReason: 'killtest split' }) })
  check('buyer raises dispute → 200 disputed', disp.status === 200)
  const { data: d6 } = await admin.from('disputes').select('id').eq('order_id', o6).single()
  const { data: o6row } = await admin.from('orders').select('total_paise, provider_earning_paise').eq('id', o6).single()
  const total6 = Number(o6row!.total_paise), earning6 = Number(o6row!.provider_earning_paise)
  const refund6 = Math.round(total6 * 0.4)
  const expectedPaid6 = Math.round((earning6 * (total6 - refund6)) / total6)
  const res6 = await fetch(`${BASE}/api/v1/admin/disputes/${d6!.id}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ resolution: 'refund_partial', amountPaise: refund6 }) })
  check('admin resolves refund_partial (40%) → 200', res6.status === 200)
  const { data: o6after } = await admin.from('orders').select('status').eq('id', o6).single()
  const { data: pay6 } = await admin.from('payouts').select('status, amount_paise, razorpay_transfer_id, paid_at').eq('order_id', o6).maybeSingle()
  const { data: pm6 } = await admin.from('payments').select('id').eq('order_id', o6).single()
  const { data: rf6 } = await admin.from('refunds').select('status, amount_paise, razorpay_refund_id, created_at').eq('payment_id', pm6!.id)
  check("order → 'resolved_partial'", o6after?.status === 'resolved_partial')
  check(`provider transfer = retained share (${expectedPaid6}) and PAID`, pay6?.status === 'paid' && Number(pay6?.amount_paise) === expectedPaid6 && Boolean(pay6?.razorpay_transfer_id))
  check(`buyer refund = ${refund6}, exactly one processed row`, rf6?.length === 1 && rf6[0]!.status === 'processed' && Number(rf6[0]!.amount_paise) === refund6 && Boolean(rf6[0]!.razorpay_refund_id))
  check('ORDER: transfer paid BEFORE the refund was initiated (F1-safe)', Boolean(pay6?.paid_at) && Boolean(rf6?.[0]?.created_at) && new Date(pay6!.paid_at!).getTime() <= new Date(rf6![0]!.created_at).getTime())
  // Replay the resolution: no second transfer, no second refund.
  const res6b = await fetch(`${BASE}/api/v1/admin/disputes/${d6!.id}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ resolution: 'refund_partial', amountPaise: refund6 }) })
  const { data: pay6b } = await admin.from('payouts').select('razorpay_transfer_id, amount_paise').eq('order_id', o6).maybeSingle()
  const { count: rf6count } = await admin.from('refunds').select('id', { count: 'exact', head: true }).eq('payment_id', pm6!.id)
  check('replayed resolve: same transfer id, same amount, still ONE refund row', (res6b.status === 200 || res6b.status === 409) && pay6b?.razorpay_transfer_id === pay6?.razorpay_transfer_id && Number(pay6b?.amount_paise) === expectedPaid6 && rf6count === 1)

  // ── DC 10 (ADR-004): fee headroom guard — refuse loudly, never shrink ──
  console.log('\nDC10 — fee headroom (ADR-004): a transfer that cannot absorb the fee FAILS loudly:')
  // Commission 0 bps ⇒ the platform has no headroom for Razorpay's fee ⇒ the guard must refuse.
  const o5 = await makePaidOrder(0)
  await transition(o5, 'accept', providerToken)
  await transition(o5, 'submit_requirements', buyerToken)
  await transition(o5, 'start', providerToken)
  await transition(o5, 'deliver', providerToken)
  await transition(o5, 'accept_delivery', buyerToken)
  const { data: p5 } = await admin.from('payouts').select('id, status, amount_paise').eq('order_id', o5).maybeSingle()
  const { data: o5row } = await admin.from('orders').select('total_paise, provider_earning_paise').eq('id', o5).single()
  check('zero-commission order: payout created, transfer = full provider earning', Boolean(p5) && Number(p5!.amount_paise) === Number(o5row!.provider_earning_paise))
  const rel5 = await fetch(`${BASE}/api/v1/admin/payouts/${p5!.id}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ action: 'retry' }) })
  const rel5Json = await rel5.json().catch(() => ({}))
  const { data: p5after } = await admin.from('payouts').select('status, amount_paise, razorpay_transfer_id').eq('id', p5!.id).single()
  check('admin release → payout FAILED (not paid), amount untouched, no transfer id', rel5.status === 200 && rel5Json.status === 'failed' && p5after?.status === 'failed' && Number(p5after?.amount_paise) === Number(o5row!.provider_earning_paise) && !p5after?.razorpay_transfer_id)
  const { data: ev5 } = await admin.from('order_events').select('payload').eq('order_id', o5).eq('event', 'payout_failed').maybeSingle()
  const fee5 = (ev5?.payload as { reason?: string; fee?: { estimatedFeePaise?: number; commissionPaise?: number; reason?: string } } | null)
  check("payout_failed event says fee_headroom with the numbers (fee > commission)", fee5?.reason === 'fee_headroom' && fee5?.fee?.reason === 'exceeds_commission' && (fee5?.fee?.estimatedFeePaise ?? 0) > (fee5?.fee?.commissionPaise ?? -1))

  // ── DC 11 (ADR 026): one release rule, confirmed transfers, compare-and-set, durable refunds + invoices ──
  console.log('\nDC11 — ADR 026: release rule, confirmed transfers, compare-and-set, durable refunds and invoices:')
  {
    const adminPost = (path: string, body: unknown) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify(body) })
    const toDelivered = async (o: string) => {
      await transition(o, 'accept', providerToken)
      await transition(o, 'submit_requirements', buyerToken)
      await transition(o, 'start', providerToken)
      await transition(o, 'deliver', providerToken)
    }
    const payoutOf = async (o: string) => (await admin.from('payouts').select('id, status, razorpay_transfer_id').eq('order_id', o).maybeSingle()).data

    // H8 — an Indic business name no longer fails the invoice (or the accept that triggers it).
    await admin.from('msme_profiles').update({ business_name: 'शर्मा ट्रेडर्स' }).eq('id', msmeId)
    const o7 = await makePaidOrder(commissionBps)
    await toDelivered(o7)
    const acc7 = await transition(o7, 'accept_delivery', buyerToken)
    const { count: inv7 } = await admin.from('invoices').select('id', { count: 'exact', head: true }).eq('order_id', o7)
    check('an Indic business name: accept-delivery → 200 and both invoices generated', acc7.status === 200 && inv7 === 2)
    await admin.from('msme_profiles').update({ business_name: 'KT Buyer' }).eq('id', msmeId)

    // H5 — the order-page retry retries FAILED payouts only; a held one is released from Payouts.
    const p7 = await payoutOf(o7)
    await admin.from('payouts').update({ status: 'held' }).eq('id', p7!.id)
    const r7 = await adminPost(`/api/v1/admin/orders/${o7}`, { action: 'retry_payout' })
    const r7body = await r7.json().catch(() => ({}))
    check('"Retry payout" refuses a HELD payout (409 payout_held_use_release) and moves nothing', r7.status === 409 && r7body.error === 'payout_held_use_release' && (await payoutOf(o7))?.status === 'held')
    const rel7 = await adminPost(`/api/v1/admin/payouts/${p7!.id}`, { action: 'retry' })
    const p7paid = await payoutOf(o7)
    check('the admin release pays it (the release rule passes a completed order)', rel7.status === 200 && p7paid?.status === 'paid' && Boolean(p7paid?.razorpay_transfer_id))

    // H9 — the transfer went through but a failure was recorded: the retry asks the gateway
    // first and settles on the SAME transfer instead of sending a second one.
    await admin.from('payouts').update({ status: 'failed', razorpay_transfer_id: null, paid_at: null }).eq('id', p7!.id)
    await admin.from('order_events').insert({ order_id: o7, actor_id: null, event: 'payout_failed', payload: { payout_id: p7!.id, reason: 'killtest: timeout after the gateway accepted' } })
    const retry7 = await adminPost(`/api/v1/admin/orders/${o7}`, { action: 'retry_payout' })
    const p7re = await payoutOf(o7)
    const { data: paid7 } = await admin.from('order_events').select('payload').eq('order_id', o7).eq('event', 'payout_paid')
    const recovered = (paid7 ?? []).some((e) => (e.payload as { recovered?: boolean } | null)?.recovered === true)
    check('a retry after an ambiguous failure finds the existing transfer: paid with the SAME transfer id, recorded as recovered', retry7.status === 200 && p7re?.status === 'paid' && p7re?.razorpay_transfer_id === p7paid?.razorpay_transfer_id && recovered)

    // M19 / H5 — a disputed order's payout is never released, by the admin or by the run.
    const o8 = await makePaidOrder(commissionBps)
    await toDelivered(o8)
    await transition(o8, 'accept_delivery', buyerToken)
    const disp8 = await fetch(`${BASE}/api/v1/orders/${o8}/transition`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` }, body: JSON.stringify({ action: 'raise_dispute', disputeReason: 'killtest ADR 026' }) })
    const p8 = await payoutOf(o8)
    await admin.from('payouts').update({ status: 'held' }).eq('id', p8!.id)
    const rel8 = await adminPost(`/api/v1/admin/payouts/${p8!.id}`, { action: 'retry' })
    const rel8body = await rel8.json().catch(() => ({}))
    check('admin release refuses a payout whose order is disputed (409 order_not_releasable)', disp8.status === 200 && rel8.status === 409 && rel8body.error === 'order_not_releasable' && (await payoutOf(o8))?.status === 'held')
    if (cronSecret) {
      // A payout scheduled before the dispute landed: the run itself must hold it.
      await admin.from('payouts').update({ status: 'scheduled' }).eq('id', p8!.id)
      const run8 = await fetch(`${BASE}/api/v1/cron/payouts?all=true`, { headers: cronHeaders })
      const p8after = await payoutOf(o8)
      const { data: held8 } = await admin.from('order_events').select('payload').eq('order_id', o8).eq('event', 'payout_held')
      const releaseHold = (held8 ?? []).some((e) => ((e.payload as { reasons?: string[]; at?: string } | null)?.reasons ?? []).includes('order_status:disputed'))
      check('the payout run holds a scheduled payout whose order is disputed (reason order_status:disputed, no transfer)', run8.status === 200 && p8after?.status === 'held' && !p8after?.razorpay_transfer_id && releaseHold)
    } else {
      console.log('  ⏭ payout-run hold leg SKIPPED (no CRON_SECRET in env)')
    }

    // H6 — two accept-deliveries at once: one wins, the other is refused, one payout.
    const o9 = await makePaidOrder(commissionBps)
    await toDelivered(o9)
    const [a9, b9] = await Promise.all([transition(o9, 'accept_delivery', buyerToken), transition(o9, 'accept_delivery', buyerToken)])
    const { count: done9 } = await admin.from('order_events').select('id', { count: 'exact', head: true }).eq('order_id', o9).eq('event', 'accept_delivery')
    const { count: pays9 } = await admin.from('payouts').select('id', { count: 'exact', head: true }).eq('order_id', o9)
    const codes9 = [a9.status, b9.status].sort().join(',')
    check('two concurrent accept-deliveries: 200 + 409, exactly one completion event and one payout', codes9 === '200,409' && done9 === 1 && pays9 === 1)

    // H7 — a cancellation left without its refund is finished by the one refund engine,
    // at the policy % of the status it was cancelled FROM (recorded on the cancel event).
    const o10 = await makePaidOrder(commissionBps)
    await transition(o10, 'accept', providerToken)
    await admin.from('orders').update({ status: 'cancelled_by_buyer', cancelled_reason: 'buyer_cancelled' }).eq('id', o10)
    await admin.from('order_events').insert({ order_id: o10, actor_id: buyerUserId, event: 'cancel', payload: { from: 'accepted' } })
    if (cronSecret) {
      const sweep = await fetch(`${BASE}/api/v1/cron/auto-cancel`, { headers: cronHeaders })
      const { data: o10mid } = await admin.from('orders').select('status').eq('id', o10).single()
      check('the sweeper leaves a just-cancelled order alone (10-minute idle guard)', sweep.status === 200 && o10mid?.status === 'cancelled_by_buyer')
    }
    const fin10 = await adminPost(`/api/v1/admin/orders/${o10}`, { action: 'finish_refund' })
    const { data: o10row } = await admin.from('orders').select('status, total_paise').eq('id', o10).single()
    const { data: pm10 } = await admin.from('payments').select('id').eq('order_id', o10).single()
    const { data: rf10 } = await admin.from('refunds').select('status, amount_paise, idempotency_key').eq('payment_id', pm10!.id)
    const want10 = computeRefundPaise({ totalPaise: Number(o10row!.total_paise), fromStatus: 'accepted' })
    check(`"Finish refund" refunds the owed ${want10} paise (policy for 'accepted'), one keyed row, order refunded`, fin10.status === 200 && o10row?.status === 'refunded' && rf10?.length === 1 && rf10[0]!.status === 'processed' && Number(rf10[0]!.amount_paise) === want10 && rf10[0]!.idempotency_key === `rfnd_${o10}`)
    const fin10b = await adminPost(`/api/v1/admin/orders/${o10}`, { action: 'finish_refund' })
    check('a second "Finish refund" is refused (409 not_refund_owed) and refunds nothing more', fin10b.status === 409 && (await admin.from('refunds').select('id', { count: 'exact', head: true }).eq('payment_id', pm10!.id)).count === 1)
  }

  // ── DC 12 (ADR 027): payment truth — refund / transfer / chargeback webhooks, captures with no order, manual refund + the release rule ──
  console.log('\nDC12 — ADR 027: gateway webhooks settle rows once; expired / second captures create no order and are refunded; manual refund holds the payout:')
  {
    const exceptionIds: string[] = []
    const sessionIds: string[] = []
    const adminPost = async (p: string, body: unknown) => {
      const res = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify(body) })
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
    }
    const hook = async (payload: unknown) => {
      const raw = JSON.stringify(payload)
      const res = await fetch(`${BASE}/api/v1/webhooks/razorpay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': signWebhookBody(raw) }, body: raw })
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
    }
    const completed = async (o: string) => {
      for (const [action, token] of [['accept', providerToken], ['submit_requirements', buyerToken], ['start', providerToken], ['deliver', providerToken], ['accept_delivery', buyerToken]] as const) await transition(o, action, token)
    }
    const payoutOf = async (o: string) => (await admin.from('payouts').select('id, status, amount_paise, razorpay_transfer_id').eq('order_id', o).maybeSingle()).data
    const eventCount = async (o: string, event: string, key?: [string, string]) => {
      let q = admin.from('order_events').select('id', { count: 'exact', head: true }).eq('order_id', o).eq('event', event)
      if (key) q = q.eq(`payload->>${key[0]}`, key[1])
      return (await q).count ?? 0
    }
    const rzpPaymentOf = async (o: string) => (await admin.from('payments').select('id, razorpay_payment_id, razorpay_order_id, amount_paise').eq('order_id', o).single()).data!
    try {
      // (a) M20 — refund.processed heals a pending row once; refund.failed marks it failed once (ops re-sends; never read as done).
      const o11 = await makePaidOrder(commissionBps)
      const pm11 = await rzpPaymentOf(o11)
      await admin.from('refunds').insert({ payment_id: pm11.id, amount_paise: pm11.amount_paise, reason: 'cancellation', status: 'pending', idempotency_key: `rfnd_${o11}` })
      const rf11 = `rfnd_kt_${randomUUID().slice(0, 12)}`
      const refundEntity = (status: string) => ({ event: `refund.${status}`, payload: { refund: { entity: { id: rf11, entity: 'refund', amount: Number(pm11.amount_paise), payment_id: pm11.razorpay_payment_id, receipt: `rfnd_${o11}`, status } } } })
      const p1 = await hook(refundEntity('processed'))
      const p2 = await hook(refundEntity('processed'))
      const { data: row11 } = await admin.from('refunds').select('status, razorpay_refund_id').eq('payment_id', pm11.id)
      check('refund.processed completes a pending refund row by our receipt; the replay changes nothing (one confirmation event)', p1.status === 200 && p1.body['changed'] === true && p2.status === 200 && p2.body['changed'] === false && row11?.length === 1 && row11[0]!.status === 'processed' && row11[0]!.razorpay_refund_id === rf11 && (await eventCount(o11, 'refund_confirmed')) === 1)
      const f1 = await hook(refundEntity('failed'))
      const f2 = await hook(refundEntity('failed'))
      const { data: row11f } = await admin.from('refunds').select('status').eq('payment_id', pm11.id).single()
      check('refund.failed marks the row failed and records it once for ops; the replay changes nothing', f1.status === 200 && f1.body['changed'] === true && f2.body['changed'] === false && row11f?.status === 'failed' && (await eventCount(o11, 'refund_failed', ['razorpay_refund_id', rf11])) === 1)

      // (b) M20 — transfer webhooks: a paid payout whose transfer failed goes back to failed once; the dead transfer never settles it again.
      const o12 = await makePaidOrder(commissionBps)
      await completed(o12)
      const p12 = await payoutOf(o12)
      await admin.from('payouts').update({ status: 'held' }).eq('id', p12!.id)
      await adminPost(`/api/v1/admin/payouts/${p12!.id}`, { action: 'retry' })
      const paid12 = await payoutOf(o12)
      const t12 = paid12?.razorpay_transfer_id as string
      const transfer = (event: string, id: string, extra: Record<string, unknown> = {}) => ({ event, payload: { transfer: { entity: { id, entity: 'transfer', amount: Number(paid12?.amount_paise), notes: { payout_id: p12!.id, order_id: o12 }, status: event.split('.')[1], ...extra } } } })
      const tp = await hook(transfer('transfer.processed', t12))
      check('transfer.processed on a paid payout changes nothing', paid12?.status === 'paid' && tp.status === 200 && tp.body['changed'] === false && (await payoutOf(o12))?.status === 'paid')
      const tf1 = await hook(transfer('transfer.failed', t12))
      const tf2 = await hook(transfer('transfer.failed', t12))
      const late = await hook(transfer('transfer.processed', t12))
      const failed12 = await payoutOf(o12)
      check('transfer.failed: paid → failed once (gateway event), the replay and a late processed for the dead transfer change nothing', tf1.body['changed'] === true && tf2.body['changed'] === false && late.body['changed'] === false && failed12?.status === 'failed' && !failed12?.razorpay_transfer_id && (await eventCount(o12, 'payout_failed', ['razorpay_transfer_id', t12])) === 1)
      const retry12 = await adminPost(`/api/v1/admin/orders/${o12}`, { action: 'retry_payout' })
      const re12 = await payoutOf(o12)
      check('the retry sends a NEW transfer (the dead one is never taken as the payment)', retry12.status === 200 && re12?.status === 'paid' && Boolean(re12?.razorpay_transfer_id) && re12?.razorpay_transfer_id !== t12)
      // An unconfirmed transfer (processing, ADR 026) settled by transfer.processed; replayed, still one paid event for it.
      await admin.from('payouts').update({ status: 'processing', razorpay_transfer_id: null, paid_at: null }).eq('id', p12!.id)
      const t12b = `trf_kt_${randomUUID().slice(0, 12)}`
      const pr1 = await hook(transfer('transfer.processed', t12b))
      const pr2 = await hook(transfer('transfer.processed', t12b))
      const settled12 = await payoutOf(o12)
      check('transfer.processed settles a processing payout as paid with that transfer; the replay changes nothing', pr1.body['changed'] === true && pr2.body['changed'] === false && settled12?.status === 'paid' && settled12?.razorpay_transfer_id === t12b && (await eventCount(o12, 'payout_paid', ['razorpay_transfer_id', t12b])) === 1)

      // (c) M20 — a chargeback holds an unpaid payout, is recorded once, and blocks the payout run until decided.
      const o13 = await makePaidOrder(commissionBps)
      await completed(o13)
      const p13 = await payoutOf(o13)
      await admin.from('payouts').update({ status: 'scheduled' }).eq('id', p13!.id)
      const pm13 = await rzpPaymentOf(o13)
      const cbId = `disp_kt_${randomUUID().slice(0, 12)}`
      const chargeback = (event: string) => ({ event, payload: { payment: { entity: { id: pm13.razorpay_payment_id } }, dispute: { entity: { id: cbId, entity: 'dispute', payment_id: pm13.razorpay_payment_id, amount: Number(pm13.amount_paise), reason_code: 'fraud', phase: 'chargeback', status: event.split('.')[2] } } } })
      const c1 = await hook(chargeback('payment.dispute.created'))
      const c2 = await hook(chargeback('payment.dispute.created'))
      check('payment.dispute.created holds the scheduled payout and is recorded once; the replay changes nothing', c1.body['changed'] === true && c2.body['changed'] === false && (await payoutOf(o13))?.status === 'held' && (await eventCount(o13, 'chargeback_opened', ['razorpay_dispute_id', cbId])) === 1)
      await admin.from('payouts').update({ status: 'held' }).eq('id', p13!.id)
      const rel13 = await adminPost(`/api/v1/admin/payouts/${p13!.id}`, { action: 'retry' })
      const { data: held13 } = await admin.from('order_events').select('payload').eq('order_id', o13).eq('event', 'payout_held')
      check('while the chargeback is open the release rule holds the payout (reason chargeback_open, no transfer)', rel13.status === 200 && (await payoutOf(o13))?.status === 'held' && !(await payoutOf(o13))?.razorpay_transfer_id && (held13 ?? []).some((e) => ((e.payload as { reasons?: string[] } | null)?.reasons ?? []).includes('chargeback_open')))
      const l1 = await hook(chargeback('payment.dispute.lost'))
      const l2 = await hook(chargeback('payment.dispute.lost'))
      check('payment.dispute.lost is recorded once for ops', l1.body['changed'] === true && l2.body['changed'] === false && (await eventCount(o13, 'chargeback_lost', ['razorpay_dispute_id', cbId])) === 1)

      // (d) M21 — a capture on an expired session records the payment, creates no order, and refunds it in full; the replay creates nothing.
      const expAmounts = computeOrderAmounts({ pricePaise: 500000, discountBps: 1000, commissionBps })
      const expRzp = `order_exp_${randomUUID().slice(0, 8)}`
      const expPay = `pay_exp_${randomUUID().slice(0, 8)}`
      const { data: expSess } = await admin.from('checkout_sessions').insert({
        razorpay_order_id: expRzp, msme_id: msmeId, provider_id: providerId, source: 'package', package_id: packageId,
        title: 'KT expired session', scope_snapshot: { title: { en: 'KT Service' } },
        price_paise: expAmounts.pricePaise, discount_paise: expAmounts.discountPaise, gst_paise: expAmounts.gstPaise, total_paise: expAmounts.totalPaise,
        commission_bps: expAmounts.commissionBps, commission_paise: expAmounts.commissionPaise, provider_earning_paise: expAmounts.providerEarningPaise,
        delivery_days: 5, revision_max: 1, idempotency_key: randomUUID(), status: 'created', expires_at: new Date(Date.now() - 3600_000).toISOString(),
      }).select('id').single()
      if (expSess?.id) sessionIds.push(expSess.id as string)
      const captured = { event: 'payment.captured', payload: { payment: { entity: { id: expPay, order_id: expRzp, amount: expAmounts.totalPaise, method: 'upi' } } } }
      const e1 = await hook(captured)
      const e2 = await hook(captured)
      const { data: expAfter } = await admin.from('checkout_sessions').select('status, order_id').eq('id', expSess!.id).single()
      const { data: excs } = await admin.from('capture_exceptions').select('id, reason, status, razorpay_refund_id, amount_paise, order_id').eq('razorpay_payment_id', expPay)
      for (const x of excs ?? []) exceptionIds.push(x.id as string)
      const { count: expPayments } = await admin.from('payments').select('id', { count: 'exact', head: true }).eq('razorpay_order_id', expRzp)
      check('a capture past expires_at + grace: 200, no order, no payments row, session expired', e1.status === 200 && !e1.body['orderId'] && e1.body['outcome'] === 'session_expired' && expAfter?.status === 'expired' && !expAfter?.order_id && expPayments === 0)
      check('… recorded once as a session_expired capture exception and refunded in full (one refund); the replay changes nothing', e2.status === 200 && !e2.body['orderId'] && (excs ?? []).length === 1 && excs![0]!.reason === 'session_expired' && excs![0]!.status === 'refunded' && Boolean(excs![0]!.razorpay_refund_id) && Number(excs![0]!.amount_paise) === expAmounts.totalPaise && !excs![0]!.order_id)
      const { count: notices } = await admin.from('notifications').select('id', { count: 'exact', head: true }).eq('user_id', buyerUserId).eq('kind', 'payment_refunded_no_order')
      check('the buyer is told once that no order was placed and the payment is refunded', notices === 1)
      // The refund webhook for that refund settles nothing twice.
      const excRefund = { event: 'refund.processed', payload: { refund: { entity: { id: excs![0]!.razorpay_refund_id, entity: 'refund', amount: expAmounts.totalPaise, payment_id: expPay, status: 'processed' } } } }
      const er = await hook(excRefund)
      check('refund.processed for a capture-exception refund changes nothing when already refunded', er.status === 200 && er.body['changed'] === false)

      // (e) M39 — a second capture on a session another payment already paid: no second order or payment; refunded in full; replay-safe.
      const o14 = await makePaidOrder(commissionBps)
      const pm14 = await rzpPaymentOf(o14)
      const dupPay = `pay_dup_${randomUUID().slice(0, 8)}`
      const dup = { event: 'payment.captured', payload: { payment: { entity: { id: dupPay, order_id: pm14.razorpay_order_id, amount: Number(pm14.amount_paise), method: 'upi' } } } }
      const d1 = await hook(dup)
      const d2 = await hook(dup)
      const { count: pays14 } = await admin.from('payments').select('id', { count: 'exact', head: true }).eq('razorpay_order_id', pm14.razorpay_order_id)
      const { count: orders14 } = await admin.from('orders').select('id', { count: 'exact', head: true }).eq('id', o14)
      const { data: dexc } = await admin.from('capture_exceptions').select('id, reason, status, order_id').eq('razorpay_payment_id', dupPay)
      for (const x of dexc ?? []) exceptionIds.push(x.id as string)
      check('a second capture on a paid session: no second payment or order, one duplicate_capture exception on the order, refunded', d1.status === 200 && d1.body['outcome'] === 'duplicate_capture' && d2.status === 200 && pays14 === 1 && orders14 === 1 && (dexc ?? []).length === 1 && dexc![0]!.reason === 'duplicate_capture' && dexc![0]!.order_id === o14 && dexc![0]!.status === 'refunded' && (await eventCount(o14, 'duplicate_capture')) === 1)

      // (f) L1 — a manual refund follows the ADR-014 rules: an unpaid payout is cut to the provider's share and HELD in the same action.
      await completed(o14)
      const p14 = await payoutOf(o14)
      await admin.from('payouts').update({ status: 'scheduled' }).eq('id', p14!.id)
      const { data: o14row } = await admin.from('orders').select('total_paise, provider_earning_paise').eq('id', o14).single()
      const share14 = disputeSettlementPaise({ totalPaise: Number(o14row!.total_paise), earningPaise: Number(o14row!.provider_earning_paise), resolution: 'refund_partial', amountPaise: 100_000 }).providerPaidPaise
      const man14 = await adminPost(`/api/v1/admin/orders/${o14}`, { action: 'manual_refund', amountPaise: 100_000 })
      const p14after = await payoutOf(o14)
      const { data: mrHeld } = await admin.from('order_events').select('payload').eq('order_id', o14).eq('event', 'payout_held')
      const heldForRefund = (mrHeld ?? []).some((e) => ((e.payload as { reasons?: string[] } | null)?.reasons ?? []).includes('manual_refund'))
      check(`manual refund on an unpaid payout: 200, payout HELD at the provider's share (${share14}) in the same action`, man14.status === 200 && p14after?.status === 'held' && Number(p14after?.amount_paise) === share14 && heldForRefund)
      // (g) L1 — the release rule refuses a full payout beside a refund; the planner's share goes out.
      await admin.from('payouts').update({ amount_paise: Number(o14row!.provider_earning_paise) }).eq('id', p14!.id)
      const rel14 = await adminPost(`/api/v1/admin/payouts/${p14!.id}`, { action: 'retry' })
      const { data: held14 } = await admin.from('order_events').select('payload').eq('order_id', o14).eq('event', 'payout_held')
      check('a payout run refuses a FULL payout when a refund exists (held, reason refund_exists, no transfer)', rel14.status === 200 && (await payoutOf(o14))?.status === 'held' && !(await payoutOf(o14))?.razorpay_transfer_id && (held14 ?? []).some((e) => ((e.payload as { reasons?: string[] } | null)?.reasons ?? []).includes('refund_exists')))
      await admin.from('payouts').update({ amount_paise: share14 }).eq('id', p14!.id)
      const rel14b = await adminPost(`/api/v1/admin/payouts/${p14!.id}`, { action: 'retry' })
      const paid14 = await payoutOf(o14)
      check('… and releases the provider’s share (the planner allows it)', rel14b.status === 200 && paid14?.status === 'paid' && Number(paid14?.amount_paise) === share14)
      // A paid payout → 409 provider_already_paid, no refund; a transfer in flight → 409 payout_in_flight.
      const man12 = await adminPost(`/api/v1/admin/orders/${o12}`, { action: 'manual_refund', amountPaise: 50_000 })
      const { count: rf12 } = await admin.from('refunds').select('id', { count: 'exact', head: true }).eq('payment_id', (await rzpPaymentOf(o12)).id)
      check('manual refund on a PAID payout → 409 provider_already_paid, nothing refunded', man12.status === 409 && man12.body['error'] === 'provider_already_paid' && rf12 === 0)
      await admin.from('payouts').update({ status: 'processing' }).eq('id', p13!.id)
      const man13 = await adminPost(`/api/v1/admin/orders/${o13}`, { action: 'manual_refund', amountPaise: 50_000 })
      const { count: rf13 } = await admin.from('refunds').select('id', { count: 'exact', head: true }).eq('payment_id', pm13.id)
      check('manual refund while a transfer is in flight → 409 payout_in_flight, nothing refunded', man13.status === 409 && man13.body['error'] === 'payout_in_flight' && rf13 === 0)
      await admin.from('payouts').update({ status: 'held' }).eq('id', p13!.id)

      // (h) M21 — an expired unpaid session is never resumed: the same key answers 409 checkout_expired; a fresh session carries the sheet timeout.
      const key = randomUUID()
      const coRes = await fetch(`${BASE}/api/v1/checkout`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` }, body: JSON.stringify({ packageId, idempotencyKey: key }) })
      const co = (await coRes.json().catch(() => ({}))) as { checkoutSessionId?: string; checkoutTimeoutSeconds?: number; simulated?: boolean }
      if (co.checkoutSessionId) sessionIds.push(co.checkoutSessionId)
      check('a fresh checkout carries the Razorpay timeout (≈ 30 minutes)', coRes.status === 200 && (co.checkoutTimeoutSeconds ?? 0) > 1700 && (co.checkoutTimeoutSeconds ?? 0) <= 1800)
      // Past expires_at AND the 15-minute capture grace, so a late capture is refused too.
      await admin.from('checkout_sessions').update({ expires_at: new Date(Date.now() - 20 * 60_000).toISOString() }).eq('id', co.checkoutSessionId ?? '')
      const again = await fetch(`${BASE}/api/v1/checkout`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` }, body: JSON.stringify({ packageId, idempotencyKey: key }) })
      const againBody = (await again.json().catch(() => ({}))) as { code?: string }
      check('the same key on an expired session → 409 checkout_expired (never resumed)', again.status === 409 && againBody.code === 'checkout_expired')
      if (co.simulated && co.checkoutSessionId) {
        const sim = await fetch(`${BASE}/api/v1/checkout/simulate`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyerToken}` }, body: JSON.stringify({ checkoutSessionId: co.checkoutSessionId }) })
        const simBody = (await sim.json().catch(() => ({}))) as { code?: string; orderId?: string }
        const { data: simSess } = await admin.from('checkout_sessions').select('order_id, status').eq('id', co.checkoutSessionId).single()
        const { data: simExc } = await admin.from('capture_exceptions').select('id, simulated, status').eq('checkout_session_id', co.checkoutSessionId)
        for (const x of simExc ?? []) exceptionIds.push(x.id as string)
        check('a (simulated) capture on the expired session → 409 checkout_expired, no order, one simulated exception refunded', sim.status === 409 && simBody.code === 'checkout_expired' && !simSess?.order_id && (simExc ?? []).length === 1 && simExc![0]!.simulated === true && simExc![0]!.status === 'refunded')
      }
    } finally {
      if (exceptionIds.length) await admin.from('capture_exceptions').delete().in('id', exceptionIds)
      if (sessionIds.length) await admin.from('checkout_sessions').delete().in('id', sessionIds)
    }
  }

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
  for (const u of [providerUserId, buyerUserId, adminUserId]) {
    if (!u) continue
    await admin.from('audit_logs').delete().eq('actor_id', u)
    await admin.from('users').delete().eq('id', u)
    await admin.auth.admin.deleteUser(u).catch(() => {})
  }
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); process.exit(1) })
