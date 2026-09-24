/**
 * AMC Mart M2 — goods RFQ acceptance suite over the REAL HTTP API against a
 * server running with MART_ENABLED=true and staged migrations 0022–0024
 * applied to the target database (local server on a bootstrapped DB, then the
 * preview URL). Founder-environment version of the session-rig lifecycle
 * script (docs/mart/SPINE_VERIFICATION.md §4c); creates its own users and
 * removes everything in `finally` (zero residue).
 *
 *  A. Services RFQ untouched: fans out to the services provider only; a
 *     services quote keeps the client price; goods terms on it → 422.
 *  B. Goods RFQ: needs goods_spec; BIS-blocked category → 422; fan-out to
 *     in-state goods sellers with a listing in the category (else every
 *     in-state goods seller); services providers and out-of-state sellers
 *     never see it.
 *  C. Goods quote: terms required; unowned listing refused; price_paise is
 *     qty × unit price regardless of the client total; buyer view carries
 *     server money (GST, incl., after ITC).
 *  D. Accept: ordinary goods checkout session (kind='goods', one line,
 *     delivery snapshot) → simulate → orders.kind='goods'; RFQ/quote accepted;
 *     re-accept 409; simulate replay creates no second order.
 *
 * Run: BASE_URL=http://localhost:3000 pnpm --filter @amclub/web exec tsx scripts/verify-goods-rfq.ts
 */
import { config } from 'dotenv'
import path from 'path'
import { randomUUID } from 'crypto'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })

const tag = `grfq_${Date.now()}`
let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, extra = '') => { console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' ' + extra : ''}`); cond ? pass++ : fail++ }

const created = { users: [] as string[], providerIds: [] as string[], msmeIds: [] as string[], productIds: [] as string[], rfqIds: [] as string[], orderIds: [] as string[] }

async function mkUser(label: string, roles: string[]) {
  const email = `${tag}_${label}@killtest.amclub`
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error(`${label}: ${error.message}`)
  created.users.push(data.user.id)
  await admin.from('users').insert({ id: data.user.id, email, roles })
  const anon = createClient(URL_, ANON, { auth: { persistSession: false } })
  const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
  return { uid: data.user.id, token: s.session!.access_token }
}
const api = async (token: string | null, p: string, body?: unknown, method = body ? 'POST' : 'GET') => {
  const r = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any } // eslint-disable-line @typescript-eslint/no-explicit-any
}
async function mkProvider(uid: string, label: string, state: string, sellsGoods: boolean) {
  const { data, error } = await admin.from('provider_profiles').insert({ user_id: uid, legal_name: `${tag} ${label}`, display_name: `${tag} ${label}`, slug: `${tag}-${label}`, state, city: 'Kurnool', languages: ['en'], status: 'active', sells_goods: sellsGoods }).select('id').single()
  if (error) throw new Error(`provider ${label}: ${error.message}`)
  created.providerIds.push(data.id)
  return data.id as string
}
/** Suites run on shared databases: assert membership, never exact equality of the match set. */
const ok2xx = (status: number) => status === 200 || status === 201
const matches = async (rfqId: string) => ((await admin.from('rfq_matches').select('provider_id').eq('rfq_id', rfqId)).data ?? []).map((m) => m.provider_id as string).sort()

async function main() {
  console.log(`\nGoods RFQ acceptance → ${BASE}\n`)
  const [buyer, seller, svc, sellerTS] = await Promise.all([mkUser('buyer', ['msme']), mkUser('seller', ['provider']), mkUser('svc', ['provider']), mkUser('seller_ts', ['provider'])])
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: `${tag} buyer`, sector: 'manufacturing', state: 'AP', city: 'Kurnool', pincode: '518001', profile_completeness: 90 }).select('id').single()
  created.msmeIds.push(msme!.id)
  const sellerId = await mkProvider(seller.uid, 'seller', 'AP', true)
  const svcId = await mkProvider(svc.uid, 'svc', 'AP', false)
  const sellerTSId = await mkProvider(sellerTS.uid, 'seller-ts', 'TS', true)
  const { data: cat } = await admin.from('categories').select('id, slug').eq('is_active', true).order('sort_order').limit(1).single()
  await admin.from('provider_categories').insert({ provider_id: svcId, category_id: cat!.id })
  const { data: bolt } = await admin.from('products').insert({ seller_id: sellerId, category_slug: 'fasteners', name: `${tag} M12 bolt`, hsn_code: '7318', gst_rate_bps: 1800, unit: 'pcs', status: 'active', list_price_paise: 900 }).select('id').single()
  const { data: disc } = await admin.from('products').insert({ seller_id: sellerId, category_slug: 'abrasives', name: `${tag} disc`, hsn_code: '6804', gst_rate_bps: 1800, unit: 'box', status: 'active', list_price_paise: 30000 }).select('id').single()
  created.productIds.push(bolt!.id, disc!.id)
  const { data: blocked } = await admin.from('mart_categories').select('slug').eq('bis_blocked', true).limit(1).maybeSingle()
  const deliv = { contact_name: 'Ravi', contact_phone: '9876543210', address: 'Plot 4, Industrial Estate', city: 'Kurnool', state: 'AP', pincode: '518001', pickup: false }
  const spec = (over: Record<string, unknown> = {}) => ({ item: 'M12 × 50 hex bolt, zinc plated', qty: 500, unit: 'pcs', spec: [{ k: 'Grade', v: '8.8' }], target_unit_price_paise: 900, delivery: deliv, ...over })

  console.log('A. Services RFQ untouched')
  const s1 = await api(buyer.token, '/api/v1/rfq', { category_slug: cat!.slug, title: `${tag} GST filing for a small foundry`, details: {}, attachments: [] })
  ok('services RFQ created', ok2xx(s1.status), JSON.stringify(s1.body).slice(0, 120))
  if (s1.body.rfqId) created.rfqIds.push(s1.body.rfqId)
  { const m = await matches(s1.body.rfqId); ok('matched the services provider, not the goods sellers', m.includes(svcId) && !m.includes(sellerId) && !m.includes(sellerTSId), m.join(',')) }
  const sq = await api(svc.token, `/api/v1/rfq/${s1.body.rfqId}/quote`, { price_paise: 250000, delivery_days: 7, scope: 'Monthly GSTR-1 and GSTR-3B filing, reconciliation, notices.' })
  const sqRow = sq.body.quoteId ? (await admin.from('quotes').select('price_paise').eq('id', sq.body.quoteId).single()).data : null
  ok('services quote keeps the client price', ok2xx(sq.status) && Number(sqRow?.price_paise) === 250000)
  const s2 = await api(buyer.token, '/api/v1/rfq', { category_slug: cat!.slug, title: `${tag} second services request here`, details: {}, attachments: [] })
  if (s2.body.rfqId) created.rfqIds.push(s2.body.rfqId)
  const sqg = await api(svc.token, `/api/v1/rfq/${s2.body.rfqId}/quote`, { price_paise: 1000, delivery_days: 7, scope: 'Monthly GSTR-1 and GSTR-3B filing, reconciliation, notices.', goods: { unit_price_paise: 1, gst_rate_bps: 1800, hsn_code: '7318' } })
  ok('goods terms on a services RFQ → 422 goods_terms_not_allowed', sqg.status === 422 && sqg.body.error === 'goods_terms_not_allowed', sqg.body.error)

  console.log('B. Goods RFQ validation + fan-out')
  const b1 = await api(buyer.token, '/api/v1/rfq', { kind: 'goods', mart_category_slug: 'fasteners', title: `${tag} bolts without a spec`, details: {} })
  ok('goods RFQ without goods_spec refused', b1.status === 400 || b1.status === 422, String(b1.status))
  if (blocked) {
    const b2 = await api(buyer.token, '/api/v1/rfq', { kind: 'goods', mart_category_slug: blocked.slug, title: `${tag} blocked category`, details: {}, goods_spec: spec() })
    ok('BIS-blocked category refused (422)', b2.status === 422, String(b2.status))
  }
  const g1 = await api(buyer.token, '/api/v1/rfq', { kind: 'goods', mart_category_slug: 'fasteners', title: `${tag} M12 × 50 hex bolt × 500 pcs`, details: {}, goods_spec: spec({ product_id: bolt!.id }) })
  ok('goods RFQ created', ok2xx(g1.status), JSON.stringify(g1.body).slice(0, 120))
  const goodsRfq = g1.body.rfqId as string
  created.rfqIds.push(goodsRfq)
  const row = (await admin.from('rfqs').select('kind, category_id, mart_category_slug, goods_spec').eq('id', goodsRfq).single()).data!
  ok("row kind='goods', category_id NULL, spec stored", row.kind === 'goods' && row.category_id === null && row.mart_category_slug === 'fasteners' && (row.goods_spec as { qty: number }).qty === 500)
  { const m = await matches(goodsRfq); ok('fan-out: in-state goods seller with a fasteners listing; never the services provider or the TS seller', m.includes(sellerId) && !m.includes(svcId) && !m.includes(sellerTSId), m.join(',')) }
  const g2 = await api(buyer.token, '/api/v1/rfq', { kind: 'goods', mart_category_slug: 'spares', title: `${tag} lathe chuck jaws 200 mm`, details: {}, goods_spec: spec({ item: 'Lathe chuck jaws 200 mm', qty: 4, unit: 'set', spec: [] }) })
  if (g2.body.rfqId) created.rfqIds.push(g2.body.rfqId)
  { const m = await matches(g2.body.rfqId); ok('no listing in category → every in-state goods seller (still not TS, not services)', ok2xx(g2.status) && m.includes(sellerId) && !m.includes(svcId) && !m.includes(sellerTSId), m.join(',')) }
  ok('services provider cannot read the goods RFQ', (await api(svc.token, `/api/v1/rfq/${goodsRfq}`)).status === 404)
  ok('out-of-state goods seller cannot read it', (await api(sellerTS.token, `/api/v1/rfq/${goodsRfq}`)).status === 404)
  // Audit M4 (0077) — the buyer's delivery contact: the matched seller's API view has where, not who, and no
  // client role reads rfqs.goods_spec straight through PostgREST (the routes read it on the service role).
  {
    const asUser = (token: string) => createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } })
    const sv = await api(seller.token, `/api/v1/rfq/${goodsRfq}`)
    const sellerSpec = JSON.stringify(sv.body.rfq?.goodsSpec ?? sv.body.goodsSpec ?? null)
    ok("matched seller's API view: city / pincode, never the buyer's phone or name", sv.status === 200 && sellerSpec.includes('518001') && !sellerSpec.includes('9876543210') && !sellerSpec.includes('Ravi'), sellerSpec.slice(0, 200))
    const sellerRow = await asUser(seller.token).from('rfqs').select('id').eq('id', goodsRfq)
    ok('matched seller reads the RFQ row through PostgREST (control)', !sellerRow.error && (sellerRow.data ?? []).length === 1, sellerRow.error?.message ?? '')
    const sellerSpecRead = await asUser(seller.token).from('rfqs').select('goods_spec').eq('id', goodsRfq)
    ok('matched seller reading rfqs.goods_spec through PostgREST → permission error', !!sellerSpecRead.error, JSON.stringify(sellerSpecRead.data))
    const sellerStar = await asUser(seller.token).from('rfqs').select('*').eq('id', goodsRfq)
    ok('matched seller select=* on rfqs → permission error (no way around the column grant)', !!sellerStar.error, JSON.stringify(sellerStar.data).slice(0, 120))
    const buyerSpecRead = await asUser(buyer.token).from('rfqs').select('goods_spec').eq('id', goodsRfq)
    ok('the buyer too reads goods_spec only through the API (PostgREST → permission error)', !!buyerSpecRead.error, JSON.stringify(buyerSpecRead.data))
    const bOwn = await api(buyer.token, `/api/v1/rfq/${goodsRfq}`)
    ok("the buyer's API view keeps the full delivery contact", JSON.stringify(bOwn.body.rfq?.goodsSpec ?? null).includes('9876543210'), JSON.stringify(bOwn.body.rfq?.goodsSpec ?? null).slice(0, 200))
  }

  console.log('C. Goods quote')
  const q0 = await api(seller.token, `/api/v1/rfq/${goodsRfq}/quote`, { price_paise: 100, delivery_days: 5, scope: 'Zinc plated grade 8.8, IS 1364, packed 100 per box, ex Kurnool.' })
  ok('quote without goods terms → 422 goods_terms_required', q0.status === 422 && q0.body.error === 'goods_terms_required', q0.body.error)
  const q1 = await api(seller.token, `/api/v1/rfq/${goodsRfq}/quote`, { price_paise: 100, delivery_days: 5, scope: 'Zinc plated grade 8.8, IS 1364, packed 100 per box, ex Kurnool.', goods: { unit_price_paise: 850, gst_rate_bps: 1800, hsn_code: '7318', product_id: disc!.id } })
  ok('listing outside the category / not owned refused', q1.status >= 400 && q1.status < 500, String(q1.status))
  const q2 = await api(seller.token, `/api/v1/rfq/${goodsRfq}/quote`, { price_paise: 100, delivery_days: 5, scope: 'Zinc plated grade 8.8, IS 1364, packed 100 per box, ex Kurnool.', goods: { unit_price_paise: 850, gst_rate_bps: 1800, hsn_code: '7318', product_id: bolt!.id } })
  ok('goods quote created', ok2xx(q2.status), JSON.stringify(q2.body).slice(0, 120))
  const quoteId = q2.body.quoteId as string
  const qrow = (await admin.from('quotes').select('price_paise, unit_price_paise, qty, gst_rate_bps, hsn_code, product_id').eq('id', quoteId).single()).data!
  ok('price_paise = 500 × 850 (client 100 ignored), terms stored', Number(qrow.price_paise) === 425000 && Number(qrow.unit_price_paise) === 850 && Number(qrow.qty) === 500 && qrow.hsn_code === '7318' && qrow.product_id === bolt!.id)
  const bv = await api(buyer.token, `/api/v1/rfq/${goodsRfq}`)
  const bq = bv.body.rfq?.quotes?.[0]
  ok('buyer view carries server money (taxable 425000, GST 76500, incl 501500, after ITC 425000)', bq?.goods?.taxablePaise === 425000 && bq.goods.gstPaise === 76500 && bq.goods.totalInclGstPaise === 501500 && bq.goods.afterItcPaise === 425000, JSON.stringify(bq?.goods))

  console.log('D. Accept → ordinary goods checkout → goods order')
  const co = await api(buyer.token, '/api/v1/checkout', { quoteId, idempotencyKey: randomUUID() })
  ok('checkout session created', co.status === 200 && !!co.body.checkoutSessionId, JSON.stringify(co.body).slice(0, 160))
  const sess = (await admin.from('checkout_sessions').select('kind, line_items, delivery_snapshot, price_paise, gst_paise, total_paise').eq('id', co.body.checkoutSessionId).single()).data!
  const line = (sess.line_items as { tier_unit_price_paise: number; qty: number; category_slug: string }[])[0]!
  ok("session kind='goods', one line 850 × 500 (fasteners), delivery snapshot, 425000 + 76500", sess.kind === 'goods' && line.tier_unit_price_paise === 850 && line.qty === 500 && line.category_slug === 'fasteners' && (sess.delivery_snapshot as { city: string }).city === 'Kurnool' && Number(sess.price_paise) === 425000 && Number(sess.gst_paise) === 76500 && Number(sess.total_paise) === 501500)
  const sim = await api(buyer.token, '/api/v1/checkout/simulate', { checkoutSessionId: co.body.checkoutSessionId })
  ok('simulate → order', sim.status === 200 && !!sim.body.orderId, JSON.stringify(sim.body).slice(0, 120))
  const orderId = sim.body.orderId as string
  if (orderId) created.orderIds.push(orderId)
  const ord = (await admin.from('orders').select('kind, status, line_items, delivery_snapshot, total_paise, quote_id, provider_id').eq('id', orderId).single()).data!
  ok("orders.kind='goods' with frozen line + delivery + quote link", ord.kind === 'goods' && ord.status === 'placed' && Number(ord.total_paise) === 501500 && ord.quote_id === quoteId && ord.provider_id === sellerId && (ord.delivery_snapshot as { pincode: string }).pincode === '518001')
  const st = (await admin.from('rfqs').select('status').eq('id', goodsRfq).single()).data!
  const qs = (await admin.from('quotes').select('status').eq('id', quoteId).single()).data!
  ok('RFQ accepted, quote accepted', st.status === 'accepted' && qs.status === 'accepted')
  ok('re-accept refused (409)', (await api(buyer.token, '/api/v1/checkout', { quoteId, idempotencyKey: randomUUID() })).status === 409)
  await api(buyer.token, '/api/v1/checkout/simulate', { checkoutSessionId: co.body.checkoutSessionId })
  ok('simulate replay creates no second order', ((await admin.from('orders').select('id').eq('quote_id', quoteId)).data ?? []).length === 1)
}

main()
  .catch((e) => { console.error(e); fail++ })
  .finally(async () => {
    // Zero residue — order first (FKs), then the rest.
    for (const id of created.orderIds) { await admin.from('order_events').delete().eq('order_id', id); await admin.from('payouts').delete().eq('order_id', id); await admin.from('orders').delete().eq('id', id) }
    if (created.msmeIds.length) await admin.from('checkout_sessions').delete().in('msme_id', created.msmeIds)
    if (created.rfqIds.length) { await admin.from('quotes').delete().in('rfq_id', created.rfqIds); await admin.from('rfq_matches').delete().in('rfq_id', created.rfqIds); await admin.from('rfqs').delete().in('id', created.rfqIds) }
    if (created.productIds.length) await admin.from('products').delete().in('id', created.productIds)
    if (created.providerIds.length) { await admin.from('provider_categories').delete().in('provider_id', created.providerIds); await admin.from('provider_profiles').delete().in('id', created.providerIds) }
    if (created.msmeIds.length) await admin.from('msme_profiles').delete().in('id', created.msmeIds)
    if (created.users.length) await admin.from('notifications').delete().in('user_id', created.users)
    for (const uid of created.users) { await admin.from('users').delete().eq('id', uid); await admin.auth.admin.deleteUser(uid) }
    console.log(`\n${pass} passed, ${fail} failed\n`)
    process.exit(fail ? 1 : 0)
  })
