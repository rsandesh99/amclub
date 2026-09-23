/**
 * AMC Mart storefront v2 — acceptance (PRD Experience v3 E16, N39–N44) over
 * the REAL HTTP API against a server running with MART_ENABLED=true. Requires
 * the staged migrations 0022–0025 and 0069 on the target database.
 *
 *  N39  dual mode: the Services | Goods switch on /services and /mart/search;
 *       "Make to order" beside strong goods results; the prefilled goods RFQ
 *       card on a weak result.
 *  N40  typed attributes: the category's definitions via the categories API;
 *       the seller routes refuse unknown / wrong-type / off-list / missing-
 *       required values (422 invalid_attributes) and store normalised values;
 *       `a.<key>` facet filters narrow the public list (facetable keys only);
 *       the category page renders the facets, the product page the attributes.
 *  N41  seller promises: stored from the seller routes (unknown → 422); badges on
 *       the product page; the hourly Mart cron records a "ships in 48 h" breach
 *       on an order with no dispatch photo after 48 h (once — a re-run adds
 *       nothing); at the breach limit the badge disappears for buyers while the
 *       other promise stays; no money moves.
 *  N43  a non-returnable, ITC-ineligible category: "Not returnable" and "ITC may
 *       not be available" on the product page; the cart preview claims no ITC
 *       for the line (after-ITC = total) and flags it; a quality return → 409
 *       not_returnable while a damaged claim opens.
 *  N42  samples + customise: the product page offers both; a sample is one
 *       unit at the sample price with the MOQ waived (preview + a real
 *       ordinary goods order flagged `sample`); qty 2 → 422, no sample price →
 *       409; Customise links the goods RFQ prefilled from the listing.
 *  N44  reorder library: past completed lines with today's price beside the
 *       old one (price change flagged); the reminder uses the usual interval,
 *       refuses a never-bought listing (404), and the hourly cron sends a due
 *       reminder once and moves it on.
 *
 * Run: BASE_URL=http://localhost:3000 pnpm --filter @amclub/web exec tsx scripts/verify-mart-storefront.ts
 * Creates only kill-test rows; removes everything in `finally` (zero residue).
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

const tag = `mstore_${Date.now()}`
let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, extra = '') => { console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' ' + extra : ''}`); cond ? pass++ : fail++ }

const created = { users: [] as string[], providerIds: [] as string[], msmeIds: [] as string[], productIds: [] as string[], orderIds: [] as string[], categories: [] as string[] }
let breachLimitBefore: { value: unknown } | null | undefined

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
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
const json = async (r: Response) => ({ status: r.status, body: await r.json().catch(() => ({})) })
const html = async (p: string) => (await fetch(`${BASE}${p}`)).text()

async function main() {
  console.log(`\nAMC Mart storefront v2 (E16) acceptance → ${BASE}\n`)
  try {
    // ── Cast: one goods-activated seller, an admin, one kill-test category with typed attributes.
    const seller = await mkUser('seller', ['provider'])
    const ops = await mkUser('admin', ['msme', 'admin'])
    const buyer = await mkUser('buyer', ['msme'])
    const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'KT Buyer', state: 'AP' }).select('id').single()
    created.msmeIds.push(msme!.id)
    const gstin = `37AAACK${String(Date.now()).slice(-4)}A1Z5`
    const { data: prov, error: pErr } = await admin.from('provider_profiles').insert({
      user_id: seller.uid, legal_name: 'KT Seller', display_name: 'KT Seller', slug: `${tag}-seller`.replace(/_/g, '-'), state: 'AP', city: 'Kurnool', status: 'active', languages: ['en'], gstin,
    }).select('id').single()
    if (pErr) throw new Error(pErr.message)
    created.providerIds.push(prov!.id)
    await admin.from('gstin_verifications').insert({ user_id: seller.uid, gstin, verified: true, stub: false, provider: 'admin_attest', result: { reason: 'killtest' } })
    if ((await api(seller.token, '/api/v1/mart/seller/activate', {})).status !== 200) throw new Error('activation failed')

    const cat = `${tag}-cat`.replace(/_/g, '-')
    await admin.from('mart_categories').insert({ slug: cat, name_i18n: { en: cat, hi: cat, te: cat }, return_window_hours: 48, commission_bps: 500, bis_blocked: false, is_active: true, sort_order: 999 })
    created.categories.push(cat)
    const { error: aErr } = await admin.from('mart_category_attributes').insert([
      { category_slug: cat, key: 'material', label_i18n: { en: 'Material', hi: 'सामग्री' }, type: 'enum', options: ['MS', 'SS 304'], facetable: true, required: true, sort: 1 },
      { category_slug: cat, key: 'diameter_mm', label_i18n: { en: 'Diameter' }, type: 'number', unit: 'mm', facetable: false, required: false, sort: 2 },
      { category_slug: cat, key: 'zinc_plated', label_i18n: { en: 'Zinc plated' }, type: 'bool', facetable: true, required: false, sort: 3 },
    ])
    if (aErr) throw new Error(`attributes: ${aErr.message}`)

    // ── N40 typed attributes ────────────────────────────────────────────────
    console.log('N40. Typed attributes + facets:')
    const defs = await json(await api(null, `/api/v1/mart/categories?attributes=${cat}`))
    ok('categories API returns the category definitions in order', defs.status === 200 && JSON.stringify((defs.body.attributes ?? []).map((d: { key: string }) => d.key)) === '["material","diameter_mm","zinc_plated"]')
    const body = (name: string, attributes: Record<string, unknown>) => ({
      category_slug: cat, name, hsn_code: '7318', gst_rate_bps: 1800, unit: 'pcs', images: [], min_order_qty: 1, country_of_origin: 'IN',
      tiers: [{ min_qty: 1, unit_price_paise: 450 }], attributes,
    })
    const offList = await json(await api(seller.token, '/api/v1/mart/seller/products', body(`${tag} gold bolt`, { material: 'Gold' })))
    ok('off-list enum → 422 invalid_attributes (option)', offList.status === 422 && offList.body.error === 'invalid_attributes' && offList.body.problems?.[0]?.code === 'option')
    const missing = await json(await api(seller.token, '/api/v1/mart/seller/products', body(`${tag} bare bolt`, { diameter_mm: 8 })))
    ok('missing required → 422 (required)', missing.status === 422 && missing.body.problems?.some((p: { key: string; code: string }) => p.key === 'material' && p.code === 'required'))
    const unknown = await json(await api(seller.token, '/api/v1/mart/seller/products', body(`${tag} red bolt`, { material: 'MS', colour: 'red' })))
    ok('unknown key → 422 (unknown)', unknown.status === 422 && unknown.body.problems?.some((p: { key: string; code: string }) => p.key === 'colour' && p.code === 'unknown'))
    const wrongType = await json(await api(seller.token, '/api/v1/mart/seller/products', body(`${tag} odd bolt`, { material: 'MS', zinc_plated: 'yes' })))
    ok('wrong type → 422 (type)', wrongType.status === 422 && wrongType.body.problems?.some((p: { key: string; code: string }) => p.key === 'zinc_plated' && p.code === 'type'))

    const c1 = await json(await api(seller.token, '/api/v1/mart/seller/products', body(`${tag} MS bolt`, { material: 'MS', diameter_mm: '12', zinc_plated: true })))
    const c2 = await json(await api(seller.token, '/api/v1/mart/seller/products', body(`${tag} SS bolt`, { material: 'SS 304', zinc_plated: false })))
    ok('valid attributes → 201 (twice)', c1.status === 201 && c2.status === 201, `${c1.status}/${c2.status}`)
    const p1 = c1.body.id as string
    const p2 = c2.body.id as string
    created.productIds.push(p1, p2)
    const { data: row } = await admin.from('products').select('attributes').eq('id', p1).single()
    ok('stored normalised (number coerced)', JSON.stringify(row?.attributes) === JSON.stringify({ material: 'MS', diameter_mm: 12, zinc_plated: true }), JSON.stringify(row?.attributes))
    const patchBad = await json(await api(seller.token, `/api/v1/mart/seller/products/${p2}`, body(`${tag} SS bolt`, { material: 'Brass' }), 'PATCH'))
    ok('PATCH validates too → 422', patchBad.status === 422 && patchBad.body.error === 'invalid_attributes')

    for (const id of [p1, p2]) {
      await api(seller.token, `/api/v1/mart/seller/products/${id}`, { action: 'submit' })
      await api(ops.token, `/api/v1/mart/admin/products/${id}`, { action: 'approve' })
    }
    const ids = async (qs: string) => ((await json(await api(null, `/api/v1/mart/products?category=${cat}${qs}`))).body.products ?? []).map((p: { id: string }) => p.id).sort()
    ok('no facet → both listings', JSON.stringify(await ids('')) === JSON.stringify([p1, p2].sort()))
    ok('a.material=MS → only the MS listing', JSON.stringify(await ids('&a.material=MS')) === JSON.stringify([p1]))
    ok('a.zinc_plated=false → only the unplated listing', JSON.stringify(await ids('&a.zinc_plated=false')) === JSON.stringify([p2]))
    ok('off-list value / non-facetable key ignored', (await ids('&a.material=Gold&a.diameter_mm=12')).length === 2)
    const catHtml = await html(`/mart/c/${cat}`)
    ok('category page renders the facets', catHtml.includes('data-testid="attribute-facets"') && catHtml.includes('a.material=MS'))
    const pHtml = await html(`/mart/p/${p1}`)
    ok('product page renders the typed attributes', pHtml.includes('data-attribute="material"') && pHtml.includes('12 mm'))

    // ── N39 dual mode ───────────────────────────────────────────────────────
    console.log('N39. Dual mode + make to order:')
    ok('/services shows the Services | Goods switch', (await html('/services?query=gst')).includes('data-testid="mode-switch"'))
    const weak = await html(`/mart/search?query=${encodeURIComponent(tag)}`)
    ok('/mart/search shows the switch', weak.includes('data-testid="mode-switch"'))
    ok('a weak goods result (< 3) offers the prefilled goods RFQ', weak.includes('data-testid="weak-goods-rfq"') && weak.includes(`item=${encodeURIComponent(tag)}`))
    const none = await html(`/mart/search?query=${encodeURIComponent(`${tag}-nothing-here`)}`)
    ok('zero goods results still offer the goods RFQ', none.includes('/app/mart/rfq/new?item='))

    // ── N41 seller promises ────────────────────────────────────────────────
    console.log('N41. Seller promises + measured breaches:')
    const delivery = { contact_name: 'Ravi', contact_phone: '9876543210', address: 'Plot 4, Industrial Estate', city: 'Kurnool', state: 'AP', pincode: '518001', pickup: false }
    const badPromise = await json(await api(seller.token, '/api/v1/mart/seller/products', { ...body(`${tag} bad promise`, { material: 'MS' }), promises: ['free_lunch'] }))
    ok('unknown promise → 422', badPromise.status === 422)
    const cp = await json(await api(seller.token, '/api/v1/mart/seller/products', { ...body(`${tag} promised bolt`, { material: 'MS' }), promises: ['ships_48h', 'gst_invoice_24h'] }))
    const pp = cp.body.id as string
    created.productIds.push(pp)
    await api(seller.token, `/api/v1/mart/seller/products/${pp}`, { action: 'submit' })
    await api(ops.token, `/api/v1/mart/admin/products/${pp}`, { action: 'approve' })
    const { data: prow } = await admin.from('products').select('promises').eq('id', pp).single()
    ok('promises stored as opted in', JSON.stringify(prow?.promises) === JSON.stringify(['ships_48h', 'gst_invoice_24h']))
    const ppHtml = await html(`/mart/p/${pp}`)
    ok('product page shows both badges', ppHtml.includes('data-promise="ships_48h"') && ppHtml.includes('data-promise="gst_invoice_24h"'))

    const buy = async (productId: string, qty = 1) => {
      const co = await json(await api(buyer.token, '/api/v1/mart/checkout', { items: [{ product_id: productId, qty }], delivery, idempotencyKey: randomUUID() }))
      if (co.status !== 200) throw new Error(`checkout ${co.status} ${JSON.stringify(co.body)}`)
      const sim = await json(await api(buyer.token, '/api/v1/checkout/simulate', { checkoutSessionId: co.body.checkoutSessionId }))
      if (!sim.body.orderId) throw new Error(`simulate ${sim.status} ${JSON.stringify(sim.body)}`)
      created.orderIds.push(sim.body.orderId)
      return { orderId: sim.body.orderId as string, checkout: co.body }
    }
    const { orderId: late } = await buy(pp)
    const { data: before } = await admin.from('orders').select('total_paise, provider_earning_paise, status').eq('id', late).single()
    // The seller never dispatches: move the order's clock back past the 48 h promise.
    await admin.from('orders').update({ created_at: new Date(Date.now() - 49 * 3_600_000).toISOString() }).eq('id', late)
    const cron = () => fetch(`${BASE}/api/v1/cron/pool-close`, { headers: process.env['CRON_SECRET'] ? { Authorization: `Bearer ${process.env['CRON_SECRET']}` } : {} })
    ok('hourly Mart cron runs', (await cron()).status === 200)
    const { data: breaches } = await admin.from('mart_promise_breaches').select('promise, detail').eq('order_id', late)
    ok('one ships_48h breach recorded (missing dispatch)', breaches?.length === 1 && breaches[0]!.promise === 'ships_48h' && (breaches[0]!.detail as { reason?: string }).reason === 'missing', JSON.stringify(breaches))
    await cron()
    ok('a re-run records nothing new', ((await admin.from('mart_promise_breaches').select('id').eq('order_id', late)).data ?? []).length === 1)
    const { data: after } = await admin.from('orders').select('total_paise, provider_earning_paise, status').eq('id', late).single()
    ok('no money or status moved', JSON.stringify(before) === JSON.stringify(after))
    breachLimitBefore = (await admin.from('mart_settings').select('value').eq('key', 'promise_breach_limit').maybeSingle()).data
    await admin.from('mart_settings').upsert({ key: 'promise_breach_limit', value: { count: 1, window_days: 90 } })
    const limited = await json(await api(null, `/api/v1/mart/products/${pp}`))
    const shownPromises = (limited.body.product?.promises ?? limited.body.promises ?? []) as string[]
    ok('at the limit the breached badge is gone for buyers, the other stays', JSON.stringify(shownPromises) === '["gst_invoice_24h"]', JSON.stringify(shownPromises))

    // ── N43 non-returnable + ITC-ineligible ─────────────────────────────────
    console.log('N43. Non-returnable + ITC-ineligible category:')
    const cat2 = `${tag}-nr`.replace(/_/g, '-')
    await admin.from('mart_categories').insert({ slug: cat2, name_i18n: { en: cat2, hi: cat2, te: cat2 }, return_window_hours: 48, commission_bps: 500, bis_blocked: false, is_active: true, sort_order: 999, returnable: false, itc_eligible: false })
    created.categories.push(cat2)
    const cn = await json(await api(seller.token, '/api/v1/mart/seller/products', { ...body(`${tag} solvent`, {}), category_slug: cat2 }))
    const pn = cn.body.id as string
    created.productIds.push(pn)
    await api(seller.token, `/api/v1/mart/seller/products/${pn}`, { action: 'submit' })
    await api(ops.token, `/api/v1/mart/admin/products/${pn}`, { action: 'approve' })
    const pnHtml = await html(`/mart/p/${pn}`)
    ok('product page: "Not returnable" and "ITC may not be available"', pnHtml.includes('data-testid="not-returnable"') && pnHtml.includes('data-testid="itc-ineligible"'))
    const pv = await json(await api(buyer.token, '/api/v1/mart/cart/preview', { items: [{ product_id: pn, qty: 2 }] }))
    ok('cart preview: no ITC on the line, after-ITC = total, line flagged', pv.status === 200 && pv.body.amounts.itcPaise === 0 && pv.body.amounts.afterItcPaise === pv.body.amounts.totalPaise && pv.body.nonReturnableProductIds?.includes(pn) && pv.body.itcIneligibleProductIds?.includes(pn))
    const pvOk = await json(await api(buyer.token, '/api/v1/mart/cart/preview', { items: [{ product_id: p1, qty: 2 }] }))
    ok('eligible line: after-ITC = taxable (unchanged rule)', pvOk.body.amounts?.afterItcPaise === pvOk.body.amounts?.taxablePaise && pvOk.body.amounts?.itcPaise === pvOk.body.amounts?.gstPaise)
    const { orderId: nr } = await buy(pn, 2)
    await admin.from('orders').update({ status: 'delivered' }).eq('id', nr)
    const quality = await json(await api(buyer.token, `/api/v1/mart/orders/${nr}/transition`, { action: 'open_return', return: { reason: 'quality' } }))
    ok('quality return on a non-returnable order → 409 not_returnable', quality.status === 409 && quality.body.error === 'not_returnable', JSON.stringify(quality.body))
    const damaged = await json(await api(buyer.token, `/api/v1/mart/orders/${nr}/transition`, { action: 'open_return', return: { reason: 'damaged' } }))
    ok('damaged claim still opens → disputed', damaged.status === 200, JSON.stringify(damaged.body))

    // ── N42 samples + customise ────────────────────────────────────────────
    console.log('N42. Samples + customise:')
    const cs = await json(await api(seller.token, '/api/v1/mart/seller/products', { ...body(`${tag} sample bolt`, { material: 'MS' }), min_order_qty: 10, sample_price_paise: 900 }))
    const ps = cs.body.id as string
    created.productIds.push(ps)
    await api(seller.token, `/api/v1/mart/seller/products/${ps}`, { action: 'submit' })
    await api(ops.token, `/api/v1/mart/admin/products/${ps}`, { action: 'approve' })
    const psHtml = await html(`/mart/p/${ps}`)
    ok('product page offers "Request a sample" and "Customise"', psHtml.includes('data-testid="request-sample"') && psHtml.includes(`/app/mart/rfq/new?product_id=${ps}&amp;customise=1`))
    const sp = await json(await api(buyer.token, '/api/v1/mart/cart/preview', { items: [{ product_id: ps, qty: 1 }], sample: true }))
    ok('sample preview: one unit at the sample price, MOQ waived', sp.status === 200 && sp.body.lineItems?.[0]?.tier_unit_price_paise === 900 && sp.body.lineItems?.[0]?.qty === 1 && sp.body.lineItems?.[0]?.sample === true, JSON.stringify(sp.body.lineItems ?? sp.body))
    ok('without sample: qty 1 is below the MOQ → 422', (await api(buyer.token, '/api/v1/mart/cart/preview', { items: [{ product_id: ps, qty: 1 }] })).status === 422)
    ok('sample of 2 → 422 sample_one_unit', (await json(await api(buyer.token, '/api/v1/mart/cart/preview', { items: [{ product_id: ps, qty: 2 }], sample: true }))).body.error?.code === 'sample_one_unit')
    ok('no sample price → 409 no_sample', (await json(await api(buyer.token, '/api/v1/mart/cart/preview', { items: [{ product_id: p1, qty: 1 }], sample: true }))).status === 409)
    const sco = await json(await api(buyer.token, '/api/v1/mart/checkout', { items: [{ product_id: ps, qty: 1 }], delivery, idempotencyKey: randomUUID(), sample: true }))
    const ssim = await json(await api(buyer.token, '/api/v1/checkout/simulate', { checkoutSessionId: sco.body.checkoutSessionId }))
    if (ssim.body.orderId) created.orderIds.push(ssim.body.orderId)
    const { data: so } = await admin.from('orders').select('kind, total_paise, line_items, title').eq('id', ssim.body.orderId ?? '00000000-0000-0000-0000-000000000000').maybeSingle()
    ok('sample = an ordinary goods order of one unit at the sample price', so?.kind === 'goods' && Number(so.total_paise) === sp.body.amounts?.totalPaise && (so.line_items as { sample?: boolean; qty: number }[])?.[0]?.sample === true && (so.line_items as { qty: number }[])[0]!.qty === 1, JSON.stringify(so))

    // ── N44 reorder library ────────────────────────────────────────────────
    console.log('N44. Reorder library + reminder:')
    const { orderId: r1 } = await buy(p1, 10)
    const { orderId: r2 } = await buy(p1, 20)
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()
    await admin.from('orders').update({ status: 'completed', created_at: daysAgo(30) }).eq('id', r1)
    await admin.from('orders').update({ status: 'completed', created_at: daysAgo(16) }).eq('id', r2)
    await admin.from('price_tiers').update({ unit_price_paise: 500 }).eq('product_id', p1).eq('min_qty', 1)
    const lib = await json(await api(buyer.token, '/api/v1/mart/reorder'))
    const item = (lib.body.items ?? []).find((i: { productId: string }) => i.productId === p1)
    ok('the bought listing is in the library with the last quantity', item?.lastQty === 20 && item?.orders === 2, JSON.stringify(item))
    ok('then ₹4.50 vs today ₹5.00, flagged as changed', item?.then?.unit_price_paise === 450 && item?.today?.unit_price_paise === 500 && item?.priceChanged === true)
    ok('samples are not in the library', !(lib.body.items ?? []).some((i: { productId: string }) => i.productId === ps))
    ok('reminder for a never-bought listing → 404', (await api(buyer.token, '/api/v1/mart/reorder/reminders', { productId: pp, on: true })).status === 404)
    const rem = await json(await api(buyer.token, '/api/v1/mart/reorder/reminders', { productId: p1, on: true }))
    const tomorrow = Date.now() + 86_400_000
    ok('reminder on at the usual 14-day interval; overdue → tomorrow', rem.status === 200 && rem.body.reminder?.intervalDays === 14 && Math.abs(Date.parse(rem.body.reminder.nextAt) - tomorrow) < 3_600_000, JSON.stringify(rem.body))
    await admin.from('mart_reorder_reminders').update({ next_at: daysAgo(1) }).eq('user_id', buyer.uid).eq('product_id', p1)
    await cron()
    const notes = async () => ((await admin.from('notifications').select('id').eq('user_id', buyer.uid).eq('kind', 'mart_reorder_reminder')).data ?? []).length
    ok('a due reminder is sent', (await notes()) === 1)
    const { data: moved } = await admin.from('mart_reorder_reminders').select('next_at').eq('user_id', buyer.uid).eq('product_id', p1).single()
    ok('and moved on by its interval', Math.abs(Date.parse(moved!.next_at) - (Date.now() + 14 * 86_400_000)) < 3_600_000)
    await cron()
    ok('a second run sends nothing', (await notes()) === 1)
    const off = await json(await api(buyer.token, '/api/v1/mart/reorder/reminders', { productId: p1, on: false }))
    ok('reminder off', off.status === 200 && off.body.reminder?.active === false)

    console.log(`\n${fail === 0 ? '✅' : '❌'} verify-mart-storefront: ${pass} passed, ${fail} failed\n`)
  } catch (e) {
    fail++
    console.error('\n✗ suite aborted:', e instanceof Error ? e.message : e)
  } finally {
    if (breachLimitBefore !== undefined) {
      if (breachLimitBefore) await admin.from('mart_settings').upsert({ key: 'promise_breach_limit', value: breachLimitBefore.value })
      else await admin.from('mart_settings').delete().eq('key', 'promise_breach_limit')
    }
    for (const id of created.orderIds) {
      const { data: pays } = await admin.from('payments').select('id').eq('order_id', id)
      for (const p of pays ?? []) await admin.from('refunds').delete().eq('payment_id', p.id)
      for (const t of ['mart_promise_breaches', 'invoices', 'payouts', 'disputes', 'payments', 'order_documents', 'order_events']) await admin.from(t).delete().eq('order_id', id)
      await admin.from('checkout_sessions').delete().eq('order_id', id)
      await admin.from('orders').delete().eq('id', id)
    }
    for (const m of created.msmeIds) await admin.from('checkout_sessions').delete().eq('msme_id', m)
    for (const p of created.productIds) {
      await admin.from('product_events').delete().eq('product_id', p)
      await admin.from('price_tiers').delete().eq('product_id', p)
      await admin.from('products').delete().eq('id', p)
    }
    for (const c of created.categories) await admin.from('mart_categories').delete().eq('slug', c)
    for (const u of created.users) await admin.from('gstin_verifications').delete().eq('user_id', u)
    for (const p of created.providerIds) await admin.from('provider_profiles').delete().eq('id', p)
    for (const m of created.msmeIds) await admin.from('msme_profiles').delete().eq('id', m)
    for (const u of created.users) await admin.from('mart_reorder_reminders').delete().eq('user_id', u)
    for (const u of created.users) {
      await admin.from('audit_logs').delete().eq('actor_id', u)
      await admin.from('notifications').delete().eq('user_id', u)
      await admin.from('users').delete().eq('id', u)
      await admin.auth.admin.deleteUser(u)
    }
    process.exit(fail === 0 ? 0 : 1)
  }
}
main()
