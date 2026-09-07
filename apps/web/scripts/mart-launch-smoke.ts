/**
 * AMC Mart — FLIP SMOKE (MART_DESIGN.md §8 "smoke the goods lifecycle with one
 * real internal order"). Drives ONE real goods order end-to-end through the
 * public API with two internal accounts, pausing for the human step (the real
 * payment) when the deployment is on live keys. Nothing is faked and nothing
 * is cleaned up: the order is a real internal purchase (founder's plant →
 * founder's buying entity).
 *
 * Env (apps/web/.env.local + shell):
 *   BASE_URL, NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 *   SMOKE_BUYER_EMAIL / SMOKE_BUYER_PASSWORD   — an internal MSME account (profile complete)
 *   SMOKE_SELLER_EMAIL / SMOKE_SELLER_PASSWORD — the seller that owns SMOKE_PRODUCT_ID
 *   SMOKE_PRODUCT_ID, SMOKE_QTY (default = the listing's MOQ)
 *   SMOKE_PHOTO — path to a real JPEG used as dispatch + delivery evidence
 *   SMOKE_PICKUP=true to skip the address (seller-arranged pickup)
 *
 * Run: BASE_URL=https://amclub.in pnpm --filter @amclub/web exec tsx scripts/mart-launch-smoke.ts
 */
import { config } from 'dotenv'
import path from 'path'
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'
const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const need = (k: string) => { const v = process.env[k]; if (!v) { console.error(`${k} required`); process.exit(2) } return v }
const BUYER = { email: need('SMOKE_BUYER_EMAIL'), password: need('SMOKE_BUYER_PASSWORD') }
const SELLER = { email: need('SMOKE_SELLER_EMAIL'), password: need('SMOKE_SELLER_PASSWORD') }
const PRODUCT = need('SMOKE_PRODUCT_ID')
const PHOTO = need('SMOKE_PHOTO')
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })

const step = (n: string) => console.log(`\n▶ ${n}`)
const ok = (n: string, x = '') => console.log(`  ✓ ${n}${x ? ' — ' + x : ''}`)
const die = (n: string, x = ''): never => { console.error(`  ✗ ${n}${x ? ' — ' + x : ''}`); process.exit(1) }
async function signIn(u: { email: string; password: string }) {
  const anon = createClient(URL_, ANON, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword(u)
  if (error || !data.session) die(`sign in ${u.email}`, error?.message)
  return data.session!.access_token
}
const api = async (token: string, p: string, body?: unknown, method = body ? 'POST' : 'GET') => {
  const r = await fetch(`${BASE}${p}`, { method, headers: { ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), Authorization: `Bearer ${token}` }, ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any }
}
async function upload(token: string, orderId: string, kind: 'dispatch_photo' | 'delivery_photo') {
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array(readFileSync(PHOTO))], `${kind}.jpg`, { type: 'image/jpeg' }))
  fd.append('kind', kind)
  const r = await api(token, `/api/v1/orders/${orderId}/documents`, fd)
  if (r.status !== 200) die(`upload ${kind}`, JSON.stringify(r.body))
  return r.body['id'] as string
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  console.log(`\nMart flip smoke → ${BASE}\n`)
  step('Sign in both internal accounts')
  const [buyer, seller] = await Promise.all([signIn(BUYER), signIn(SELLER)])
  ok('buyer + seller tokens')

  step('Listing is live')
  const p = await api(buyer, `/api/v1/mart/products/${PRODUCT}`)
  if (p.status !== 200) die('product not public', String(p.status))
  const product = p.body['product'] ?? p.body
  const qty = Number(process.env['SMOKE_QTY'] ?? product.minOrderQty ?? 1)
  ok(`${product.name} · ${qty} ${product.unit} · seller ${product.seller?.displayName}`)

  step('Server-computed totals')
  const pv = await api(buyer, '/api/v1/mart/cart/preview', { items: [{ product_id: PRODUCT, qty }] })
  if (pv.status !== 200) die('cart preview', JSON.stringify(pv.body))
  ok(`taxable ${pv.body.amounts.taxablePaise} · GST ${pv.body.amounts.gstPaise} · total ${pv.body.amounts.totalPaise} paise`)

  step('Checkout session (one seller, frozen line + delivery)')
  const dd = await api(buyer, '/api/v1/mart/delivery-defaults')
  const delivery = { ...(dd.body['defaults'] ?? {}), pickup: process.env['SMOKE_PICKUP'] === 'true' }
  delete (delivery as Record<string, unknown>)['source']
  const co = await api(buyer, '/api/v1/mart/checkout', { items: [{ product_id: PRODUCT, qty }], delivery, idempotencyKey: randomUUID() })
  if (co.status !== 200) die('checkout', JSON.stringify(co.body))
  ok(`session ${co.body.checkoutSessionId} · razorpay order ${co.body.razorpayOrderId} · ₹${(co.body.amountPaise / 100).toFixed(2)} · ${co.body.simulated ? 'SIMULATED (test keys)' : 'LIVE keys'}`)

  step('Payment')
  let orderId: string | null = null
  if (co.body.simulated) {
    const sim = await api(buyer, '/api/v1/checkout/simulate', { checkoutSessionId: co.body.checkoutSessionId })
    if (sim.status !== 200) die('simulate', JSON.stringify(sim.body))
    orderId = sim.body.orderId
    ok(`simulated → order ${orderId}`)
  } else {
    console.log(`  → Pay this session in the browser as ${BUYER.email}: ${BASE}/app/mart/checkout (Razorpay order ${co.body.razorpayOrderId}).`)
    console.log('    Waiting for the webhook to materialize the order (polls every 10 s, up to 30 min)…')
    for (let i = 0; i < 180 && !orderId; i++) {
      await sleep(10_000)
      const { data: pay } = await admin.from('payments').select('order_id, status').eq('razorpay_order_id', co.body.razorpayOrderId).maybeSingle()
      if (pay?.order_id) orderId = pay.order_id as string
    }
    if (!orderId) die('order never materialized — check Razorpay webhook delivery (§2.5 rule 2)')
    ok(`webhook → order ${orderId}`)
  }

  step('Goods lifecycle')
  const { data: oRow } = await admin.from('orders').select('kind, status, order_number, line_items, delivery_snapshot').eq('id', orderId!).maybeSingle()
  const o = oRow ?? die('order row missing')
  if (o.kind !== 'goods') die('order is not kind=goods', JSON.stringify(o))
  ok(`${o.order_number} kind=goods status=${o.status}`)
  const acc = await api(seller, `/api/v1/mart/orders/${orderId}/transition`, { action: 'accept' })
  if (acc.body['status'] !== 'accepted') die('seller accept', JSON.stringify(acc.body))
  ok('seller accepted')
  const dispatchDoc = await upload(seller, orderId!, 'dispatch_photo')
  const disp = await api(seller, `/api/v1/mart/orders/${orderId}/transition`, { action: 'dispatch', dispatch: { dispatch_photo_doc_id: dispatchDoc, seller_invoice_number: `SMOKE-${Date.now()}` } })
  if (disp.body['status'] !== 'in_progress') die('dispatch', JSON.stringify(disp.body))
  ok('dispatched with photo + invoice number')
  const deliverDoc = await upload(seller, orderId!, 'delivery_photo')
  const dv = await api(seller, `/api/v1/mart/orders/${orderId}/transition`, { action: 'deliver', deliver: { delivery_photo_doc_id: deliverDoc } })
  if (dv.body['status'] !== 'delivered') die('deliver', JSON.stringify(dv.body))
  ok('delivered with photo (72 h auto-accept armed)')
  const rc = await api(buyer, `/api/v1/mart/orders/${orderId}/transition`, { action: 'accept_delivery' })
  if (rc.body['status'] !== 'completed') die('buyer receipt', JSON.stringify(rc.body))
  ok('buyer confirmed receipt → completed')

  step('Money is held behind the release gate')
  const { data: payoutRow } = await admin.from('payouts').select('id, status, amount_paise, tds_section, tds_paise').eq('order_id', orderId!).maybeSingle()
  const payout = payoutRow ?? die('no payout row')
  const { data: ev } = await admin.from('order_events').select('event, payload').eq('order_id', orderId!).eq('event', 'payout_held').maybeSingle()
  const reasons = ((ev?.payload as { reasons?: string[] } | null)?.reasons ?? []).join(',')
  ok(`payout ${payout.status} · ${payout.amount_paise} paise · TDS ${payout.tds_section ?? '—'} ${payout.tds_paise ?? 0} · gate: ${reasons || 'clear'}`)
  const { data: inv } = await admin.from('invoices').select('kind').eq('order_id', orderId!)
  ok(`${(inv ?? []).length} invoices generated`)

  console.log(`\n✅ smoke complete — order ${orderId}.`)
  console.log(`   Next (human): after the category return window closes, release the payout from ${BASE}/admin/mart/orders/${orderId} and confirm the seller receives it. Then announce.\n`)
})().catch((e) => { console.error(e); process.exit(1) })
