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
 *
 * Run: BASE_URL=http://localhost:3000 pnpm --filter @amclub/web exec tsx scripts/verify-mart-storefront.ts
 * Creates only kill-test rows; removes everything in `finally` (zero residue).
 */
import { config } from 'dotenv'
import path from 'path'
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

const created = { users: [] as string[], providerIds: [] as string[], productIds: [] as string[], categories: [] as string[] }

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

    console.log(`\n${fail === 0 ? '✅' : '❌'} verify-mart-storefront: ${pass} passed, ${fail} failed\n`)
  } catch (e) {
    fail++
    console.error('\n✗ suite aborted:', e instanceof Error ? e.message : e)
  } finally {
    for (const p of created.productIds) {
      await admin.from('product_events').delete().eq('product_id', p)
      await admin.from('price_tiers').delete().eq('product_id', p)
      await admin.from('products').delete().eq('id', p)
    }
    for (const c of created.categories) await admin.from('mart_categories').delete().eq('slug', c)
    for (const u of created.users) await admin.from('gstin_verifications').delete().eq('user_id', u)
    for (const p of created.providerIds) await admin.from('provider_profiles').delete().eq('id', p)
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
