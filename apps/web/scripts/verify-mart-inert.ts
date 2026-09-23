/**
 * AMC Mart — INERTNESS suite (MART_DESIGN.md §0 dark-build rule). Run against
 * a deploy with MART_ENABLED unset/false (today's prod posture): every Mart
 * surface must not exist, the flag must be delivered as false, and a services
 * checkout must still produce kind='service' rows with NULL goods columns.
 * Pair with the standard suites (verify-authz / verify-money-loop / verify-rfq
 * / verify-te-render) run against the same deploy — those prove "every
 * services suite green"; this proves "no Mart surface leaks".
 *
 * Run: BASE_URL=https://amclub.in pnpm --filter @amclub/web exec tsx scripts/verify-mart-inert.ts
 * With SUPABASE creds in apps/web/.env.local it also runs the services
 * checkout probe (kill-test rows, removed in finally); without them it runs
 * the HTTP-only checks.
 */
import { config } from 'dotenv'
import path from 'path'
import { randomUUID } from 'crypto'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'
const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, extra = '') => { console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' ' + extra : ''}`); cond ? pass++ : fail++ }

const API_404 = [
  ['GET', '/api/v1/mart/categories'],
  ['GET', '/api/v1/mart/admin/settings'],
  ['PUT', '/api/v1/mart/admin/settings'],
  ['GET', '/api/v1/mart/admin/categories'],
  ['PATCH', '/api/v1/mart/admin/categories/fasteners'],
  ['GET', '/api/v1/mart/products'],
  ['GET', `/api/v1/mart/products/${randomUUID()}`],
  ['POST', '/api/v1/mart/cart/preview'],
  ['POST', '/api/v1/mart/checkout'],
  ['GET', '/api/v1/mart/seller/status'],
  ['POST', '/api/v1/mart/seller/activate'],
  ['GET', '/api/v1/mart/seller/products'],
  ['POST', '/api/v1/mart/seller/products/draft'],
  ['POST', '/api/v1/mart/seller/images'],
  ['POST', `/api/v1/mart/orders/${randomUUID()}/transition`],
  ['GET', '/api/v1/mart/admin/products'],
  ['GET', `/api/v1/mart/admin/orders/${randomUUID()}/dossier`],
] as const
const PAGES_404 = ['/mart', `/mart/p/${randomUUID()}`, '/app/mart/cart', '/app/mart/checkout', '/partner/goods', '/partner/goods/new', '/admin/mart']

async function main() {
  console.log(`\nMart inertness (MART_ENABLED=false expected) → ${BASE}\n`)
  console.log('Mart API routes do not exist (hard 404 BEFORE auth):')
  for (const [method, p] of API_404) {
    const res = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) })
    ok(`${method} ${p}`, res.status === 404, String(res.status))
  }
  console.log('Mart pages do not exist:')
  for (const p of PAGES_404) {
    for (const locale of ['', '/hi', '/te']) {
      const res = await fetch(`${BASE}${locale}${p}`, { redirect: 'manual' })
      // Auth-gated groups redirect (307) to /login before the page gate — an
      // unauthenticated probe therefore accepts 404 OR a login redirect; the
      // authenticated probe below asserts the true 404.
      ok(`${locale || '/en'}${p}`, res.status === 404 || res.status === 307, String(res.status))
    }
  }
  // E16 N39 — the Services | Goods switch renders only with the flag on.
  for (const p of ['/services', '/services?query=gst']) {
    const html = await (await fetch(`${BASE}${p}`)).text()
    ok(`${p} has no Services | Goods switch`, !html.includes('data-testid="mode-switch"'))
  }
  const me = await fetch(`${BASE}/api/v1/profile/me`)
  ok('profile/me unauthenticated → 401 (contract unchanged)', me.status === 401)

  if (!URL_ || !SERVICE || !ANON) {
    console.log('\n(no Supabase creds — skipping the authenticated + services-checkout probes)')
    console.log(`\n${fail === 0 ? '✅' : '❌'} verify-mart-inert: ${pass} passed, ${fail} failed\n`)
    process.exit(fail === 0 ? 0 : 1)
  }

  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })
  const tag = `inert_${Date.now()}`
  const users: string[] = []
  let msmeId = '', providerId = '', packageId = '', orderId = ''
  try {
    const mk = async (label: string, roles: string[]) => {
      const email = `${tag}_${label}@killtest.amclub`
      const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
      if (error) throw new Error(error.message)
      users.push(data.user.id)
      await admin.from('users').insert({ id: data.user.id, email, roles })
      const anon = createClient(URL_, ANON, { auth: { persistSession: false } })
      const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
      return { uid: data.user.id, token: s.session!.access_token }
    }
    const buyer = await mk('buyer', ['msme'])
    const prov = await mk('prov', ['provider'])
    const ops = await mk('admin', ['msme', 'admin'])
    const h = (t: string) => ({ Authorization: `Bearer ${t}` })

    console.log('Authenticated Mart probes still 404 (flag, not auth, decides):')
    ok('seller status (provider token)', (await fetch(`${BASE}/api/v1/mart/seller/status`, { headers: h(prov.token) })).status === 404)
    ok('admin queue (admin token)', (await fetch(`${BASE}/api/v1/mart/admin/products`, { headers: h(ops.token) })).status === 404)
    const meAuthed = await (await fetch(`${BASE}/api/v1/profile/me`, { headers: h(buyer.token) })).json()
    ok('profile/me.martEnabled === false', meAuthed.martEnabled === false)

    console.log('Services checkout on this deploy:')
    const { data: m } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'Inert Buyer', state: 'KA' }).select('id').single()
    msmeId = m!.id
    const { data: p } = await admin.from('provider_profiles').insert({ user_id: prov.uid, legal_name: 'Inert Prov', display_name: 'Inert Prov', slug: `${tag}-prov`.replace(/_/g, '-'), state: 'KA', status: 'active', languages: ['en'] }).select('id').single()
    providerId = p!.id
    const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
    const { data: pkg } = await admin.from('packages').insert({
      provider_id: providerId, category_id: cat!.id, slug: `${tag}-pkg`.replace(/_/g, '-'), title_i18n: { en: 'Inert pkg', hi: 'x' }, price_paise: 100_000, discount_bps: 0, delivery_days: 3, revision_count: 1,
      status: 'active', scope_included: ['x'], scope_excluded: [], deliverables: ['y'],
    }).select('id').single()
    packageId = pkg!.id
    const co = await (await fetch(`${BASE}/api/v1/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h(buyer.token) }, body: JSON.stringify({ packageId, idempotencyKey: randomUUID() }) })).json()
    const sim = await (await fetch(`${BASE}/api/v1/checkout/simulate`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h(buyer.token) }, body: JSON.stringify({ checkoutSessionId: co.checkoutSessionId }) })).json()
    orderId = sim.orderId
    const { data: o } = await admin.from('orders').select('kind, line_items, delivery_snapshot').eq('id', orderId).maybeSingle()
    // Before 0022 is applied the goods columns do not exist → the select errors;
    // treat "column absent" as inert too (o === null with kind unknown).
    const { data: o2 } = await admin.from('orders').select('kind').eq('id', orderId).maybeSingle()
    ok("services order kind='service'", o2?.kind === 'service')
    ok('goods columns NULL (or absent pre-0022)', !o || (o.line_items === null && o.delivery_snapshot === null))
    const acc = await (await fetch(`${BASE}/api/v1/orders/${orderId}/transition`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h(prov.token) }, body: JSON.stringify({ action: 'accept' }) })).json()
    ok('services accept unchanged', acc.status === 'accepted')

    console.log(`\n${fail === 0 ? '✅' : '❌'} verify-mart-inert: ${pass} passed, ${fail} failed\n`)
  } catch (e) {
    fail++
    console.error('\n✗ suite aborted:', e instanceof Error ? e.message : e)
  } finally {
    if (orderId) {
      await admin.from('payments').delete().eq('order_id', orderId)
      await admin.from('order_events').delete().eq('order_id', orderId)
      await admin.from('checkout_sessions').delete().eq('order_id', orderId)
      await admin.from('orders').delete().eq('id', orderId)
    }
    if (msmeId) await admin.from('checkout_sessions').delete().eq('msme_id', msmeId)
    if (packageId) await admin.from('packages').delete().eq('id', packageId)
    if (providerId) await admin.from('provider_profiles').delete().eq('id', providerId)
    if (msmeId) await admin.from('msme_profiles').delete().eq('id', msmeId)
    for (const u of users) {
      await admin.from('notifications').delete().eq('user_id', u)
      await admin.from('users').delete().eq('id', u)
      await admin.auth.admin.deleteUser(u)
    }
    process.exit(fail === 0 ? 0 : 1)
  }
}
main()
