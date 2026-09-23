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
import { scoreFieldPaths, summarizeProviderOrders, computeOrderAmounts, isValidGstin } from '@amclub/shared'

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

  // U1: the auth wall keeps the whole intent, query included. (Checkout itself
  // is open to guests once EXP_V3_CHECKOUT is on — E5 — so a still-walled path.)
  const wall = await fetch(`${BASE}/app/rfq/new?category=tax-accounting`, { redirect: 'manual' })
  const loc = wall.headers.get('location') ?? ''
  const nextParam = loc ? new URL(loc, BASE).searchParams.get('next') : null
  check('U1: logged-out → /login?next= keeps path + query', [302, 303, 307].includes(wall.status) && nextParam === '/app/rfq/new?category=tax-accounting', `status ${wall.status}, next=${nextParam}`)

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
    ba.buyer?.counts.orders === 1 && review?.action === 'review_delivery' && !!review?.dueAt && Date.parse(review.dueAt) === Date.parse(autoAcceptAt) && !ba.buyer?.items.some((i) => i.objectId === placed),
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

async function setSetting(key: string, value: unknown): Promise<() => Promise<void>> {
  const { data: before } = await admin.from('agent_settings').select('value').eq('key', key).maybeSingle()
  await admin.from('agent_settings').upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
  return async () => {
    if (before) await admin.from('agent_settings').upsert({ key, value: before.value, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    else await admin.from('agent_settings').delete().eq('key', key)
  }
}

async function e3() {
  console.log('\nE3 — trust made visible')
  const { data: cat } = await admin.from('categories').select('id').eq('slug', 'legal').single()
  const buyer = await mkUser('e3buyer')
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'E3 Buyer Co', state: 'TS', sector: 'services' }).select('id').single()
  created.msmeIds.push(msme!.id)
  const buyer2 = await mkUser('e3buyer2')
  const { data: msme2 } = await admin.from('msme_profiles').insert({ user_id: buyer2.uid, business_name: 'E3 Buyer Two', state: 'TS', sector: 'services' }).select('id').single()
  created.msmeIds.push(msme2!.id)
  const prov = await mkUser('e3prov', ['provider'])
  const slug = `${tag}-e3prov`
  const { data: pp } = await admin.from('provider_profiles').insert({
    user_id: prov.uid, legal_name: 'E3 Prov', display_name: 'E3 Prov', slug, state: 'TS', status: 'active', languages: ['en', 'te'],
  }).select('id').single()
  created.providerIds.push(pp!.id)
  await admin.from('provider_categories').insert({ provider_id: pp!.id, category_id: cat!.id })
  await admin.from('provider_verifications').insert([
    { provider_id: pp!.id, kind: 'gstin', value: '36AAAAA0000A1Z5', status: 'api_verified', verified_at: '2026-09-12T06:00:00Z' },
    { provider_id: pp!.id, kind: 'bar_council', value: 'TS/1/2020', status: 'manually_approved', verified_at: '2026-09-03T06:00:00Z' },
  ])

  // 12 delivered + completed orders, 11 on time; buyer 1 has 11 of them (repeat), buyer 2 has 1.
  const now = Date.now()
  const orderIds: string[] = []
  for (let i = 0; i < 12; i++) {
    const due = new Date(now - (20 - i) * 86400e3).toISOString()
    const deliveredAt = new Date(Date.parse(due) + (i === 0 ? 86400e3 : -86400e3)).toISOString()
    const { data: o } = await admin.from('orders').insert({
      msme_id: i === 11 ? msme2!.id : msme!.id, provider_id: pp!.id, source: 'package', title: `E3 order ${i}`, scope_snapshot: {},
      price_paise: 1000_00, gst_paise: 180_00, total_paise: 1180_00, commission_bps: 500, commission_paise: 50_00,
      provider_earning_paise: 950_00, delivery_days: 5, status: 'completed', due_at: due, completed_at: deliveredAt,
    }).select('id').single()
    created.orderIds.push(o!.id)
    orderIds.push(o!.id)
    await admin.from('order_events').insert({ order_id: o!.id, event: 'deliver', created_at: deliveredAt })
  }
  const reviewRows = orderIds.map((id, i) => ({ order_id: id, msme_id: i === 11 ? msme2!.id : msme!.id, provider_id: pp!.id, rating: i < 9 ? 5 : 4, text: `Review ${i}`, status: 'published' }))
  const { error: revErr } = await admin.from('reviews').insert(reviewRows)
  check('fixture reviews inserted', !revErr, revErr?.message ?? '')

  const cronSecret = process.env['CRON_SECRET']
  const cron = await fetch(`${BASE}/api/v1/cron/provider-stats`, { headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {} })
  const { data: row } = await admin.from('provider_public_stats').select('on_time_pct, on_time_n, repeat_n, completed_orders').eq('provider_id', pp!.id).maybeSingle()
  check('N9: nightly stats = fixture truth (11 of 12 on time)', cron.ok && Number(row?.on_time_pct) === 91.67 && row?.on_time_n === 12 && row?.completed_orders === 12, JSON.stringify(row))

  type TrustPayload = { trust?: { stats: { onTime: { pct: number; n: number } | null } | null; verification: { kind: string; method: string; verifiedAt: string | null }[]; availability: { kind: string; date?: string } | null; logoUrl: string | null } | null }
  const read = async () => (await (await fetch(`${BASE}/api/v1/catalog/provider/${slug}?_=${Date.now()}`)).json()) as TrustPayload
  const off = await read()
  check('D1 off (default): no stats in the payload', off.trust !== undefined && off.trust?.stats === null)
  const restore = await setSetting('public_stats_enabled', true)
  try {
    const on = await read()
    check('D1 on: on-time 92 % with n = 12', on.trust?.stats?.onTime?.pct === 92 && on.trust?.stats?.onTime?.n === 12, JSON.stringify(on.trust?.stats))
    check('privacy: no AMC Score field in the buyer payload', scoreFieldPaths(on).length === 0, scoreFieldPaths(on).join(', '))
  } finally {
    await restore()
  }
  const ver = off.trust?.verification ?? []
  check('N10: every verified kind shows method + date', ver.length === 2 && ver.every((v) => (v.method === 'api' || v.method === 'manual') && !!v.verifiedAt) && JSON.stringify(off).indexOf('36AAAAA0000A1Z5') === -1)

  // N11 — availability + last_seen
  const avail = await api(prov.token, '/api/v1/profile/provider/availability', { nextAvailableOn: '2031-01-15', capacitySlots: 3 }, 'PATCH')
  const afterAvail = await read()
  check('N11: the provider’s own next-available date shows', avail.ok && afterAvail.trust?.availability?.kind === 'from' && afterAvail.trust?.availability?.date === '2031-01-15')
  check('N11: availability PATCH rejects a bad capacity', (await api(prov.token, '/api/v1/profile/provider/availability', { nextAvailableOn: null, capacitySlots: 0 }, 'PATCH')).status === 422)
  await new Promise((r) => setTimeout(r, 1500)) // the write runs after the response (next/server after())
  const { data: seen1 } = await admin.from('users').select('last_seen_at').eq('id', prov.uid).single()
  await api(prov.token, '/api/v1/partner/stats', undefined, 'GET')
  await new Promise((r) => setTimeout(r, 1500))
  const { data: seen2 } = await admin.from('users').select('last_seen_at').eq('id', prov.uid).single()
  check('N11: authenticated activity writes last_seen_at, at most once per 15 min', !!seen1?.last_seen_at && seen1.last_seen_at === seen2?.last_seen_at, `${seen1?.last_seen_at} / ${seen2?.last_seen_at}`)

  // N12 — logo moderation
  const sharp = (await import('sharp')).default
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 14, g: 107, b: 79 } } }).png().toBuffer()
  const fd = new FormData()
  fd.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'logo.png')
  const up = await fetch(`${BASE}/api/v1/profile/provider/logo`, { method: 'POST', headers: { Authorization: `Bearer ${prov.token}` }, body: fd })
  const pending = await read()
  check('N12: an uploaded logo waits for approval (not public)', up.ok && pending.trust?.logoUrl === null, `status ${up.status}`)
  const adminUser = await mkUser('e3admin', ['msme', 'admin'])
  const dec = await api(adminUser.token, `/api/v1/admin/providers/${pp!.id}/logo`, { decision: 'approve' })
  const approved = await read()
  check('N12: after approval the logo is public', dec.ok && !!approved.trust?.logoUrl, `status ${dec.status}`)
  check('N12: a buyer cannot approve logos', (await api(buyer.token, `/api/v1/admin/providers/${pp!.id}/logo`, { decision: 'approve' })).status === 403)

  // N13 — reviews v2
  type RP = { reviews: { id: string; repeatBuyer: boolean }[]; histogram: number[]; total: number; nextCursor: string | null }
  const p1 = (await (await fetch(`${BASE}/api/v1/providers/${slug}/reviews`)).json()) as RP
  const p2 = p1.nextCursor ? ((await (await fetch(`${BASE}/api/v1/providers/${slug}/reviews?cursor=${p1.nextCursor}`)).json()) as RP) : null
  const ids = new Set([...p1.reviews, ...(p2?.reviews ?? [])].map((r) => r.id))
  check('N13: reviews paginate past 10 with no gaps or repeats', p1.reviews.length === 10 && p2?.reviews.length === 2 && ids.size === 12 && p2.nextCursor === null)
  check('N13: histogram sums to the total (9×5★, 3×4★)', p1.total === 12 && p1.histogram[0] === 9 && p1.histogram[1] === 3)
  const all = [...p1.reviews, ...(p2?.reviews ?? [])]
  check('N13: "repeat buyer" only for the buyer with ≥ 2 orders', all.filter((r) => r.repeatBuyer).length === 11)
  check('N13: a forged cursor is ignored, not an error', (await fetch(`${BASE}/api/v1/providers/${slug}/reviews?cursor=${Buffer.from('x,y|z').toString('base64url')}`)).ok)
  for (const id of orderIds) await admin.from('reviews').delete().eq('order_id', id)
}

async function e4() {
  console.log('\nE4 — packages and honest pricing')
  // company-registrations is government-dependent (0050 + seed).
  const { data: cat } = await admin.from('categories').select('id, govt_dependent').eq('slug', 'company-registrations').single()
  const { data: other } = await admin.from('categories').select('id').eq('slug', 'legal').single()
  check('N17: registrations category is government-dependent', cat?.govt_dependent === true)
  const prov = await mkUser('e4prov', ['provider'])
  const slug = `${tag}-e4prov`
  const { data: pp } = await admin.from('provider_profiles').insert({
    user_id: prov.uid, legal_name: 'E4 Prov', display_name: 'E4 Prov', slug, state: 'TS', status: 'active', languages: ['en'],
  }).select('id').single()
  created.providerIds.push(pp!.id)
  await admin.from('provider_categories').insert({ provider_id: pp!.id, category_id: cat!.id })
  const mk = async (s: string, price: number, days: number, discountBps = 0, categoryId = cat!.id) => {
    const { data } = await admin.from('packages').insert({
      provider_id: pp!.id, category_id: categoryId, slug: `${tag}-${s}`, title_i18n: { en: `E4 GST registration ${s}` },
      scope_included: ['GSTIN'], deliverables: ['Certificate'], price_paise: price, discount_bps: discountBps, delivery_days: days, status: 'active',
    }).select('id').single()
    created.packageIds.push(data!.id)
    return data!.id as string
  }
  const basic = await mk('basic', 1499_00, 3)
  const standard = await mk('standard', 2999_00, 2, 1000)
  const premium = await mk('premium', 5499_00, 2)
  const stray = await mk('stray', 999_00, 2, 0, other!.id)

  // N16 — every payload carries the server display, equal to what checkout charges.
  type Disp = { taxablePaise: number; gstPaise: number; totalPaise: number; discountPaise: number; itcPaise: number | null }
  const det = (await (await fetch(`${BASE}/api/v1/catalog/package/${slug}/${tag}-standard?_=${Date.now()}`)).json()) as { pkg: { display: Disp } }
  const a = computeOrderAmounts({ pricePaise: 2999_00, discountBps: 1000, commissionBps: 0 })
  check('N16: package payload display = computeOrderAmounts (no coupon)', det.pkg.display.taxablePaise === a.taxablePaise && det.pkg.display.gstPaise === a.gstPaise && det.pkg.display.totalPaise === a.totalPaise && det.pkg.display.itcPaise === null, JSON.stringify(det.pkg.display))
  const provPayload = (await (await fetch(`${BASE}/api/v1/catalog/provider/${slug}?_=${Date.now()}`)).json()) as { packages: { slug: string; display: Disp }[] }
  check('N16: provider payload packages carry display', provPayload.packages.length === 4 && provPayload.packages.every((p) => typeof p.display?.totalPaise === 'number'))

  // FR-4.3 / 4.4 / 4.5 — a single package: equation, refund line, government line.
  const single = visible(await (await fetch(`${BASE}/p/${slug}/${tag}-basic`)).text())
  check('FR-4.3: detail reads "₹1,499 + 18 % GST = ₹1,768.82"', single.includes('₹1,499 + 18 % GST = ₹1,768.82'))
  check('FR-4.4: refund line + policy link on the buy box', single.includes('Full refund before work starts') && single.includes('href="/refund-policy"'))
  check('FR-4.5: government line for a registrations package', single.includes('Approval depends on the government portal') && single.includes('href="/help#government-portal"'))
  check('FR-4.1: a package with no group shows no tier matrix', !single.includes('data-testid="tier-matrix"'))

  // FR-4.1 — the tier editor route.
  const group = {
    titleI18n: { en: 'GST registration' },
    compareRows: [
      { key: 'gstin', labelI18n: { en: 'GSTIN + certificate' } },
      { key: 'udyam', labelI18n: { en: 'Udyam registration' } },
      { key: 'filing', labelI18n: { en: '12 months of filing' } },
    ],
    tiers: [
      { packageId: basic, tier: 'basic', idealForI18n: null, compareValues: { gstin: true } },
      { packageId: standard, tier: 'standard', idealForI18n: { en: 'you also need Udyam this week' }, compareValues: { gstin: true, udyam: true } },
      { packageId: premium, tier: 'premium', idealForI18n: null, compareValues: { gstin: true, udyam: true, filing: '12 months' } },
    ],
  }
  const buyer = await mkUser('e4buyer')
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'E4 Buyer Co', state: 'TS', sector: 'services' }).select('id').single()
  created.msmeIds.push(msme!.id)
  check('FR-4.1: a buyer cannot create tier groups', (await api(buyer.token, '/api/v1/partner/package-groups', group)).status === 403)
  const rival = await mkUser('e4rival', ['provider'])
  const { data: rp } = await admin.from('provider_profiles').insert({ user_id: rival.uid, legal_name: 'E4 Rival', display_name: 'E4 Rival', slug: `${tag}-e4rival`, state: 'TS', status: 'active', languages: ['en'] }).select('id').single()
  created.providerIds.push(rp!.id)
  check("FR-4.1: another provider's packages are not found", (await api(rival.token, '/api/v1/partner/package-groups', group)).status === 404)
  const rows13 = Array.from({ length: 13 }, (_, i) => ({ key: `r${i}`, labelI18n: { en: `Row ${i}` } }))
  check('FR-4.1: more than 12 comparison rows → 422', (await api(prov.token, '/api/v1/partner/package-groups', { ...group, compareRows: rows13 })).status === 422)
  const mixed = { ...group, tiers: [group.tiers[0], { ...group.tiers[1]!, packageId: stray }] }
  const mixedRes = await api(prov.token, '/api/v1/partner/package-groups', mixed)
  check('FR-4.1: tiers across categories → 422 mixed_categories', mixedRes.status === 422 && ((await mixedRes.json()) as { error: string }).error === 'mixed_categories')
  const save = await api(prov.token, '/api/v1/partner/package-groups', group)
  const saved = (await save.json()) as { id: string }
  check('FR-4.1: provider saves a three-tier group', save.status === 201 && !!saved.id, `status ${save.status}`)
  const { data: members } = await admin.from('packages').select('id, tier').eq('group_id', saved.id)
  check('FR-4.1: each package carries its tier', members?.length === 3 && members.find((m) => m.id === standard)?.tier === 'standard')

  // FR-4.2 — the package page with tiers (EXP_V3_PACKAGES=on in this job).
  const tiered = visible(await (await fetch(`${BASE}/p/${slug}/${tag}-standard`)).text())
  check('FR-4.2: tier matrix + tier tabs render', tiered.includes('data-testid="tier-matrix"') && tiered.includes('Compare tiers') && ['Basic', 'Standard', 'Premium'].every((w) => tiered.includes(w)))
  check('FR-4.2: matrix prices come from the server display', tiered.includes('₹1,499 + GST') && tiered.includes('₹2,699 + GST') && tiered.includes('₹5,499 + GST'))
  check('FR-4.2: buy box opens on this page’s tier (Buy now → its checkout, "Choose this if…")', tiered.includes(`href="/app/checkout/${standard}"`) && tiered.includes('you also need Udyam this week'))
  check('FR-4.6: no "Most chosen" without paid orders', !tiered.includes('Most chosen'))

  // FR-4.6 — "Most chosen" only from paid orders: ≥ 50 % share with n ≥ 10.
  const mkOrder = async (packageId: string, status = 'completed') => {
    const { data: o } = await admin.from('orders').insert({
      msme_id: msme!.id, provider_id: pp!.id, package_id: packageId, source: 'package', title: 'E4 order', scope_snapshot: {},
      price_paise: 1000_00, gst_paise: 180_00, total_paise: 1180_00, commission_bps: 500, commission_paise: 50_00,
      provider_earning_paise: 950_00, delivery_days: 3, status,
    }).select('id').single()
    created.orderIds.push(o!.id)
  }
  for (let i = 0; i < 5; i++) await mkOrder(standard)
  for (let i = 0; i < 2; i++) await mkOrder(basic)
  for (let i = 0; i < 2; i++) await mkOrder(premium)
  await mkOrder(standard, 'refunded') // a refunded order is not a lasting choice
  await api(prov.token, '/api/v1/partner/package-groups', { ...group, id: saved.id }) // re-save → revalidate
  const nine = visible(await (await fetch(`${BASE}/p/${slug}/${tag}-standard`)).text())
  check('FR-4.6: n = 9 paid orders → no label (refunded ignored)', !nine.includes('Most chosen'))
  await mkOrder(standard)
  await api(prov.token, '/api/v1/partner/package-groups', { ...group, id: saved.id })
  const ten = visible(await (await fetch(`${BASE}/p/${slug}/${tag}-standard`)).text())
  check('FR-4.6: 6 of 10 paid orders → "Most chosen" on Standard', ten.includes('data-testid="most-chosen"'))

  // N16 — ITC eligibility is a yes/no for a verified GSTIN, never the GSTIN.
  const itc = async (token?: string) => ((await (await fetch(`${BASE}/api/v1/me/itc`, token ? { headers: { Authorization: `Bearer ${token}` } } : {})).json()) as { eligible: boolean }).eligible
  const anonItc = await itc()
  const before = await itc(buyer.token)
  await admin.from('msme_profiles').update({ gstin: '36AAAAA0000A1Z5', gstin_verified: true }).eq('id', msme!.id)
  const after = await itc(buyer.token)
  check('N16: ITC only for a buyer with a verified GSTIN', anonItc === false && before === false && after === true)

  // Ungroup — the packages stay live as single packages.
  const del = await api(prov.token, `/api/v1/partner/package-groups/${saved.id}`, undefined, 'DELETE')
  const { data: freed } = await admin.from('packages').select('group_id, tier').in('id', [basic, standard, premium])
  check('FR-4.1: ungroup releases every package (still active)', del.ok && (freed ?? []).every((p) => p.group_id === null && p.tier === null))
  const back = visible(await (await fetch(`${BASE}/p/${slug}/${tag}-standard`)).text())
  check('FR-4.1: after ungrouping the page has no matrix', !back.includes('data-testid="tier-matrix"') && back.includes('₹2,699.10 + 18 % GST = ₹3,184.94'))
}

async function e2a() {
  console.log('\nE2a — search v2, facets, feedback, weak results')
  const word = `Quillon${Date.now() % 100000}`
  const { data: tax } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
  const { data: legal } = await admin.from('categories').select('id').eq('slug', 'legal').single()
  const mkProv = async (label: string, extra: Record<string, unknown>) => {
    const u = await mkUser(label, ['provider'])
    const { data } = await admin.from('provider_profiles').insert({
      user_id: u.uid, legal_name: label, display_name: label, slug: `${tag}-${label}`, status: 'active', ...extra,
    }).select('id').single()
    created.providerIds.push(data!.id)
    return data!.id as string
  }
  const p1 = await mkProv('e2p1', { state: 'TS', city: 'Hyderabad', languages: ['en', 'te'], avg_rating: 4.8, review_count: 20, median_response_minutes: 90 })
  const p2 = await mkProv('e2p2', { state: 'DL', city: 'Delhi', languages: ['en', 'hi'], avg_rating: 4.2, review_count: 5, median_response_minutes: 600 })
  await admin.from('provider_verifications').insert({ provider_id: p1, kind: 'icai', value: 'X', status: 'api_verified', verified_at: new Date().toISOString() })
  const mkPkg = async (s: string, provider: string, cat: string, service: string, price: number, days: number, discountBps = 0) => {
    const { data, error } = await admin.from('packages').insert({
      provider_id: provider, category_id: cat, slug: `${tag}-${s}`, title_i18n: { en: `${word} ${service.replace(/-/g, ' ')}` },
      scope_included: ['x'], deliverables: ['y'], price_paise: price, discount_bps: discountBps, delivery_days: days, service_slug: service, status: 'active',
    }).select('id').single()
    if (error) throw new Error(`e2 package ${s}: ${error.message}`)
    created.packageIds.push(data!.id)
    return data!.id as string
  }
  const A = await mkPkg('e2a', p1, tax!.id, 'gst-filing', 1499_00, 3)
  const B = await mkPkg('e2b', p1, tax!.id, 'itr-filing', 2999_00, 7, 1000)
  const C = await mkPkg('e2c', p2, tax!.id, 'gst-filing', 999_00, 10)
  const D = await mkPkg('e2d', p2, legal!.id, 'trademark', 4999_00, 14)

  type Facets = Record<string, Record<string, number>>
  type SR = { results: { packageId: string; providerId: string; display: { taxablePaise: number } }[]; total: number; facets: Facets | null; weak: boolean }
  const search = async (qs: string) => (await (await fetch(`${BASE}/api/v1/catalog/search?query=${word}${qs}&_=${Date.now()}`)).json()) as SR
  const ids = (r: SR) => r.results.map((x) => x.packageId)
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

  const all = await search('')
  const f = all.facets ?? {}
  check('FR-2.1: search v2 answers with facets and display prices', all.total === 4 && !!all.facets && all.results.every((r) => typeof r.display?.taxablePaise === 'number'), `total ${all.total}`)
  check('FR-2.1: facet counts = fixture truth (category, state, credential, verified)',
    f['category']?.['tax-accounting'] === 3 && f['category']?.['legal'] === 1 && f['state']?.['TS'] === 2 && f['state']?.['DL'] === 2 && f['credential']?.['icai'] === 2 && f['verified']?.['true'] === 2,
    JSON.stringify({ c: f['category'], s: f['state'], cr: f['credential'], v: f['verified'] }))
  check('FR-2.1: facet counts = fixture truth (service, delivery, language)',
    f['service']?.['gst-filing'] === 2 && f['service']?.['itr-filing'] === 1 && f['delivery']?.['3'] === 1 && f['delivery']?.['7'] === 2 && f['delivery']?.['14'] === 4 && f['language']?.['te'] === 2 && f['language']?.['hi'] === 2,
    JSON.stringify({ s: f['service'], d: f['delivery'], l: f['language'] }))
  const ts = await search('&state=TS')
  check('FR-2.1: a facet ignores its own filter (state=TS still counts DL)', ts.total === 2 && ts.facets?.['state']?.['DL'] === 2 && ts.facets?.['category']?.['tax-accounting'] === 2)
  check('FR-2.1: service filter', same(ids(await search('&service=gst-filing')), [A, C]))
  check('FR-2.1: credential filter', same(ids(await search('&credential=icai')), [A, B]))
  check('FR-2.1: delivery ≤ 7 days', same(ids(await search('&deliveryMaxDays=7')), [A, B]))
  check('FR-2.1: replies within 2 h', same(ids(await search('&responseMaxHours=2')), [A, B]))
  check('FR-2.1: price band on the price before GST (under ₹2,000)', same(ids(await search('&price=under2k')), [A, C]))
  check('FR-2.1: city filter', same(ids(await search('&city=Delhi')), [C, D]))
  check('FR-2.1: sort price_asc uses the discounted price', ids(await search('&sort=price_asc')).join() === [C, A, B, D].join())
  check('FR-2.1: sort fastest', ids(await search('&sort=fastest')).join() === [A, B, C, D].join())
  const best = await search('')
  check('FR-2.1: best match puts the verified, better-rated provider first', best.results[0]?.providerId === p1 && best.results[1]?.providerId === p1)
  check('FR-2.1: a forged sort / state is dropped, not an error', (await search('&sort=sponsored&state=ZZ')).total === 4)

  // FR-2.2 / 2.4 — pages, round-tripped through the URL.
  const listHtml = visible(await (await fetch(`${BASE}/services?query=${word}&state=TS&view=list`)).text())
  check('FR-2.4: list view renders rows (URL view=list)', listHtml.includes('data-view="list"') && (listHtml.match(/data-testid="result-row"/g) ?? []).length === 2)
  check('FR-2.2: facet rail + chip bar render', listHtml.includes('data-testid="facet-rail"') && listHtml.includes('data-testid="filter-chips"'))
  const rt = visible(await (await fetch(`${BASE}/services?query=${word}&deliveryMaxDays=7&sort=fastest`)).text())
  check('FR-2.1: filters round-trip through the URL (2 results, fastest)', rt.includes('2 results') && rt.indexOf(`${word} gst filing`) < rt.indexOf(`${word} itr filing`))
  const catHtml = visible(await (await fetch(`${BASE}/services/tax-accounting`)).text())
  check('FR-2.2: filters show before a query on a category page', catHtml.includes('data-testid="filter-chips"'))

  // FR-2.7 — weak and zero results never dead-end.
  const weak = visible(await (await fetch(`${BASE}/services?query=${word}&service=trademark`)).text())
  check('FR-2.7: < 3 results → the requirement card, query carried', weak.includes('data-testid="weak-results"') && weak.includes(`href="/app/rfq/new?q=${word}"`))
  const zero = visible(await (await fetch(`${BASE}/services?query=${word}xyzzy`)).text())
  check('FR-2.7: zero results → the requirement card (no signup dead end)', zero.includes('data-testid="weak-results"') && zero.includes(`href="/app/rfq/new?q=${word}xyzzy"`))

  // FR-2.6 — relevance feedback: anyone may answer, nobody reads it back.
  const fb = (body: unknown) => fetch(`${BASE}/api/v1/search/feedback`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const ok = await fb({ query: word, filters: { state: 'TS' }, resultIds: [A, B], helpful: false, reason: 'too_slow', surface: 'web' })
  const { data: fbRow } = await admin.from('search_feedback').select('helpful, reason, result_ids, user_id').eq('query', word).maybeSingle()
  check('FR-2.6: feedback is stored (signed out → no user)', ok.status === 201 && fbRow?.helpful === false && fbRow.reason === 'too_slow' && fbRow.result_ids?.length === 2 && fbRow.user_id === null, `status ${ok.status}`)
  check('FR-2.6: an unknown reason → 422', (await fb({ query: word, filters: {}, resultIds: [], helpful: false, reason: 'ugly' })).status === 422)
  const anonRead = await createClient(URL_, ANON, { auth: { persistSession: false } }).from('search_feedback').select('id').limit(1)
  check('FR-2.6: no client can read search_feedback', !!anonRead.error || (anonRead.data ?? []).length === 0)
  await admin.from('search_feedback').delete().eq('query', word)
  return { word, A, B, C, D, p1, p2 }
}

async function e2b(fx: { word: string; A: string; B: string; C: string; D: string }) {
  console.log('\nE2b — service pages, compare, recently viewed, voice search')
  const { word, A, B, C, D } = fx

  // FR-2.3 — packages carry a service; the service landing page compares providers.
  const prov = await mkUser('e2bprov', ['provider'])
  const { data: tax } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
  const { data: pp } = await admin.from('provider_profiles').insert({ user_id: prov.uid, legal_name: 'E2b Prov', display_name: 'E2b Prov', slug: `${tag}-e2bprov`, state: 'TS', status: 'active', languages: ['en'] }).select('id').single()
  created.providerIds.push(pp!.id)
  await admin.from('provider_categories').insert({ provider_id: pp!.id, category_id: tax!.id })
  const pkgBody = { category_slug: 'tax-accounting', title: `${word} audit package`, scope_included: ['Audit'], deliverables: ['Report'], price_paise: 4000_00, delivery_days: 9, status: 'active' }
  // The package routes read the web session (cookie), like the wizard.
  const asProv = (body: unknown) => fetch(`${BASE}/api/v1/partner/packages`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: prov.cookie }, body: JSON.stringify(body) })
  const bad = await asProv({ ...pkgBody, service_slug: 'trademark' })
  check('FR-2.3: a service from another category → 422', bad.status === 422 && ((await bad.json()) as { error: string }).error === 'invalid_service')
  const good = await asProv({ ...pkgBody, service_slug: 'audit' })
  const gid = ((await good.json()) as { id?: string }).id
  if (gid) created.packageIds.push(gid)
  const { data: gRow } = await admin.from('packages').select('service_slug').eq('id', gid ?? '').maybeSingle()
  check('FR-2.3: the wizard route stores the service', good.ok && gRow?.service_slug === 'audit', `status ${good.status}`)

  const svc = visible(await (await fetch(`${BASE}/services/tax-accounting/gst-filing`)).text())
  check('FR-2.3: service page renders hero + provider table for that service', svc.includes('data-testid="service-hero"') && svc.includes('data-testid="service-provider-table"') && svc.includes('e2p1') && svc.includes('e2p2'))
  check('FR-2.3: the table shows each provider’s from-price + GST', svc.includes('₹1,499 + GST') && svc.includes('₹999 + GST'))
  check('FR-2.3: sibling service chips link to the other services', svc.includes('data-testid="service-chips"') && svc.includes('href="/services/tax-accounting/itr-filing"'))
  // Not found either way: a 404, or — behind the (public) loading boundary, which
  // has already streamed — Next's not-found UI marked noindex.
  const wrongSvc = await fetch(`${BASE}/services/tax-accounting/trademark`)
  const wrongHtml = await wrongSvc.text()
  check('FR-2.3: a service of another category is not found (404 / noindex)', wrongSvc.status === 404 || ((wrongHtml.includes('noindex') || wrongHtml.includes('>404<')) && !wrongHtml.includes('data-testid="service-hero"')), `status ${wrongSvc.status}`)

  // FR-2.9 — shortlist compare: four columns, identical rows.
  const cmp = visible(await (await fetch(`${BASE}/compare?items=${[A, B, C, D].join(',')}`)).text())
  const table = cmp.slice(cmp.indexOf('data-testid="compare-table"'))
  const rowCount = (table.match(/data-row="/g) ?? []).length
  const tdCount = (table.match(/<td\b/g) ?? []).length
  check('FR-2.9: compare renders 4 columns with identical row sets', rowCount === 10 && tdCount === rowCount * 4 + 4, `rows ${rowCount}, cells ${tdCount}`)
  check('FR-2.9: compare prices are the server display', cmp.includes('₹999 + GST') && cmp.includes('₹2,699 + GST'))
  check('FR-2.9: junk items → the empty state, not an error', (await fetch(`${BASE}/compare?items=nope,${'x'.repeat(36)}`)).ok)
  check('FR-2.9: search results carry the Compare toggle', visible(await (await fetch(`${BASE}/services?query=${word}`)).text()).includes('data-testid="compare-toggle"'))

  // FR-2.8 — recently viewed: the owner's own, newest first, 20 kept.
  const buyer = await mkUser('e2bbuyer')
  check('FR-2.8: a signed-out view is not stored (401)', (await fetch(`${BASE}/api/v1/me/recent-views`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'package', refId: A }) })).status === 401)
  for (const id of [A, B, C, D]) await api(buyer.token, '/api/v1/me/recent-views', { kind: 'package', refId: id })
  type RV = { items: { id: string; href: string }[] }
  const rv = (await (await api(buyer.token, '/api/v1/me/recent-views', undefined, 'GET')).json()) as RV
  check('FR-2.8: recently viewed resolves titles + links, newest first', rv.items?.length === 4 && rv.items[0]?.id === D && rv.items.every((x) => x.href.startsWith('/p/')))
  const other = await mkUser('e2bother')
  const orv = (await (await api(other.token, '/api/v1/me/recent-views', undefined, 'GET')).json()) as RV
  check('FR-2.8: another user sees none of them', (orv.items ?? []).length === 0)
  const filler = Array.from({ length: 21 }, () => ({ user_id: buyer.uid, kind: 'provider', ref_id: crypto.randomUUID(), viewed_at: new Date(Date.now() - 86400e3).toISOString() }))
  await admin.from('recent_views').insert(filler)
  await api(buyer.token, '/api/v1/me/recent-views', { kind: 'package', refId: A })
  const { count } = await admin.from('recent_views').select('id', { count: 'exact', head: true }).eq('user_id', buyer.uid)
  check('FR-2.8: only the newest 20 are kept', count === 20, `count ${count}`)
  await admin.from('recent_views').delete().in('user_id', [buyer.uid, other.uid])

  // FR-2.5 — voice search: off until voice_search_enabled; then an English query (stub keyless).
  const voice = (text: string) => {
    const fd = new FormData()
    fd.append('text', text)
    fd.append('mode', 'query')
    return fetch(`${BASE}/api/v1/rfq/voice-parse`, { method: 'POST', headers: { Authorization: `Bearer ${buyer.token}` }, body: fd })
  }
  check('FR-2.5: voice search is off by default (404)', (await voice('GST registration for my shop')).status === 404)
  const restore = await setSetting('voice_search_enabled', true)
  try {
    const on = await voice('GST registration for my shop')
    const vj = (await on.json()) as { query?: string; category_slug?: string | null; original_language?: string }
    check('FR-2.5: mode=query answers an English query + language (stub, keyless)', on.ok && vj.query === 'GST registration for my shop' && 'category_slug' in vj && typeof vj.original_language === 'string', `status ${on.status}`)
  } finally {
    await restore()
  }
  check('FR-2.5: results after a voice search show "You said"', visible(await (await fetch(`${BASE}/services?query=${word}&voice=1`)).text()).includes('data-testid="you-said"'))
}

async function e5() {
  console.log('\nE5 — checkout v3')
  const { data: cat } = await admin.from('categories').select('id, commission_bps').eq('slug', 'tax-accounting').single()
  const prov = await mkUser('e5prov', ['provider'])
  const { data: pp } = await admin.from('provider_profiles').insert({ user_id: prov.uid, legal_name: 'E5 Prov', display_name: 'E5 Sharma & Co', slug: `${tag}-e5prov`, state: 'TS', status: 'active', languages: ['en'] }).select('id').single()
  created.providerIds.push(pp!.id)
  const { data: pkg } = await admin.from('packages').insert({
    provider_id: pp!.id, category_id: cat!.id, slug: `${tag}-e5pkg`, title_i18n: { en: 'E5 GST registration' },
    scope_included: ['GSTIN'], deliverables: ['Certificate'], price_paise: 2999_00, delivery_days: 2, status: 'active',
    requirements_template: { fields: [{ name: 'pan', type: 'text', label_en: 'PAN', required: true }, { name: 'addr', type: 'file', label_en: 'Address proof', required: true }] },
  }).select('id').single()
  created.packageIds.push(pkg!.id)
  const url = `${BASE}/app/checkout/${pkg!.id}`
  const expected = computeOrderAmounts({ pricePaise: 2999_00, discountBps: 0, commissionBps: cat!.commission_bps ?? 1000 })

  // FR-5.1 — a guest stays on the checkout page and signs up inline.
  const guest = await fetch(url, { redirect: 'manual' })
  const gh = visible(await guest.text())
  check('FR-5.1: a signed-out visitor stays on /app/checkout/[id] (no redirect)', guest.status === 200 && gh.includes('data-mode="guest"') && gh.includes('data-testid="inline-auth"'), `status ${guest.status}`)
  check('FR-5.2: the total is the money loop’s amount (₹3,538.82)', expected.totalPaise === 353882 && gh.includes('₹3,538.82') && gh.includes('₹539.82'))
  check('FR-5.3: what happens next — provider, 24 h, the requirement labels', gh.includes('E5 Sharma &amp; Co accepts within 24 h') && gh.includes('You share: PAN, Address proof.') && gh.includes('Money is released only when you accept the work.'))
  check('FR-5.4: the refund line', gh.includes('Full refund before work starts'))
  check('FR-5.1: an unknown package → 404 for a guest', (await fetch(`${BASE}/app/checkout/00000000-0000-4000-8000-000000000001`, { redirect: 'manual' })).status === 404)
  check('FR-5.1: any other /app path still needs sign-in', [302, 303, 307].includes((await fetch(`${BASE}/app/orders`, { redirect: 'manual' })).status))

  // FR-5.1 — signed in without a buyer profile: the last step inline, then pay.
  const fresh = await mkUser('e5fresh')
  const ph = visible(await (await fetch(url, { headers: { cookie: fresh.cookie }, redirect: 'manual' })).text())
  check('FR-5.1: signed in without a buyer profile → the inline details step', ph.includes('data-mode="profile"') && ph.includes('data-testid="inline-profile"'))
  const legal = await api(fresh.token, '/api/v1/legal/accept', { docs: ['terms', 'privacy'], surface: 'web', locale: 'en' })
  const prof = await api(fresh.token, '/api/v1/profile/msme', { fullName: 'E5 Buyer', businessName: 'E5 Buyer Co', preferredLocale: 'en' })
  const { data: acc } = await admin.from('terms_acceptances').select('doc').eq('user_id', fresh.uid)
  const { data: fm } = await admin.from('msme_profiles').select('id').eq('user_id', fresh.uid).maybeSingle()
  if (fm) created.msmeIds.push(fm.id)
  check('FR-5.1: inline signup writes the legal acceptance rows as signup does', legal.ok && prof.ok && ['terms', 'privacy'].every((d) => (acc ?? []).some((a) => a.doc === d)))
  const payHtml = visible(await (await fetch(url, { headers: { cookie: fresh.cookie } })).text())
  check('FR-5.1: then the same page shows Pay', payHtml.includes('data-mode="pay"') && payHtml.includes('data-testid="checkout-pay"'))
  check('FR-5.2: no ITC line without a GSTIN', !payHtml.includes('data-testid="checkout-itc"'))

  // FR-5.2 — ITC only with a checksum-valid GSTIN (shown masked).
  const good = '27AAPFU0939F1ZV'
  const badSum = '27AAPFU0939F1ZX'
  check('fixture: GSTIN checksums', isValidGstin(good) && !isValidGstin(badSum))
  await admin.from('msme_profiles').update({ gstin: badSum }).eq('id', fm!.id)
  check('FR-5.2: a bad-checksum GSTIN → no ITC line', !visible(await (await fetch(url, { headers: { cookie: fresh.cookie } })).text()).includes('data-testid="checkout-itc"'))
  await admin.from('msme_profiles').update({ gstin: good }).eq('id', fm!.id)
  const itcHtml = visible(await (await fetch(url, { headers: { cookie: fresh.cookie } })).text())
  check('FR-5.2: ITC line with a valid GSTIN, masked', itcHtml.includes('Claim ₹539.82 as input tax credit (GSTIN 27AA…ZV)') && !itcHtml.includes(good))

  // The server charges exactly what the page showed.
  const start = await api(fresh.token, '/api/v1/checkout', { packageId: pkg!.id, idempotencyKey: crypto.randomUUID() })
  const sj = (await start.json()) as { amountPaise?: number; checkoutSessionId?: string }
  check('FR-5.2: checkout charges the displayed total', start.ok && sj.amountPaise === expected.totalPaise, `status ${start.status}, amount ${sj.amountPaise}`)
  if (sj.checkoutSessionId) await admin.from('checkout_sessions').delete().eq('id', sj.checkoutSessionId)
}

async function e6() {
  console.log('\nE6 — requirements v3')
  // ≤ 5 required fields in every seeded template.
  const { data: cats } = await admin.from('categories').select('slug, rfq_template').eq('is_active', true)
  const over = (cats ?? []).filter((c) => (((c.rfq_template as { fields?: { required?: boolean }[] } | null)?.fields ?? []).filter((f) => f.required).length > 5))
  check('FR-6.1: every template has ≤ 5 required fields', (cats ?? []).length >= 8 && over.length === 0, over.map((c) => c.slug).join(', '))

  const { data: tax } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
  const buyer = await mkUser('e6buyer')
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'E6 Buyer Co', state: 'MZ', sector: 'services' }).select('id').single()
  created.msmeIds.push(msme!.id)
  await api(buyer.token, '/api/v1/legal/accept', { docs: ['terms', 'privacy'], surface: 'web', locale: 'en' })
  const prov = await mkUser('e6prov', ['provider'])
  const { data: pp } = await admin.from('provider_profiles').insert({ user_id: prov.uid, legal_name: 'E6 Prov', display_name: 'E6 Prov', slug: `${tag}-e6prov`, state: 'MZ', status: 'active', languages: ['en'] }).select('id').single()
  created.providerIds.push(pp!.id)
  await admin.from('provider_categories').insert({ provider_id: pp!.id, category_id: tax!.id })
  const { data: pkg } = await admin.from('packages').insert({ provider_id: pp!.id, category_id: tax!.id, slug: `${tag}-e6pkg`, title_i18n: { en: 'E6 GST filing' }, scope_included: ['x'], deliverables: ['y'], price_paise: 1500_00, delivery_days: 5, status: 'active', service_slug: 'gst-filing' }).select('id').single()
  created.packageIds.push(pkg!.id)

  // FR-6.6 (N20) — every entry point resolves its prefill on the server.
  const page = async (qs: string) => (await (await fetch(`${BASE}/app/rfq/new${qs}`, { headers: { cookie: buyer.cookie } })).text())
  const attr = (html: string, name: string) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null
  const search = await page('?q=GST%20returns&category=tax-accounting&service=gst-filing&entry=search')
  check('FR-6.6: search → category + service + entry', attr(search, 'data-prefill-category') === 'tax-accounting' && attr(search, 'data-prefill-service') === 'gst-filing' && attr(search, 'data-entry') === 'search')
  const fromPkg = await page(`?from_package=${pkg!.id}`)
  check('FR-6.6: a package page → its category + service', attr(fromPkg, 'data-prefill-category') === 'tax-accounting' && attr(fromPkg, 'data-prefill-service') === 'gst-filing' && attr(fromPkg, 'data-entry') === 'package')
  const fromProv = await page(`?from_provider=${tag}-e6prov`)
  check('FR-6.6: a provider profile → the category only', attr(fromProv, 'data-prefill-category') === 'tax-accounting' && attr(fromProv, 'data-prefill-service') === '' && attr(fromProv, 'data-entry') === 'provider')
  const junk = await page('?category=nope&service=nope&from_package=x')
  check('FR-6.6: unknown values are dropped', attr(junk, 'data-prefill-category') === '' && attr(junk, 'data-entry') === 'direct')
  const pkgPage = visible(await (await fetch(`${BASE}/p/${tag}-e6prov/${tag}-e6pkg`)).text())
  check('FR-6.6: the package page links "Need something different?"', pkgPage.includes(`href="/app/rfq/new?from_package=${pkg!.id}&amp;entry=package"`))

  // FR-6.3 — suggestions only when switched on, and only reviewed rows.
  check('FR-6.3: no document suggestions while the setting is off', attr(search, 'data-docs') === '')
  const restore = await setSetting('document_suggestions_enabled', true)
  const { data: row } = await admin.from('service_document_requirements').select('id, doc_key').eq('category_slug', 'tax-accounting').eq('doc_key', 'gst_login').maybeSingle()
  try {
    const before = attr(await page('?category=tax-accounting'), 'data-docs')
    await admin.from('service_document_requirements').update({ reviewed_at: new Date().toISOString() }).eq('id', row!.id)
    const after = attr(await page('?category=tax-accounting'), 'data-docs') ?? ''
    check('FR-6.3: only CA-reviewed rows are suggested', before === '' && after.split(',').includes('gst_login') && !after.split(',').includes('pan'))
  } finally {
    await admin.from('service_document_requirements').update({ reviewed_at: null }).eq('id', row!.id)
    await restore()
  }

  // FR-6.4 — must-haves are stored and shown, and fan-out is unchanged.
  const body = { category_slug: 'tax-accounting', title: 'E6 GST returns for FY 25-26', details: { notes: 'Monthly GSTR-1 and 3B', service_slug: 'gst-filing', documents_expected: ['gst_login', 'pan'] } }
  const plain = await api(buyer.token, '/api/v1/rfq', body)
  const pj = (await plain.json()) as { rfqId?: string; matched?: number }
  const withMh = await api(buyer.token, '/api/v1/rfq', { ...body, must_haves: { credentials: ['icai'], languages: ['te'], onSite: true, inStateOnly: true } })
  const wj = (await withMh.json()) as { rfqId?: string; matched?: number }
  if (pj.rfqId) created.rfqIds.push(pj.rfqId)
  if (wj.rfqId) created.rfqIds.push(wj.rfqId)
  const { data: stored } = await admin.from('rfqs').select('must_haves, details').eq('id', wj.rfqId ?? '').maybeSingle()
  check('FR-6.4: must-haves are stored', withMh.ok && (stored?.must_haves as { credentials?: string[] } | null)?.credentials?.[0] === 'icai' && ((stored?.details as { documents_expected?: string[] }).documents_expected ?? []).length === 2, `status ${withMh.status}`)
  check('FR-6.4: fan-out is unchanged by must-haves (display only)', plain.ok && pj.matched === 1 && wj.matched === pj.matched, `plain ${pj.matched}, with ${wj.matched}`)
  const bad = await api(buyer.token, '/api/v1/rfq', { ...body, must_haves: { credentials: ['pan'] } })
  check('FR-6.4: a must-have outside the list → 422', bad.status === 422)
  const provView = visible(await (await fetch(`${BASE}/partner/rfqs/${wj.rfqId}`, { headers: { cookie: prov.cookie } })).text())
  check('FR-6.4: the provider sees the must-haves and the documents', provView.includes('data-testid="rfq-must-haves-view"') && provView.includes('GST portal login') && !provView.includes('documents expected'))

  // FR-6.5 (N38) — the nightly quote-time stat (fixture truth: 60 and 120 minutes → 90, n 2).
  const t0 = Date.now() - 10 * 86400e3
  for (const mins of [60, 120]) {
    const { data: r } = await admin.from('rfqs').insert({ msme_id: msme!.id, category_id: tax!.id, title: `E6 SLA ${mins}`, details: {}, status: 'quoted', expires_at: new Date(t0 + 3 * 86400e3).toISOString(), created_at: new Date(t0).toISOString(), fanout_at: new Date(t0).toISOString(), quote_count: 1 }).select('id').single()
    created.rfqIds.push(r!.id)
    await admin.from('quotes').insert({ rfq_id: r!.id, provider_id: pp!.id, price_paise: 1000_00, delivery_days: 3, scope: 'E6 fixture quote scope text', created_at: new Date(t0 + mins * 60e3).toISOString() })
  }
  const cronSecret = process.env['CRON_SECRET']
  const cron = await fetch(`${BASE}/api/v1/cron/provider-stats`, { headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {} })
  const cronBody = (await cron.json().catch(() => ({}))) as { quoteSla?: unknown }
  const { data: sla } = await admin.from('quote_sla_stats').select('median_minutes, n').eq('category_slug', 'tax-accounting').eq('state', 'MZ').maybeSingle()
  check('FR-6.5: nightly median first-quote time = fixture truth', cron.ok && sla?.median_minutes === 90 && sla?.n === 2, `${JSON.stringify(sla)} · cron ${cron.status} ${JSON.stringify(cronBody.quoteSla)}`)
  check('FR-6.5: the form gets the stat for the buyer’s state', (attr(await page('?category=tax-accounting'), 'data-sla') ?? '').includes('tax-accounting:90:2'))
  for (const id of created.rfqIds) await admin.from('quotes').delete().eq('rfq_id', id)
}

async function main() {
  console.log(`\nExperience v3 verification → ${BASE}\n`)
  try {
    await e0()
    await e1()
    await e3()
    await e4()
    const fx = await e2a()
    await e2b(fx)
    await e5()
    await e6()
  } finally {
    console.log('\n🧹 cleanup…')
    const t = async (p: PromiseLike<unknown>) => { try { const r = (await p) as { error?: { message: string } | null } | null; if (r?.error) console.error('  ! delete error', r.error.message) } catch (e) { console.error('  ! delete error', (e as Error)?.message ?? e) } }
    for (const id of created.orderIds) { await t(admin.from('order_events').delete().eq('order_id', id)); await t(admin.from('orders').delete().eq('id', id)) }
    for (const id of created.packageIds) await t(admin.from('packages').delete().eq('id', id))
    for (const id of created.rfqIds) await t(admin.from('rfqs').delete().eq('id', id))
    for (const id of created.providerIds) { await t(admin.from('provider_categories').delete().eq('provider_id', id)); await t(admin.from('provider_verifications').delete().eq('provider_id', id)); await t(admin.from('provider_public_stats').delete().eq('provider_id', id)); await t(admin.from('provider_profiles').delete().eq('id', id)) }
    for (const id of created.msmeIds) await t(admin.from('msme_profiles').delete().eq('id', id))
    for (const uid of created.users) { await t(admin.from('audit_logs').delete().eq('actor_id', uid)); await t(admin.from('users').delete().eq('id', uid)); await admin.auth.admin.deleteUser(uid).catch(() => {}) }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
