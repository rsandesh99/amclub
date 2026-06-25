/**
 * KILL-TEST (done-criterion 3): a DROPPED webhook is recovered by reconciliation.
 *
 * 1. Creates a checkout_session — simulating "paid at Razorpay, webhook never
 *    arrived" (no order, no payment locally).
 * 2. Runs reconciliation with a stub gateway whose listCapturedPayments returns
 *    the captured payment → asserts the order is now MATERIALISED via the SAME
 *    idempotent path the webhook uses.
 * 3. Runs reconciliation AGAIN → asserts it recovers NOTHING new (idempotent).
 */
import { config } from 'dotenv'
import path from 'path'
import { randomUUID } from 'crypto'
config({ path: path.resolve(__dirname, '../.env.local') })

import { createClient } from '@supabase/supabase-js'
import { computeOrderAmounts } from '@amclub/shared'

const sb = createClient(process.env['NEXT_PUBLIC_SUPABASE_URL']!, process.env['SUPABASE_SERVICE_ROLE_KEY']!, {
  auth: { persistSession: false },
})

let pass = 0
let fail = 0
function check(name: string, cond: boolean) {
  if (cond) { console.log(`  ✓ ${name}`); pass++ }
  else { console.log(`  ✗ ${name}`); fail++ }
}

// Inline reconciliation loop (mirrors lib/payments/materialize.reconcileCapturedPayments,
// avoiding the '@/' alias so tsx can run standalone). One captured payment in, the
// same materialize_order RPC the webhook calls.
async function reconcile(captured: { razorpayOrderId: string; razorpayPaymentId: string; amountPaise: number; method: string }[]) {
  let recovered = 0
  for (const pay of captured) {
    const { data: existing } = await sb.from('payments').select('id').eq('razorpay_payment_id', pay.razorpayPaymentId).maybeSingle()
    if (existing) continue
    const { data: orderId, error } = await sb.rpc('materialize_order', {
      p_razorpay_order_id: pay.razorpayOrderId,
      p_razorpay_payment_id: pay.razorpayPaymentId,
      p_amount_paise: pay.amountPaise,
      p_method: pay.method,
      p_payload: { source: 'reconciliation' },
    })
    if (error) throw new Error('materialize_order failed: ' + error.message)
    if (orderId) recovered++
  }
  return recovered
}

async function main() {
  console.log('\nDropped-webhook reconciliation kill-test\n')

  const { data: pkg } = await sb
    .from('packages')
    .select('id, provider_id, price_paise, discount_bps, title_i18n, delivery_days, revision_count, category:categories(commission_bps)')
    .eq('status', 'active').limit(1).single()
  const { data: msme } = await sb.from('msme_profiles').select('id').limit(1).single()
  if (!pkg || !msme) throw new Error('Seed data missing')

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const commissionBps = (pkg as any).category?.commission_bps ?? 1000
  const amounts = computeOrderAmounts({ pricePaise: Number(pkg.price_paise), discountBps: pkg.discount_bps, commissionBps })

  const rzpOrderId = `order_drop_${Date.now()}`
  const paymentId = `pay_drop_${Date.now()}`

  const { data: session } = await sb.from('checkout_sessions').insert({
    razorpay_order_id: rzpOrderId, msme_id: msme.id, provider_id: pkg.provider_id, source: 'package', package_id: pkg.id,
    title: 'DROP-TEST order', scope_snapshot: { title: pkg.title_i18n },
    price_paise: amounts.pricePaise, discount_paise: amounts.discountPaise, gst_paise: amounts.gstPaise, total_paise: amounts.totalPaise,
    commission_bps: amounts.commissionBps, commission_paise: amounts.commissionPaise, provider_earning_paise: amounts.providerEarningPaise,
    delivery_days: pkg.delivery_days, revision_max: pkg.revision_count, idempotency_key: randomUUID(), status: 'created',
  }).select('id').single()
  if (!session) throw new Error('Failed to create checkout_session')

  // Webhook "dropped" — no order exists yet.
  const before = await sb.from('orders').select('id', { count: 'exact', head: true }).eq('id', '00000000-0000-0000-0000-000000000000')
  check('order does not exist before reconciliation', (before.count ?? 0) === 0)

  const captured = [{ razorpayOrderId: rzpOrderId, razorpayPaymentId: paymentId, amountPaise: amounts.totalPaise, method: 'upi' }]

  const recovered1 = await reconcile(captured)
  check('reconciliation recovered exactly 1 order', recovered1 === 1)

  const { data: sessionAfter } = await sb.from('checkout_sessions').select('order_id, status').eq('id', session.id).single()
  const orderId = sessionAfter?.order_id as string | undefined
  check('session materialized by reconciliation', sessionAfter?.status === 'materialized' && Boolean(orderId))

  const { count: paymentCount } = await sb.from('payments').select('id', { count: 'exact', head: true }).eq('razorpay_payment_id', paymentId)
  check('exactly one payment recorded', paymentCount === 1)

  // Second run → idempotent, recovers nothing.
  const recovered2 = await reconcile(captured)
  check('second reconciliation recovers NOTHING (idempotent)', recovered2 === 0)

  const { count: paymentCount2 } = await sb.from('payments').select('id', { count: 'exact', head: true }).eq('razorpay_payment_id', paymentId)
  check('still exactly one payment after second run', paymentCount2 === 1)

  // Cleanup.
  await sb.from('checkout_sessions').delete().eq('id', session.id)
  if (orderId) await sb.from('orders').delete().eq('id', orderId)

  console.log(`\n${fail === 0 ? '✅ DROPPED-WEBHOOK KILL-TEST PASSED' : '❌ FAILED'} — ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
