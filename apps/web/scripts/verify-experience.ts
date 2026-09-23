/**
 * Experience v3 (docs/prd/PRD_EXPERIENCE_V3.md) acceptance rig. One section per
 * epic; each epic's PR adds its criteria here (the verify-rfq convention).
 * Runs in CI against the disposable Supabase stack (money-rigs.yml) and drives
 * the real middleware, pages and routes over HTTP.
 *
 * Run: BASE_URL=http://localhost:3000 tsx scripts/verify-experience.ts
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { summarizeProviderOrders } from '@amclub/shared'

const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++ }
const tag = `expv_${Date.now()}`
const created: { users: string[]; providerIds: string[]; msmeIds: string[]; orderIds: string[]; packageIds: string[]; rfqIds: string[] } = { users: [], providerIds: [], msmeIds: [], orderIds: [], packageIds: [], rfqIds: [] }

async function mkUser(label: string, roles: string[] = ['msme']): Promise<{ uid: string; token: string; cookie: string }> {
  const email = `${tag}_${label}@killtest.amclub`
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error(`${label}: ${error.message}`)
  created.users.push(data.user.id)
  await admin.from('users').insert({ id: data.user.id, email, roles })
  const anon = createClient(URL_, ANON, { auth: { persistSession: false } })
  const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
  // The web session cookie, minted exactly as the app reads it.
  const jar: Record<string, string> = {}
  const ssr = createServerClient(URL_, ANON, {
    cookies: {
      getAll() { return Object.entries(jar).map(([name, value]) => ({ name, value })) },
      setAll(list) { for (const { name, value } of list) jar[name] = value },
    },
  })
  await ssr.auth.signInWithPassword({ email, password: 'Test1234!' })
  return { uid: data.user.id, token: s.session!.access_token, cookie: Object.entries(jar).map(([n, v]) => `${n}=${v}`).join('; ') }
}

/** Visible markup only: drops <script> bodies (the i18n messages ride in the RSC payload). */
const visible = (html: string) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')

const api = (token: string, p: string, body?: unknown, method = 'POST') =>
  fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

async function e0() {
  console.log('E0 — fix first')
  const fakePkg = '00000000-0000-4000-8000-000000000001'

  // U1: the auth wall keeps the whole intent, query included.
  const wall = await fetch(`${BASE}/app/checkout/${fakePkg}?tier=standard`, { redirect: 'manual' })
  const loc = wall.headers.get('location') ?? ''
  const nextParam = loc ? new URL(loc, BASE).searchParams.get('next') : null
  check('U1: logged-out checkout → /login?next= keeps path + query', [302, 303, 307].includes(wall.status) && nextParam === `/app/checkout/${fakePkg}?tier=standard`, `status ${wall.status}, next=${nextParam}`)

  // U1: the signup wizard receives the intent and carries it on (login link).
  const newbie = await mkUser('newbie')
  const signup = await fetch(`${BASE}/signup?complete=1&next=${encodeURIComponent(`/app/checkout/${fakePkg}`)}`, { headers: { cookie: newbie.cookie }, redirect: 'manual' })
  const html = await signup.text()
  // The page's own "Sign in" link carries the sanitized intent (the wizard gets the same value).
  const carried = `href="/login?next=${encodeURIComponent(`/app/checkout/${fakePkg}`)}"`
  check('U1: /signup?complete=1&next=… renders and carries next', signup.status === 200 && html.includes(carried), `status ${signup.status}`)
  const evil = await fetch(`${BASE}/signup?complete=1&next=${encodeURIComponent('https://evil.example')}`, { headers: { cookie: newbie.cookie }, redirect: 'manual' })
  check('U1: an external next is dropped (no open redirect)', evil.status === 200 && (await evil.text()).includes('href="/login"'))

  // U12: the gateway size band is stored with the profile.
  await api(newbie.token, '/api/v1/legal/accept', { docs: ['terms', 'privacy'], surface: 'web', locale: 'en' })
  const prof = await api(newbie.token, '/api/v1/profile/msme', { fullName: 'E0 Buyer', businessName: 'E0 Buyer Co', employeeBand: '10-49' })
  const { data: msme } = await admin.from('msme_profiles').select('id, employee_band').eq('user_id', newbie.uid).maybeSingle()
  if (msme) created.msmeIds.push(msme.id)
  check('U12: employeeBand is saved to msme_profiles.employee_band', prof.status === 200 && msme?.employee_band === '10-49', `status ${prof.status}, band=${msme?.employee_band}`)
  const bad = await api(newbie.token, '/api/v1/profile/msme', { fullName: 'E0 Buyer', businessName: 'E0 Buyer Co', employeeBand: 'lots' })
  check('U12: an unknown band is rejected (Zod)', bad.status === 422)

  // U8: /partner/stats is server-computed, own-provider only.
  const prov = await mkUser('prov', ['provider'])
  const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
  const { data: pp } = await admin.from('provider_profiles').insert({
    user_id: prov.uid, legal_name: 'E0 Prov', display_name: 'E0 Prov', slug: `${tag}-prov`, state: 'TS', status: 'active', languages: ['en'],
  }).select('id').single()
  created.providerIds.push(pp!.id)
  await admin.from('provider_categories').insert({ provider_id: pp!.id, category_id: cat!.id })
  const rows = [
    { status: 'in_progress', earn: 1000_00 },
    { status: 'completed', earn: 2500_00 },
    { status: 'reviewed', earn: 4000_00 },
    { status: 'refunded', earn: 9999_00 },
  ]
  for (const r of rows) {
    const { data: o } = await admin.from('orders').insert({
      msme_id: msme!.id, provider_id: pp!.id, source: 'package', title: `E0 ${r.status}`, scope_snapshot: {},
      price_paise: r.earn, gst_paise: 0, total_paise: r.earn, commission_bps: 0, commission_paise: 0,
      provider_earning_paise: r.earn, delivery_days: 3, status: r.status,
    }).select('id').single()
    if (o) created.orderIds.push(o.id)
  }
  const anonStats = await fetch(`${BASE}/api/v1/partner/stats`)
  check('U8: /partner/stats without a session → 401', anonStats.status === 401)
  const buyerStats = await api(newbie.token, '/api/v1/partner/stats', undefined, 'GET')
  check('U8: a buyer (no provider profile) → 404', buyerStats.status === 404)
  const st = await api(prov.token, '/api/v1/partner/stats', undefined, 'GET')
  const sj = (await st.json().catch(() => ({}))) as { activeCount?: number; completedCount?: number; earningsPaise?: number; openRfqCount?: number }
  const expect = summarizeProviderOrders(rows.map((r) => ({ status: r.status, provider_earning_paise: r.earn })))
  check('U8: stats = the shared rule over the provider’s orders (reviewed counts as completed)',
    st.status === 200 && sj.activeCount === expect.activeCount && sj.completedCount === expect.completedCount && sj.earningsPaise === expect.earningsPaise && sj.openRfqCount === 0,
    JSON.stringify(sj))

  // U9: rating sort is review-weighted and "Top Rated" renders nowhere.
  const search = await fetch(`${BASE}/api/v1/catalog/search?sort=rating&limit=48&_=${tag}`)
  const sr = (await search.json()) as { results?: { avgRating: number; reviewCount: number }[] }
  const w = (r: { avgRating: number; reviewCount: number }) => (r.avgRating * r.reviewCount + 4 * 5) / (r.reviewCount + 5)
  const res = sr.results ?? []
  const ordered = res.every((r, i) => i === 0 || w(res[i - 1]!) + 1e-9 >= w(r))
  check('U9: sort=rating is ordered by the review-weighted rating', search.ok && ordered, `${res.length} results`)

  // CI suspends every seed provider (money-rigs.yml), so the storefront checks
  // use this rig's own active provider with one active package that carries a
  // member discount (U2: that line must never render while the flag is off).
  const { data: pkg } = await admin.from('packages').insert({
    provider_id: pp!.id, category_id: cat!.id, slug: `${tag}-pkg`, title_i18n: { en: 'E0 GST filing' },
    scope_included: ['Monthly GST return'], deliverables: ['Filed return'], price_paise: 1499_00,
    member_extra_discount_bps: 1000, delivery_days: 3, status: 'active',
  }).select('id').single()
  if (pkg) created.packageIds.push(pkg.id)
  const page = await fetch(`${BASE}/p/${tag}-prov`)
  const ph = await page.text()
  check('U9: the provider page shows no "Top Rated"', page.ok && !/Top Rated/i.test(visible(ph)), `status ${page.status}`)
  check('U4: the provider page links a requirement in its category', page.ok && ph.includes('/app/rfq/new?category=tax-accounting'))
  check('U4: the provider page links its packages above the fold', page.ok && ph.includes(`/p/${tag}-prov#packages`))
  const reviews = await fetch(`${BASE}/p/${tag}-prov/reviews`)
  check('U11: /p/[slug]/reviews renders', reviews.ok, `status ${reviews.status}`)
  const pkgPage = await fetch(`${BASE}/p/${tag}-prov/${tag}-pkg`)
  const pkgHtml = await pkgPage.text()
  check('U2: no member-price line while NEXT_PUBLIC_MEMBER_PRICING_ENABLED is off', pkgPage.ok && !/for members/i.test(visible(pkgHtml)), `status ${pkgPage.status}`)
  check('U3: the package page has the sticky buy bar', pkgPage.ok && pkgHtml.includes('lg:hidden') && pkgHtml.includes(`/app/checkout/${pkg?.id}`))
}

async function e1() {
  console.log('\nE1 — design system + shells')
  const word = `Zorblax${Date.now() % 100000}`
  const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()

  const buyer = await mkUser('e1buyer')
  await api(buyer.token, '/api/v1/legal/accept', { docs: ['terms', 'privacy'], surface: 'web', locale: 'en' })
  await api(buyer.token, '/api/v1/profile/msme', { fullName: 'E1 Buyer', businessName: 'E1 Buyer Co', state: 'TS', sector: 'services' })
  const { data: msme } = await admin.from('msme_profiles').select('id').eq('user_id', buyer.uid).single()
  created.msmeIds.push(msme!.id)

  const prov = await mkUser('e1prov', ['provider'])
  const { data: pp } = await admin.from('provider_profiles').insert({
    user_id: prov.uid, legal_name: `E1 ${word} Prov`, display_name: `E1 ${word} Prov`, slug: `${tag}-e1prov`, state: 'TS', status: 'active', languages: ['en'],
  }).select('id').single()
  created.providerIds.push(pp!.id)
  await admin.from('provider_categories').insert({ provider_id: pp!.id, category_id: cat!.id })
  const { data: pkg } = await admin.from('packages').insert({
    provider_id: pp!.id, category_id: cat!.id, slug: `${tag}-e1pkg`, title_i18n: { en: `${word} bookkeeping` },
    scope_included: ['Monthly books'], deliverables: ['Ledger'], price_paise: 2000_00, delivery_days: 5, status: 'active',
  }).select('id').single()
  if (pkg) created.packageIds.push(pkg.id)

  const autoAcceptAt = new Date(Date.now() + 50 * 3600e3).toISOString()
  const mkOrder = async (status: string, extra: Record<string, unknown> = {}) => {
    const { data: o } = await admin.from('orders').insert({
      msme_id: msme!.id, provider_id: pp!.id, source: 'package', title: `${word} order ${status}`, scope_snapshot: {},
      price_paise: 2000_00, gst_paise: 360_00, total_paise: 2360_00, commission_bps: 500, commission_paise: 100_00,
      provider_earning_paise: 1900_00, delivery_days: 5, status, ...extra,
    }).select('id').single()
    if (o) created.orderIds.push(o.id)
    return o!.id as string
  }
  const delivered = await mkOrder('delivered', { auto_accept_at: autoAcceptAt })
  const placed = await mkOrder('placed')
  const { data: rfq } = await admin.from('rfqs').insert({
    msme_id: msme!.id, category_id: cat!.id, title: `${word} audit`, details: {}, status: 'quoted', quote_count: 2,
    expires_at: new Date(Date.now() + 60 * 3600e3).toISOString(),
  }).select('id').single()
  if (rfq) created.rfqIds.push(rfq.id)

  // N2 — /me/actions
  check('N2: /me/actions without a session → 401', (await fetch(`${BASE}/api/v1/me/actions`)).status === 401)
  const ba = (await (await api(buyer.token, '/api/v1/me/actions', undefined, 'GET')).json()) as { buyer?: { counts: { orders: number; requirements: number }; items: { kind: string; objectId: string; action: string | null; dueAt: string | null }[] } | null; provider?: unknown }
  const review = ba.buyer?.items.find((i) => i.objectId === delivered)
  check('N2: buyer — the delivered order needs review by auto_accept_at; placed waits on the provider',
    ba.buyer?.counts.orders === 1 && review?.action === 'review_delivery' && review?.dueAt === autoAcceptAt && !ba.buyer?.items.some((i) => i.objectId === placed),
    JSON.stringify(ba.buyer?.counts))
  check('N2: buyer — quotes waiting on an open requirement', ba.buyer?.counts.requirements === 1 && !!ba.buyer?.items.some((i) => i.kind === 'quotes_waiting' && i.objectId === rfq?.id))
  check('N2: a buyer-only user has no provider section', ba.provider === null)
  const pa = (await (await api(prov.token, '/api/v1/me/actions', undefined, 'GET')).json()) as { provider?: { counts: { orders: number }; items: { objectId: string; action: string | null }[] } | null }
  check('N2: provider — the placed order must be accepted; the delivered one waits on the buyer',
    pa.provider?.counts.orders === 1 && pa.provider?.items.some((i) => i.objectId === placed && i.action === 'accept_order') === true && !pa.provider?.items.some((i) => i.objectId === delivered),
    JSON.stringify(pa.provider?.counts))

  // N3 — universal search
  check('N3: a 1-character query → 422', (await fetch(`${BASE}/api/v1/search/universal?q=x`)).status === 422)
  const anonS = (await (await fetch(`${BASE}/api/v1/search/universal?q=${word}`)).json()) as { services: { id: string }[]; providers: { title: string }[]; mine: unknown }
  check('N3: anonymous search finds the package and the provider, no "mine"', anonS.services.some((h) => h.id === pkg?.id) && anonS.providers.some((h) => h.title.includes(word)) && anonS.mine === null,
    `services=${anonS.services.length} providers=${anonS.providers.length}`)
  const mineS = (await (await api(buyer.token, `/api/v1/search/universal?q=${word}`, undefined, 'GET')).json()) as { mine?: { orders: { id: string }[]; requirements: { id: string }[] } | null }
  check('N3: signed in, "mine" has the buyer’s own orders and requirement', (mineS.mine?.orders.length ?? 0) >= 2 && !!mineS.mine?.requirements.some((h) => h.id === rfq?.id))
  const otherS = (await (await api(prov.token, `/api/v1/search/universal?q=${word}%20audit`, undefined, 'GET')).json()) as { mine?: { requirements: unknown[] } | null }
  check('N3: another user never sees the buyer’s requirement', (otherS.mine?.requirements.length ?? 0) === 0)

  // N33 — density preference
  check('N33: PATCH preferences without a session → 401', (await fetch(`${BASE}/api/v1/profile/preferences`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uiDensity: 'compact' }) })).status === 401)
  check('N33: an unknown density → 422', (await api(buyer.token, '/api/v1/profile/preferences', { uiDensity: 'tiny' }, 'PATCH')).status === 422)
  const setD = await api(buyer.token, '/api/v1/profile/preferences', { uiDensity: 'compact' }, 'PATCH')
  const { data: u } = await admin.from('users').select('ui_density').eq('id', buyer.uid).single()
  check('N33: compact is saved', setD.status === 200 && u?.ui_density === 'compact')

  // The v3 shell (this CI job runs with EXP_V3_SHELL=on).
  const home = await fetch(`${BASE}/app`, { headers: { cookie: buyer.cookie } })
  const hh = await home.text()
  check('E1: the buyer shell renders v3 tokens + the saved density', home.ok && hh.includes('data-ui="v3"') && hh.includes('data-density="compact"'), `status ${home.status}`)
  check('E1: the buyer shell has the rail/tab nav with Requirements', hh.includes('href="/app/rfq"') && hh.includes('href="/app/saved"'))
  const pub = await fetch(`${BASE}/services`)
  const ph = await pub.text()
  check('E1: the public header has "Post a requirement" and the v3 material bar', pub.ok && ph.includes('href="/app/rfq/new"') && ph.includes('material'))
  check('E1: fonts are self-hosted (no Google Fonts request)', !ph.includes('fonts.googleapis.com') && !ph.includes('fonts.gstatic.com'))
  const gal = await fetch(`${BASE}/admin/dev/ui`, { headers: { cookie: buyer.cookie }, redirect: 'manual' })
  check('E1: /admin/dev/ui is admin-only', [302, 303, 307].includes(gal.status), `status ${gal.status}`)
}

async function main() {
  console.log(`\nExperience v3 verification → ${BASE}\n`)
  try {
    await e0()
    await e1()
  } finally {
    console.log('\n🧹 cleanup…')
    const t = async (p: PromiseLike<unknown>) => { try { const r = (await p) as { error?: { message: string } | null } | null; if (r?.error) console.error('  ! delete error', r.error.message) } catch (e) { console.error('  ! delete error', (e as Error)?.message ?? e) } }
    for (const id of created.orderIds) { await t(admin.from('order_events').delete().eq('order_id', id)); await t(admin.from('orders').delete().eq('id', id)) }
    for (const id of created.packageIds) await t(admin.from('packages').delete().eq('id', id))
    for (const id of created.rfqIds) await t(admin.from('rfqs').delete().eq('id', id))
    for (const id of created.providerIds) { await t(admin.from('provider_categories').delete().eq('provider_id', id)); await t(admin.from('provider_profiles').delete().eq('id', id)) }
    for (const id of created.msmeIds) await t(admin.from('msme_profiles').delete().eq('id', id))
    for (const uid of created.users) { await t(admin.from('users').delete().eq('id', uid)); await admin.auth.admin.deleteUser(uid).catch(() => {}) }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
