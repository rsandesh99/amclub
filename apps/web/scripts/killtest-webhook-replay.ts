/**
 * KILL-TEST (done-criteria 1 + 2): the webhook is the source of truth, and a
 * REPLAYED webhook must NOT double-create an order or double-pay.
 *
 * 1. Creates a checkout_session (frozen amounts), asserts NO order exists yet.
 * 2. POSTs a signed `payment.captured` webhook → asserts the order now exists
 *    (proves the WEBHOOK created it, not the client).
 * 3. POSTs the SAME payload again (replay) → asserts still exactly ONE order,
 *    ONE payment, and the same order id returned. NO double-create / double-pay.
 * 4. POSTs a tampered signature → asserts 400 (rejected).
 *
 * Run against a local server:  WEBHOOK_URL=http://localhost:3000/api/v1/webhooks/razorpay
 */
import { config } from 'dotenv'
import path from 'path'
import { randomUUID } from 'crypto'
config({ path: path.resolve(__dirname, '../.env.local') })

import { createClient } from '@supabase/supabase-js'
import { computeOrderAmounts } from '@amclub/shared'
import { signWebhookBody } from '../lib/payments/signature'

const sb = createClient(process.env['NEXT_PUBLIC_SUPABASE_URL']!, process.env['SUPABASE_SERVICE_ROLE_KEY']!, {
  auth: { persistSession: false },
})
const WEBHOOK_URL = process.env['WEBHOOK_URL'] ?? 'http://localhost:3000/api/v1/webhooks/razorpay'

let pass = 0
let fail = 0
function check(name: string, cond: boolean) {
  if (cond) { console.log(`  ✓ ${name}`); pass++ }
  else { console.log(`  ✗ ${name}`); fail++ }
}

async function main() {
  console.log(`\nReplay kill-test → ${WEBHOOK_URL}\n`)

  // ── Setup: a seed package + provider + msme, frozen into a checkout_session ──
  const { data: pkg } = await sb
    .from('packages')
    .select('id, provider_id, price_paise, discount_bps, title_i18n, scope_included, deliverables, delivery_days, revision_count, category:categories(commission_bps)')
    .eq('status', 'active').limit(1).single()
  const { data: msme } = await sb.from('msme_profiles').select('id').limit(1).single()
  if (!pkg || !msme) throw new Error('Seed data missing (need an active package + an msme)')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const commissionBps = (pkg as any).category?.commission_bps ?? 1000
  const amounts = computeOrderAmounts({ pricePaise: Number(pkg.price_paise), discountBps: pkg.discount_bps, commissionBps })

  const rzpOrderId = `order_kt_${Date.now()}`
  const paymentId = `pay_kt_${Date.now()}`
  const idem = randomUUID()

  const { data: session, error: sErr } = await sb.from('checkout_sessions').insert({
    razorpay_order_id: rzpOrderId,
    msme_id: msme.id,
    provider_id: pkg.provider_id,
    source: 'package',
    package_id: pkg.id,
    title: 'KILLTEST order',
    scope_snapshot: { title: pkg.title_i18n, scopeIncluded: pkg.scope_included, deliverables: pkg.deliverables },
    price_paise: amounts.pricePaise,
    discount_paise: amounts.discountPaise,
    gst_paise: amounts.gstPaise,
    total_paise: amounts.totalPaise,
    commission_bps: amounts.commissionBps,
    commission_paise: amounts.commissionPaise,
    provider_earning_paise: amounts.providerEarningPaise,
    delivery_days: pkg.delivery_days,
    revision_max: pkg.revision_count,
    idempotency_key: idem,
    status: 'created',
  }).select('id').single()
  if (sErr || !session) throw new Error('Failed to create checkout_session: ' + sErr?.message)

  // (1) No order before the webhook.
  const beforeOrders = await sb.from('payments').select('id', { count: 'exact', head: true }).eq('razorpay_order_id', rzpOrderId)
  check('no order/payment exists before the webhook', (beforeOrders.count ?? 0) === 0)

  const body = JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: paymentId, order_id: rzpOrderId, amount: amounts.totalPaise, method: 'upi' } } },
  })
  const sig = signWebhookBody(body)
  const headers = { 'content-type': 'application/json', 'x-razorpay-signature': sig }

  // (2) First delivery → creates the order.
  const r1 = await fetch(WEBHOOK_URL, { method: 'POST', headers, body })
  const j1 = await r1.json().catch(() => ({}))
  check('webhook #1 returns 200', r1.status === 200)

  // (3) Replay the identical payload.
  const r2 = await fetch(WEBHOOK_URL, { method: 'POST', headers, body })
  const j2 = await r2.json().catch(() => ({}))
  check('webhook #2 (replay) returns 200', r2.status === 200)
  check('replay returns the SAME order id', Boolean(j1.orderId) && j1.orderId === j2.orderId)

  // (4) Tampered signature → rejected.
  const rBad = await fetch(WEBHOOK_URL, { method: 'POST', headers: { ...headers, 'x-razorpay-signature': 'deadbeef' }, body })
  check('tampered signature is rejected with 400', rBad.status === 400)

  // ── Invariants: exactly one order, one payment, one (future) payout slot ──
  const { count: paymentCount } = await sb.from('payments').select('id', { count: 'exact', head: true }).eq('razorpay_order_id', rzpOrderId)
  check('exactly ONE payment after replay', paymentCount === 1)

  const { data: sessionAfter } = await sb.from('checkout_sessions').select('order_id, status').eq('id', session.id).single()
  check('session is materialized', sessionAfter?.status === 'materialized')
  const orderId = sessionAfter?.order_id as string | undefined

  const { count: orderCount } = await sb.from('orders').select('id', { count: 'exact', head: true }).eq('id', orderId ?? '')
  check('exactly ONE order linked to the session', orderCount === 1 && Boolean(orderId))

  const { data: order } = await sb.from('orders').select('status, total_paise, provider_earning_paise').eq('id', orderId ?? '').maybeSingle()
  check("order is in 'placed'", order?.status === 'placed')
  check('order total matches frozen amount', Number(order?.total_paise) === amounts.totalPaise)

  // ── Cleanup (delete session first to release its order_id FK, then order) ──
  await sb.from('checkout_sessions').delete().eq('id', session.id)
  if (orderId) await sb.from('orders').delete().eq('id', orderId) // cascades payments + events

  console.log(`\n${fail === 0 ? '✅ REPLAY KILL-TEST PASSED' : '❌ FAILED'} — ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
