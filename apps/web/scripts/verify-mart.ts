/**
 * AMC Mart M0 — acceptance suite (MART_DESIGN.md §7 M0) over the REAL HTTP
 * API against a server running with MART_ENABLED=true (local server on the
 * prod DB, then the preview URL). Requires the staged migration 0022 applied
 * to the target database.
 *
 *  A. Activation gate: no verified GSTIN → 409; verified → sells_goods=true.
 *  B. Catalog lifecycle: draft → submit (pending_approval) → admin approve →
 *     public; product_events emitted; cross-tenant reads/writes denied.
 *  C. Goods checkout: server totals == computeGoodsOrderAmounts; simulate →
 *     order kind='goods' with frozen line_items; replayed simulate = same order.
 *  D. Goods lifecycle: accept → dispatch (photo + inbound invoice) → deliver
 *     (photo, 72h timer) → buyer_received → completed; payout HELD with the
 *     release-gate reasons; admin release → 409 goods_release_gate while the
 *     return window is open; a zero-window category releases.
 *  E. Return + refund replay: open_return → disputed → admin resolve
 *     refund_full → return_resolved; a second resolve moves no money.
 *  F. Authz: outsiders get 401/403/404 on every goods surface.
 *  G. Services inertness on the same server: a services checkout still yields
 *     kind='service', line_items NULL; services transitions unchanged.
 *  H. Audit M16 / L4: a material edit of an approved listing goes back to review;
 *     approval is pinned to the reviewed version; a pool freezes the listing's
 *     GST / HSN / unit at open and charges them; material edits wait while it is
 *     live; the pool API returns the member's total with GST (server paise).
 *  (E also carries audit M14: a goods return from `completed` only inside the
 *   category return window and dispute_window_days — 409 return_window_closed.)
 *
 * Run: BASE_URL=http://localhost:3000 pnpm --filter @amclub/web exec tsx scripts/verify-mart.ts
 * Creates only kill-test rows; removes everything in `finally` (zero residue).
 */
import { config } from 'dotenv'
import path from 'path'
import { randomUUID } from 'crypto'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'
import { computeGoodsOrderAmounts } from '@amclub/shared'

const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })

const tag = `mart_${Date.now()}`
let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, extra = '') => { console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' ' + extra : ''}`); cond ? pass++ : fail++ }
const denied = (name: string, status: number) => ok(`${name} → ${status}`, status === 401 || status === 403 || status === 404)

const created = { users: [] as string[], providerIds: [] as string[], msmeIds: [] as string[], productIds: [] as string[], orderIds: [] as string[], categories: [] as string[], poolIds: [] as string[] }

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
const api = (token: string | null, p: string, body?: unknown, method = body ? 'POST' : 'GET') =>
  fetch(`${BASE}${p}`, {
    method,
    headers: { ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}),
  })
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => ({})) })
async function uploadDoc(token: string, orderId: string, kind: string): Promise<string> {
  const fd = new FormData()
  fd.append('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 0, 0, 0])], `${kind}.jpg`, { type: 'image/jpeg' }))
  fd.append('kind', kind)
  const r = await json(await api(token, `/api/v1/orders/${orderId}/documents`, fd))
  if (r.status !== 200) throw new Error(`upload ${kind}: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.id as string
}
const gstin = (n: number) => `37AAACK${String(1000 + n).slice(-4)}A1Z${n % 10}`

async function main() {
  console.log(`\nAMC Mart M0 acceptance → ${BASE}\n`)
  try {
    // ── Cast ───────────────────────────────────────────────────────────────
    const sellerA = await mkUser('sellerA', ['provider'])
    const sellerB = await mkUser('sellerB', ['provider'])
    const buyer = await mkUser('buyer', ['msme'])
    const buyerB = await mkUser('buyerB', ['msme'])
    const ops = await mkUser('admin', ['msme', 'admin'])
    // Audit M16 — an approval names the version the admin reviewed (the listing's updated_at, verbatim).
    const reviewedVersion = async (id: string) => ((await admin.from('products').select('updated_at').eq('id', id).single()).data?.updated_at as string | null) ?? null
    const approve = async (id: string) => api(ops.token, `/api/v1/mart/admin/products/${id}`, { action: 'approve', reviewed_updated_at: await reviewedVersion(id) })

    const mkProvider = async (uid: string, label: string, g: string) => {
      const { data: p, error } = await admin.from('provider_profiles').insert({
        user_id: uid, legal_name: label, display_name: label, slug: `${tag}-${label}`.replace(/_/g, '-'), state: 'AP', city: 'Kurnool', status: 'active', languages: ['en'], gstin: g,
      }).select('id').single()
      if (error) throw new Error(error.message)
      created.providerIds.push(p!.id)
      await admin.from('provider_bank_accounts').insert({ provider_id: p!.id, account_number_enc: 'enc', ifsc: 'HDFC0000001', account_holder: label, penny_drop_verified: true, razorpay_route_account_id: `acc_${tag}` })
      return p!.id as string
    }
    const provA = await mkProvider(sellerA.uid, 'sellerA', gstin(1))
    const provB = await mkProvider(sellerB.uid, 'sellerB', gstin(2))
    const { data: m } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'KT Buyer', state: 'AP', gstin: gstin(3) }).select('id').single()
    const { data: mB } = await admin.from('msme_profiles').insert({ user_id: buyerB.uid, business_name: 'KT Buyer B', state: 'AP' }).select('id').single()
    created.msmeIds.push(m!.id, mB!.id)
    // Kill-test categories: a 48h window (gate must hold) and a 0h window (gate clears on receipt).
    for (const [slug, hours] of [[`${tag}-hold`, 48], [`${tag}-clear`, 0]] as const) {
      await admin.from('mart_categories').insert({ slug, name_i18n: { en: slug, hi: slug, te: slug }, return_window_hours: hours, commission_bps: 500, bis_blocked: false, is_active: true, sort_order: 999 })
      created.categories.push(slug)
    }

    // ── A. Activation gate ─────────────────────────────────────────────────
    console.log('A. Goods activation gate (verified GSTIN):')
    const st0 = await json(await api(sellerA.token, '/api/v1/mart/seller/status'))
    ok('status before any verification = gstin_unverified', st0.body.activation?.state === 'gstin_unverified', st0.body.activation?.state)
    // A stub verification NEVER counts.
    await admin.from('gstin_verifications').insert({ user_id: sellerA.uid, gstin: gstin(1), verified: true, stub: true, provider: 'stub', result: {} })
    ok('activate with only a STUB verification → 409', (await api(sellerA.token, '/api/v1/mart/seller/activate', {})).status === 409)
    await admin.from('gstin_verifications').insert({ user_id: sellerA.uid, gstin: gstin(1), verified: true, stub: false, provider: 'admin_attest', result: { reason: 'killtest' } })
    const act = await json(await api(sellerA.token, '/api/v1/mart/seller/activate', {}))
    ok('activate with a real verification → 200, sells_goods=true', act.status === 200 && act.body.activation?.sellsGoods === true)
    ok('activate is idempotent', (await api(sellerA.token, '/api/v1/mart/seller/activate', {})).status === 200)

    // ── B. Catalog lifecycle ───────────────────────────────────────────────
    console.log('B. Catalog lifecycle + approval queue:')
    const productBody = (cat: string, name: string) => ({
      category_slug: cat, name, description: 'Zinc plated, grade 8.8', hsn_code: '7318', gst_rate_bps: 1800, unit: 'pcs', images: [], min_order_qty: 10, country_of_origin: 'IN',
      tiers: [{ min_qty: 1, unit_price_paise: 450 }, { min_qty: 100, unit_price_paise: 400 }],
      ai: { input_refs: { image_keys: [] }, proposed: { name: 'M8 bolt', hsn_code: '7318', gst_rate_bps: 1800, unit: 'pcs' } },
    })
    const c1 = await json(await api(sellerA.token, '/api/v1/mart/seller/products', productBody(`${tag}-hold`, `${tag} M8 bolt (hold)`)))
    ok('seller creates a draft listing → 201', c1.status === 201 && c1.body.status === 'draft', String(c1.status))
    const p1 = c1.body.id as string
    created.productIds.push(p1)
    const { data: aiRows } = await admin.from('ai_decisions').select('corrected_fields').eq('feature', 'catalog_draft').contains('input_refs', { product_id: p1 })
    ok('ai_decisions row recorded with corrected_fields (name changed)', (aiRows?.[0]?.corrected_fields as string[] | undefined)?.includes('name') === true)
    ok('unactivated seller B cannot create (sells_goods irrelevant for draft) but cannot READ A’s draft', (await api(sellerB.token, `/api/v1/mart/seller/products/${p1}`)).status === 404)
    ok('draft is NOT public', (await api(null, `/api/v1/mart/products/${p1}`)).status === 404)
    ok('seller B cannot submit A’s listing', (await api(sellerB.token, `/api/v1/mart/seller/products/${p1}`, { action: 'submit' })).status === 404)
    const sub = await json(await api(sellerA.token, `/api/v1/mart/seller/products/${p1}`, { action: 'submit' }))
    ok('submit → pending_approval (below the auto-approve threshold)', sub.status === 200 && sub.body.status === 'pending_approval', JSON.stringify(sub.body))
    ok('buyer cannot approve', (await api(buyer.token, `/api/v1/mart/admin/products/${p1}`, { action: 'approve' })).status === 403)
    const q = await json(await api(ops.token, '/api/v1/mart/admin/products?status=pending_approval'))
    ok('admin queue lists it', Array.isArray(q.body.products) && q.body.products.some((x: { id: string }) => x.id === p1))
    const queued = (q.body.products as Array<{ id: string; updatedAt?: string | null }> | undefined)?.find((x) => x.id === p1)
    ok('the queue carries the version under review (updatedAt)', !!queued && queued.updatedAt !== undefined)
    ok('an approval without the reviewed version → 422', (await api(ops.token, `/api/v1/mart/admin/products/${p1}`, { action: 'approve' })).status === 422)
    const appr = await json(await api(ops.token, `/api/v1/mart/admin/products/${p1}`, { action: 'approve', reviewed_updated_at: queued?.updatedAt ?? null }))
    ok('admin approve (pinned to the queued version) → active', appr.status === 200 && appr.body.status === 'active', JSON.stringify(appr.body))
    ok('active listing is public', (await api(null, `/api/v1/mart/products/${p1}`)).status === 200)
    const list = await json(await api(null, `/api/v1/mart/products?query=${encodeURIComponent(tag)}`))
    ok('public FTS finds it', list.body.products?.some((x: { id: string }) => x.id === p1) === true)
    const { data: pev } = await admin.from('product_events').select('event_type').eq('product_id', p1).order('created_at')
    ok('product_events: created → submitted → activated', JSON.stringify((pev ?? []).map((e) => e.event_type)) === JSON.stringify(['created', 'submitted', 'activated']), JSON.stringify(pev))
    // Second product in the zero-window category, approved the same way.
    const c2 = await json(await api(sellerA.token, '/api/v1/mart/seller/products', productBody(`${tag}-clear`, `${tag} M8 nut (clear)`)))
    const p2 = c2.body.id as string
    created.productIds.push(p2)
    await api(sellerA.token, `/api/v1/mart/seller/products/${p2}`, { action: 'submit' })
    await approve(p2)

    // ── C. Goods checkout ──────────────────────────────────────────────────
    console.log('C. Goods checkout (server totals, frozen snapshot, replay):')
    const delivery = { contact_name: 'Ravi', contact_phone: '9876543210', address: 'Plot 4, Industrial Estate', city: 'Kurnool', state: 'AP', pincode: '518001', pickup: false }
    const expect = computeGoodsOrderAmounts({ lines: [{ qty: 100, unitPricePaise: 400, gstRateBps: 1800, commissionBps: 500 }], commissionBps: 500 })
    ok('below min order qty → 422', (await api(buyer.token, '/api/v1/mart/checkout', { items: [{ product_id: p1, qty: 5 }], delivery, idempotencyKey: randomUUID() })).status === 422)
    const co = await json(await api(buyer.token, '/api/v1/mart/checkout', { items: [{ product_id: p1, qty: 100 }], delivery, idempotencyKey: randomUUID() }))
    ok('checkout → 200 with the 100-qty tier and per-line GST', co.status === 200 && co.body.amountPaise === expect.totalPaise, `${co.body.amountPaise} vs ${expect.totalPaise}`)
    ok('lineItems snapshot carries hsn + tier', co.body.lineItems?.[0]?.hsn_code === '7318' && co.body.lineItems?.[0]?.tier_unit_price_paise === 400)
    const sim = await json(await api(buyer.token, '/api/v1/checkout/simulate', { checkoutSessionId: co.body.checkoutSessionId }))
    const orderA = sim.body.orderId as string
    ok('simulate materialises the order', sim.status === 200 && !!orderA)
    if (orderA) created.orderIds.push(orderA)
    const sim2 = await json(await api(buyer.token, '/api/v1/checkout/simulate', { checkoutSessionId: co.body.checkoutSessionId }))
    ok('replayed simulate returns the SAME order', sim2.body.orderId === orderA)
    const { data: oA } = await admin.from('orders').select('kind, line_items, delivery_snapshot, total_paise, commission_paise, provider_earning_paise, status').eq('id', orderA).maybeSingle()
    ok("order.kind = 'goods'", oA?.kind === 'goods')
    ok('order money columns == computeGoodsOrderAmounts', Number(oA?.total_paise) === expect.totalPaise && Number(oA?.commission_paise) === expect.commissionPaise && Number(oA?.provider_earning_paise) === expect.providerEarningPaise)
    ok('delivery snapshot frozen on the order', (oA?.delivery_snapshot as { city?: string } | null)?.city === 'Kurnool')

    // ── D. Goods lifecycle + release gate ──────────────────────────────────
    console.log('D. Goods lifecycle + payout release gate:')
    ok('services transition route refuses goods orders', (await api(sellerA.token, `/api/v1/orders/${orderA}/transition`, { action: 'accept' })).status === 409)
    ok('buyer cannot accept', (await api(buyer.token, `/api/v1/mart/orders/${orderA}/transition`, { action: 'accept' })).status === 403)
    ok('seller accept → accepted', (await json(await api(sellerA.token, `/api/v1/mart/orders/${orderA}/transition`, { action: 'accept' }))).body.status === 'accepted')
    ok('dispatch without evidence → 422', (await api(sellerA.token, `/api/v1/mart/orders/${orderA}/transition`, { action: 'dispatch', dispatch: {} })).status === 422)
    const dispatchDoc = await uploadDoc(sellerA.token, orderA, 'dispatch_photo')
    const d = await json(await api(sellerA.token, `/api/v1/mart/orders/${orderA}/transition`, { action: 'dispatch', dispatch: { dispatch_photo_doc_id: dispatchDoc, seller_invoice_number: `INV-${tag}` } }))
    ok('dispatch (photo + inbound invoice) → in_progress', d.body.status === 'in_progress', JSON.stringify(d.body))
    const deliverDoc = await uploadDoc(sellerA.token, orderA, 'delivery_photo')
    ok('deliver with a dispatch photo id → 422 (wrong kind)', (await api(sellerA.token, `/api/v1/mart/orders/${orderA}/transition`, { action: 'deliver', deliver: { delivery_photo_doc_id: dispatchDoc } })).status === 422)
    const dv = await json(await api(sellerA.token, `/api/v1/mart/orders/${orderA}/transition`, { action: 'deliver', deliver: { delivery_photo_doc_id: deliverDoc } }))
    ok('deliver (delivery photo) → delivered', dv.body.status === 'delivered')
    const { data: oD } = await admin.from('orders').select('auto_accept_at').eq('id', orderA).maybeSingle()
    ok('72h auto-accept timer set', !!oD?.auto_accept_at)
    ok('seller cannot confirm receipt', (await api(sellerA.token, `/api/v1/mart/orders/${orderA}/transition`, { action: 'accept_delivery' })).status === 403)
    const rc = await json(await api(buyer.token, `/api/v1/mart/orders/${orderA}/transition`, { action: 'accept_delivery' }))
    ok('buyer_received → completed', rc.body.status === 'completed')
    const { data: evA } = await admin.from('order_events').select('event, payload').eq('order_id', orderA).order('created_at')
    const names = (evA ?? []).map((e) => e.event)
    ok('goods event vocabulary emitted in order', ['placed', 'accept', 'requirements_submitted', 'dispatched', 'delivered_photo', 'buyer_received'].every((e) => names.includes(e)), names.join(','))
    const held = (evA ?? []).find((e) => e.event === 'payout_held')
    const reasons = (held?.payload as { reasons?: string[] } | null)?.reasons ?? []
    ok('payout HELD with return_window_open (48h category)', reasons.includes('return_window_open'), reasons.join(','))
    const { data: payA } = await admin.from('payouts').select('id, status, tds_section').eq('order_id', orderA).maybeSingle()
    ok('payout row held + TDS fields recorded', payA?.status === 'held' && !!payA?.tds_section)
    const rel = await json(await api(ops.token, `/api/v1/admin/payouts/${payA!.id}`, { action: 'retry' }))
    ok('admin release → 409 goods_release_gate while window open', rel.status === 409 && rel.body.error === 'goods_release_gate', JSON.stringify(rel.body))
    const dossier = await json(await api(ops.token, `/api/v1/mart/admin/orders/${orderA}/dossier`))
    ok('dossier reports gate reasons + evidence docs', dossier.body.dossier?.gate?.ok === false && (dossier.body.evidence?.length ?? 0) >= 2)
    const { data: invA } = await admin.from('invoices').select('kind').eq('order_id', orderA)
    ok('buyer + commission invoices generated', (invA ?? []).length === 2)

    // Zero-window order: same lifecycle, release proceeds.
    const co2 = await json(await api(buyer.token, '/api/v1/mart/checkout', { items: [{ product_id: p2, qty: 10 }], delivery: { ...delivery, pickup: true }, idempotencyKey: randomUUID() }))
    const sim3 = await json(await api(buyer.token, '/api/v1/checkout/simulate', { checkoutSessionId: co2.body.checkoutSessionId }))
    const orderB = sim3.body.orderId as string
    created.orderIds.push(orderB)
    await api(sellerA.token, `/api/v1/mart/orders/${orderB}/transition`, { action: 'accept' })
    await api(sellerA.token, `/api/v1/mart/orders/${orderB}/transition`, { action: 'dispatch', dispatch: { dispatch_photo_doc_id: await uploadDoc(sellerA.token, orderB, 'dispatch_photo'), seller_invoice_number: `INV-${tag}-2` } })
    await api(sellerA.token, `/api/v1/mart/orders/${orderB}/transition`, { action: 'deliver', deliver: { delivery_photo_doc_id: await uploadDoc(sellerA.token, orderB, 'delivery_photo') } })
    await api(buyer.token, `/api/v1/mart/orders/${orderB}/transition`, { action: 'accept_delivery' })
    const { data: payB } = await admin.from('payouts').select('id, status').eq('order_id', orderB).maybeSingle()
    const relB = await json(await api(ops.token, `/api/v1/admin/payouts/${payB!.id}`, { action: 'retry' }))
    ok('zero-window order: gate clears on receipt, release runs the payout path', relB.status === 200, JSON.stringify(relB.body))

    // ── E. Return + refund replay ──────────────────────────────────────────
    console.log('E. Return → dispute console → refund (replay-safe):')
    // Audit M14 — the return window. orderB's category window is 0 h: it closed at the delivery photo.
    const detB = await json(await api(buyer.token, `/api/v1/orders/${orderB}`))
    ok('GET a completed goods order carries the server’s return deadline', typeof detB.body.returnDeadline === 'string' && Date.parse(detB.body.returnDeadline) <= Date.now(), JSON.stringify(detB.body.returnDeadline))
    const lateRet = await json(await api(buyer.token, `/api/v1/mart/orders/${orderB}/transition`, { action: 'open_return', return: { reason: 'damaged' } }))
    const { data: oBafter } = await admin.from('orders').select('status').eq('id', orderB).single()
    const { data: dispB } = await admin.from('disputes').select('id').eq('order_id', orderB).maybeSingle()
    ok('open_return past the category window → 409 return_window_closed + endsAt; order stays completed, no dispute', lateRet.status === 409 && lateRet.body.error === 'return_window_closed' && typeof lateRet.body.endsAt === 'string' && oBafter?.status === 'completed' && !dispB, JSON.stringify(lateRet.body))
    // …and dispute_window_days caps a completed goods order even inside its (48 h) category window.
    const { data: dwRow } = await admin.from('agent_settings').select('value').eq('key', 'dispute_window_days').maybeSingle()
    const windowDays = Number(dwRow?.value ?? 7)
    const { data: oAc } = await admin.from('orders').select('completed_at').eq('id', orderA).single()
    await admin.from('orders').update({ completed_at: new Date(Date.now() - (windowDays + 1) * 86_400_000).toISOString() }).eq('id', orderA)
    const capped = await json(await api(buyer.token, `/api/v1/mart/orders/${orderA}/transition`, { action: 'open_return', return: { reason: 'damaged' } }))
    await admin.from('orders').update({ completed_at: oAc!.completed_at }).eq('id', orderA)
    const { data: oAstill } = await admin.from('orders').select('status').eq('id', orderA).single()
    ok('completed longer ago than dispute_window_days → 409 return_window_closed (category window still open)', capped.status === 409 && capped.body.error === 'return_window_closed' && oAstill?.status === 'completed', JSON.stringify(capped.body))
    const ret = await json(await api(buyer.token, `/api/v1/mart/orders/${orderA}/transition`, { action: 'open_return', return: { reason: 'short_quantity', details: '90 of 100' } }))
    ok('open_return on a completed order → disputed', ret.body.status === 'disputed', JSON.stringify(ret.body))
    const { data: disp } = await admin.from('disputes').select('id, reason').eq('order_id', orderA).maybeSingle()
    ok('dispute row carries the return reason', disp?.reason === 'return:short_quantity')
    const r1 = await json(await api(ops.token, `/api/v1/admin/disputes/${disp!.id}/resolve`, { resolution: 'refund_full' }))
    ok('admin resolves refund_full → 200', r1.status === 200, JSON.stringify(r1.body))
    const r2 = await json(await api(ops.token, `/api/v1/admin/disputes/${disp!.id}/resolve`, { resolution: 'refund_full' }))
    ok('replayed resolve is idempotent', r2.status === 200)
    const { data: refunds } = await admin.from('refunds').select('id, status, idempotency_key').in('payment_id', (await admin.from('payments').select('id').eq('order_id', orderA)).data?.map((p) => p.id) ?? [])
    ok('exactly ONE refund row, keyed rfnd_<order_id>', refunds?.length === 1 && refunds[0]?.idempotency_key === `rfnd_${orderA}`)
    const { data: evR } = await admin.from('order_events').select('event').eq('order_id', orderA).in('event', ['return_opened', 'return_resolved'])
    ok('return_opened + return_resolved emitted', (evR ?? []).length === 2)

    // ── F. Authz ───────────────────────────────────────────────────────────
    console.log('F. Authz / IDOR on goods surfaces:')
    denied('buyer B goods-transition on A’s order', (await api(buyerB.token, `/api/v1/mart/orders/${orderB}/transition`, { action: 'accept_delivery' })).status)
    denied('seller B goods-transition on A’s order', (await api(sellerB.token, `/api/v1/mart/orders/${orderB}/transition`, { action: 'deliver', deliver: { delivery_photo_doc_id: randomUUID() } })).status)
    denied('anon admin listing queue', (await api(null, '/api/v1/mart/admin/products')).status)
    denied('buyer admin dossier', (await api(buyer.token, `/api/v1/mart/admin/orders/${orderA}/dossier`)).status)
    denied('seller B edits A’s product', (await api(sellerB.token, `/api/v1/mart/seller/products/${p1}`, productBody(`${tag}-hold`, 'x'), 'PATCH')).status)
    denied('anon seller status', (await api(null, '/api/v1/mart/seller/status')).status)
    denied('anon checkout', (await api(null, '/api/v1/mart/checkout', { items: [{ product_id: p1, qty: 100 }], delivery, idempotencyKey: randomUUID() })).status)

    // ── G. Services inertness on the same server ───────────────────────────
    console.log('G. Services path on the same server (inertness):')
    const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
    const { data: pkg } = await admin.from('packages').insert({
      provider_id: provB, category_id: cat!.id, slug: `${tag}-pkg`.replace(/_/g, '-'), title_i18n: { en: 'KT svc', hi: 'KT' }, price_paise: 500_000, discount_bps: 0, delivery_days: 3, revision_count: 1,
      status: 'active', scope_included: ['x'], scope_excluded: [], deliverables: ['y'],
    }).select('id').single()
    const sco = await json(await api(buyer.token, '/api/v1/checkout', { packageId: pkg!.id, idempotencyKey: randomUUID() }))
    const ssim = await json(await api(buyer.token, '/api/v1/checkout/simulate', { checkoutSessionId: sco.body.checkoutSessionId }))
    const svcOrder = ssim.body.orderId as string
    created.orderIds.push(svcOrder)
    const { data: oS } = await admin.from('orders').select('kind, line_items, delivery_snapshot').eq('id', svcOrder).maybeSingle()
    ok("services order kind='service', line_items NULL, delivery_snapshot NULL", oS?.kind === 'service' && oS?.line_items === null && oS?.delivery_snapshot === null)
    ok('services accept still works on the services route', (await json(await api(sellerB.token, `/api/v1/orders/${svcOrder}/transition`, { action: 'accept' }))).body.status === 'accepted')
    ok('goods route refuses a services order', (await api(sellerB.token, `/api/v1/mart/orders/${svcOrder}/transition`, { action: 'accept' })).status === 409)
    await admin.from('packages').delete().eq('id', pkg!.id)

    // ── H. Listing edits after approval + pool terms (audit M16 / L4) ───────
    console.log('H. Approved-listing edits, pinned approvals, pool tax snapshot, pool totals:')
    // sellerA has one OTHER approved listing (p2), below auto_approve_after_listings (3): review required.
    const editBody = productBody(`${tag}-hold`, `${tag} M8 bolt (hold) v2`)
    const ed = await json(await api(sellerA.token, `/api/v1/mart/seller/products/${p1}`, editBody, 'PATCH'))
    ok('a material edit (name) of an approved listing → pending_approval, off the public catalogue', ed.status === 200 && ed.body.status === 'pending_approval' && (await api(null, `/api/v1/mart/products/${p1}`)).status === 404, JSON.stringify(ed.body))
    const stale = await json(await api(ops.token, `/api/v1/mart/admin/products/${p1}`, { action: 'approve', reviewed_updated_at: '2020-01-01T00:00:00+00:00' }))
    const { data: p1Pending } = await admin.from('products').select('status').eq('id', p1).single()
    ok('an approval pinned to an older version → 409 listing_changed; nothing moves', stale.status === 409 && stale.body.error === 'listing_changed' && p1Pending?.status === 'pending_approval', JSON.stringify(stale.body))
    ok('approving the version reviewed → active again', (await json(await approve(p1))).body.status === 'active')
    const ed2 = await json(await api(sellerA.token, `/api/v1/mart/seller/products/${p1}`, { ...editBody, description: 'Zinc plated, grade 8.8, DIN 933' }, 'PATCH'))
    ok('a non-material edit (description) keeps the listing active', ed2.status === 200 && ed2.body.status === 'active', JSON.stringify(ed2.body))

    const { data: draftPool, error: poolErr } = await admin.from('pools').insert({
      product_id: p1, category_slug: `${tag}-hold`, title: `${tag} bolt pool`, unit: 'pcs', target_qty: 500, min_qty: 100, unit_price_paise: 380,
      closes_at: new Date(Date.now() + 3 * 86_400_000).toISOString(), status: 'draft', seller_id: provA, rationale: {},
    }).select('id').single()
    if (poolErr || !draftPool) throw new Error(`pool fixture: ${poolErr?.message}`)
    const poolId = draftPool.id as string
    created.poolIds.push(poolId)
    const opened = await json(await api(ops.token, `/api/v1/mart/admin/pools/${poolId}`, { action: 'approve' }))
    const { data: snap } = await admin.from('pools').select('status, gst_rate_bps, hsn_code, unit').eq('id', poolId).single()
    ok('opening the pool freezes the listing’s GST / HSN / unit on it', opened.status === 200 && snap?.status === 'open' && snap?.gst_rate_bps === 1800 && snap?.hsn_code === '7318' && snap?.unit === 'pcs', JSON.stringify(snap))
    const joinQty = 150
    const expectPool = computeGoodsOrderAmounts({ lines: [{ qty: joinQty, unitPricePaise: 380, gstRateBps: 1800 }], commissionBps: 500 })
    const expectUnit = computeGoodsOrderAmounts({ lines: [{ qty: 1, unitPricePaise: 380, gstRateBps: 1800 }], commissionBps: 0 })
    const jn = await json(await api(buyer.token, `/api/v1/mart/pools/${poolId}/join`, { qty: joinQty, delivery }))
    ok('join returns the member’s total with GST (= computeGoodsOrderAmounts) and the unit display, never the rationale', jn.status === 200 && jn.body.member?.amounts?.totalPaise === expectPool.totalPaise && jn.body.pool?.unitDisplay?.unit_incl_gst_paise === expectUnit.totalPaise && !('rationale' in (jn.body.pool ?? {})), JSON.stringify(jn.body).slice(0, 300))
    const pv = await json(await api(buyer.token, `/api/v1/mart/pools/${poolId}`))
    ok('the pool page’s member total is the same server figure', pv.body.member?.amounts?.totalPaise === expectPool.totalPaise, JSON.stringify(pv.body.member))
    const locked = await json(await api(sellerA.token, `/api/v1/mart/seller/products/${p1}`, { ...editBody, gst_rate_bps: 1200 }, 'PATCH'))
    const { data: p1Gst } = await admin.from('products').select('gst_rate_bps, status').eq('id', p1).single()
    ok('a material edit (GST) while the pool is live → 409 pool_live; the listing keeps 18 %', locked.status === 409 && locked.body.error === 'pool_live' && p1Gst?.gst_rate_bps === 1800 && p1Gst?.status === 'active', JSON.stringify(locked.body))
    // A listing changed underneath (e.g. an edit from before this fix) never changes what the member pays.
    await admin.from('products').update({ gst_rate_bps: 1200 }).eq('id', p1)
    await api(ops.token, `/api/v1/mart/admin/pools/${poolId}`, { action: 'close' })
    const pc = await json(await api(buyer.token, `/api/v1/mart/pools/${poolId}/checkout`, {}))
    await admin.from('products').update({ gst_rate_bps: 1800 }).eq('id', p1)
    ok('member checkout charges the frozen 18 % — exactly the total the pool page showed', pc.status === 200 && pc.body.amountPaise === expectPool.totalPaise && pc.body.lineItems?.[0]?.gst_rate_bps === 1800 && pc.body.lineItems?.[0]?.hsn_code === '7318', JSON.stringify(pc.body).slice(0, 300))

    console.log(`\n${fail === 0 ? '✅' : '❌'} verify-mart: ${pass} passed, ${fail} failed\n`)
  } catch (e) {
    fail++
    console.error('\n✗ suite aborted:', e instanceof Error ? e.message : e)
  } finally {
    // Zero residue — order of deletes follows the FK graph. Pools first (members + events cascade).
    for (const id of created.poolIds) await admin.from('pools').delete().eq('id', id)
    for (const id of created.orderIds) {
      const { data: pays } = await admin.from('payments').select('id').eq('order_id', id)
      for (const p of pays ?? []) await admin.from('refunds').delete().eq('payment_id', p.id)
      await admin.from('invoices').delete().eq('order_id', id)
      await admin.from('payouts').delete().eq('order_id', id)
      await admin.from('disputes').delete().eq('order_id', id)
      await admin.from('payments').delete().eq('order_id', id)
      // The rows go with the order; the objects the documents route uploaded under <orderId>/ do not — remove them too.
      const { data: objs } = await admin.storage.from('order-documents').list(id, { limit: 100 })
      if (objs?.length) { const { error } = await admin.storage.from('order-documents').remove(objs.map((o) => `${id}/${o.name}`)); if (error) console.error('  storage cleanup:', error.message) }
      await admin.from('order_documents').delete().eq('order_id', id)
      await admin.from('order_events').delete().eq('order_id', id)
      await admin.from('checkout_sessions').delete().eq('order_id', id)
      await admin.from('orders').delete().eq('id', id)
    }
    for (const m of created.msmeIds) await admin.from('checkout_sessions').delete().eq('msme_id', m)
    for (const p of created.productIds) {
      await admin.from('product_events').delete().eq('product_id', p)
      await admin.from('products').delete().eq('id', p)
    }
    for (const u of created.users) await admin.from('ai_decisions').delete().eq('decided_by', u)
    for (const c of created.categories) await admin.from('mart_categories').delete().eq('slug', c)
    for (const u of created.users) await admin.from('gstin_verifications').delete().eq('user_id', u)
    for (const p of created.providerIds) {
      await admin.from('provider_bank_accounts').delete().eq('provider_id', p)
      await admin.from('provider_profiles').delete().eq('id', p)
    }
    for (const m of created.msmeIds) await admin.from('msme_profiles').delete().eq('id', m)
    for (const u of created.users) {
      await admin.from('audit_logs').delete().eq('actor_id', u)
      await admin.from('ai_invocations').delete().eq('user_id', u)
      await admin.from('notifications').delete().eq('user_id', u)
      await admin.from('users').delete().eq('id', u)
      await admin.auth.admin.deleteUser(u)
    }
    process.exit(fail === 0 ? 0 : 1)
  }
}
main()
