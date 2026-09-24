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
import { scoreFieldPaths, summarizeProviderOrders, computeOrderAmounts, isValidGstin, meActionsSchema, nextAction, priceDisplay, autofilledFields, quotePreview, VOICE_EVAL_VERSION, type ActionItem, type GstinAutofill, type OrderStatus } from '@amclub/shared'

const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++ }
const tag = `expv_${Date.now()}`
// E18: the `guide` flag as the server under test reads it (money-rigs sets EXP_V3_GUIDE=on).
const GUIDE_ON = /^(on|true|100)$/i.test((process.env['EXP_V3_GUIDE'] ?? '').trim())
// E18: a second server with AGENT_ENABLED=true (money-rigs :3001), for the assistant home. Unset → only the flag-off checks.
const AGENT_BASE = process.env['AGENT_BASE_URL']
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
  // ADR 025 (0073): no client write grant on packages, so edit / pause / delete
  // write with the service role after the ownership check. They still work.
  if (gid) {
    const toPkg = (id: string, method: string, body?: unknown) => fetch(`${BASE}/api/v1/partner/packages/${id}`, { method, headers: { 'Content-Type': 'application/json', cookie: prov.cookie }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const edit = await toPkg(gid, 'PATCH', { ...pkgBody, service_slug: 'audit', price_paise: 4200_00, status: 'paused' })
    const { data: eRow } = await admin.from('packages').select('price_paise, status').eq('id', gid).single()
    check('ADR 025: the owner edits and pauses through the route', edit.ok && Number(eRow?.price_paise) === 4200_00 && eRow?.status === 'paused', `status ${edit.status}`)
    const back = await toPkg(gid, 'PATCH', { ...pkgBody, service_slug: 'audit', status: 'active' })
    const { data: bRow } = await admin.from('packages').select('price_paise, status').eq('id', gid).single()
    check('ADR 025: … and restores it', back.ok && Number(bRow?.price_paise) === 4000_00 && bRow?.status === 'active', `status ${back.status}`)
    const other = await mkUser('e2bother', ['provider'])
    check('ADR 025: another provider cannot edit it (404)', (await fetch(`${BASE}/api/v1/partner/packages/${gid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie: other.cookie }, body: JSON.stringify({ ...pkgBody, price_paise: 1_00 }) })).status === 404)
    const tmp = ((await (await asProv({ ...pkgBody, title: `${word} throwaway`, status: 'draft' })).json()) as { id?: string }).id
    if (tmp) {
      created.packageIds.push(tmp)
      const del = await toPkg(tmp, 'DELETE')
      const { data: dRow } = await admin.from('packages').select('status, deleted_at').eq('id', tmp).single()
      check('ADR 025: the owner deletes through the route (soft delete)', del.ok && dRow?.status === 'removed' && dRow?.deleted_at !== null, `status ${del.status}`)
    } else {
      check('ADR 025: the owner creates a draft through the route', false)
    }
  }

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
  // Real slugs are [a-z0-9-] (slugify); the run tag has an underscore.
  const e6slug = `${tag.replace(/_/g, '-')}-e6prov`
  const prov = await mkUser('e6prov', ['provider'])
  const { data: pp } = await admin.from('provider_profiles').insert({ user_id: prov.uid, legal_name: 'E6 Prov', display_name: 'E6 Prov', slug: e6slug, state: 'MZ', status: 'active', languages: ['en'] }).select('id').single()
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
  const fromProv = await page(`?from_provider=${e6slug}`)
  check('FR-6.6: a provider profile → the category only', attr(fromProv, 'data-prefill-category') === 'tax-accounting' && attr(fromProv, 'data-prefill-service') === '' && attr(fromProv, 'data-entry') === 'provider')
  const junk = await page('?category=nope&service=nope&from_package=x')
  check('FR-6.6: unknown values are dropped', attr(junk, 'data-prefill-category') === '' && attr(junk, 'data-entry') === 'direct')
  const pkgPage = visible(await (await fetch(`${BASE}/p/${e6slug}/${tag}-e6pkg`)).text())
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

async function e9() {
  console.log('\nE9 — homes and retention')
  const { data: tax } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
  const buyer = await mkUser('e9buyer')
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'E9 Buyer Co', state: 'MZ', sector: 'services' }).select('id').single()
  created.msmeIds.push(msme!.id)
  await api(buyer.token, '/api/v1/legal/accept', { docs: ['terms', 'privacy'], surface: 'web', locale: 'en' })
  const prov = await mkUser('e9prov', ['provider'])
  const { data: pp } = await admin.from('provider_profiles').insert({ user_id: prov.uid, legal_name: 'E9 Rao Associates', display_name: 'E9 Rao Associates', slug: `${tag}-e9prov`, state: 'MZ', status: 'active', languages: ['en'] }).select('id').single()
  created.providerIds.push(pp!.id)
  await admin.from('provider_categories').insert({ provider_id: pp!.id, category_id: tax!.id })
  const { data: pkg } = await admin.from('packages').insert({ provider_id: pp!.id, category_id: tax!.id, slug: `${tag}-e9pkg`, title_i18n: { en: 'E9 GST filing' }, scope_included: ['x'], deliverables: ['y'], price_paise: 1000_00, delivery_days: 5, status: 'active', service_slug: 'gst-filing' }).select('id').single()
  created.packageIds.push(pkg!.id)

  const now = Date.now()
  const iso = (ms: number) => new Date(ms).toISOString()
  const istDate = (ms: number) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10)
  const mkRfq = async (title: string, status: string, extra: Record<string, unknown> = {}) => {
    const { data: r } = await admin.from('rfqs').insert({ msme_id: msme!.id, category_id: tax!.id, title, details: {}, status, expires_at: iso(now + 70 * 3600e3), fanout_at: iso(now), ...extra }).select('id').single()
    created.rfqIds.push(r!.id)
    return r!.id as string
  }
  // One fixture per kind (FR-9.1).
  const rfqA = await mkRfq('E9 GST returns FY 25-26', 'quoted', { quote_count: 2, expires_at: iso(now + 60 * 3600e3) })
  // One quote per provider per RFQ (unique): the second quote comes from a second provider.
  const prov2 = await mkUser('e9prov2', ['provider'])
  const { data: pp2 } = await admin.from('provider_profiles').insert({ user_id: prov2.uid, legal_name: 'E9 Second Firm', display_name: 'E9 Second Firm', slug: `${tag.replace(/_/g, '-')}-e9prov2`, state: 'MZ', status: 'active', languages: ['en'] }).select('id').single()
  created.providerIds.push(pp2!.id)
  const { data: qa, error: qaErr } = await admin.from('quotes').insert([
    { rfq_id: rfqA, provider_id: pp2!.id, price_paise: 4500_00, delivery_days: 3, scope: 'E9 fixture quote scope one', gst_included: false, valid_until: istDate(now + 10 * 86400e3) },
    { rfq_id: rfqA, provider_id: pp!.id, price_paise: 6000_00, delivery_days: 3, scope: 'E9 fixture quote scope two', gst_included: true, valid_until: istDate(now + 24 * 3600e3) },
  ]).select('id, price_paise')
  if (qaErr) throw new Error(`E9 quotes fixture: ${qaErr.message}`)
  const expiringQuote = (qa ?? []).find((q) => Number(q.price_paise) === 6000_00)?.id
  const rfqB = await mkRfq('E9 Factory licence', 'open')
  await admin.from('rfq_clarifications').insert({ rfq_id: rfqB, provider_id: pp!.id, question: 'Which district is the factory in?' })
  const mkOrder = async (title: string, status: OrderStatus, extra: Record<string, unknown> = {}) => {
    const { data: o, error } = await admin.from('orders').insert({
      msme_id: msme!.id, provider_id: pp!.id, source: 'package', package_id: pkg!.id, title, scope_snapshot: {},
      price_paise: 1000_00, discount_paise: 0, gst_paise: 180_00, total_paise: 1180_00, commission_bps: 1000, commission_paise: 100_00,
      provider_earning_paise: 900_00, delivery_days: 5, status, ...extra,
    }).select('id, status, created_at, due_at, auto_accept_at, external_wait_since').single()
    if (error) throw new Error(`order ${title}: ${error.message}`)
    created.orderIds.push(o!.id)
    return o!
  }
  const oAccepted = await mkOrder('E9 a Udyam registration', 'accepted')
  const oDelivered = await mkOrder('E9 b Trademark filing', 'delivered', { auto_accept_at: iso(now + 72 * 3600e3) })
  const oDisputed = await mkOrder('E9 c Payroll', 'disputed')
  const oCompleted = await mkOrder('E9 d GST filing monthly', 'completed', { completed_at: iso(now - 5 * 86400e3) })
  const oPlaced = await mkOrder('E9 e Waiting on provider', 'placed')

  const res = await fetch(`${BASE}/api/v1/me/actions`, { headers: { Authorization: `Bearer ${buyer.token}` } })
  const json = await res.json()
  const items = ((json as { buyer?: { items?: ActionItem[] } }).buyer?.items ?? [])
  check('FR-9.1: /me/actions matches the shared contract (web + mobile read this payload)', res.ok && meActionsSchema.safeParse(json).success)
  const key = (it: ActionItem) => (it.kind === 'order_action' ? `order:${it.action}` : it.kind)
  const got = items.map(key).sort()
  const want = ['clarification_question', 'order:dispute_statement', 'order:leave_review', 'order:review_delivery', 'order:share_requirements', 'quote_expiring', 'quotes_waiting'].sort()
  check('FR-9.1: exactly one row per fixture kind (the placed order waits on the provider)', JSON.stringify(got) === JSON.stringify(want) && !items.some((i) => i.objectId === oPlaced.id), got.join(','))
  const dated = items.filter((i) => i.dueAt)
  check('FR-9.1: deadline order — expiring quote, then the RFQ, then the auto-accept; undated last',
    dated.map(key).join(',') === 'quote_expiring,quotes_waiting,order:review_delivery' && items.findIndex((i) => !i.dueAt) === dated.length, items.map(key).join(','))
  const qw = items.find((i) => i.kind === 'quotes_waiting')
  check('FR-9.1: "from ₹X all-in" = the lowest normalised total (₹4,500 + GST vs ₹6,000 incl.)', qw?.kind === 'quotes_waiting' && qw.fromPaise === 5310_00, String(qw && 'fromPaise' in qw ? qw.fromPaise : ''))
  const qe = items.find((i) => i.kind === 'quote_expiring')
  check('FR-9.1: the expiring quote names its provider and the exact quote', qe?.kind === 'quote_expiring' && qe.providerName === 'E9 Rao Associates' && qe.objectId === expiringQuote && qe.href === `/app/rfq/${rfqA}`)
  const byId = new Map(items.filter((i) => i.kind === 'order_action').map((i) => [i.objectId, i]))
  const sameRule = [oAccepted, oDelivered, oDisputed, oCompleted].every((o) => {
    const a = nextAction(o.status as OrderStatus, 'buyer', { createdAt: o.created_at as string, dueAt: o.due_at as string | null, autoAcceptAt: o.auto_accept_at as string | null, externalWaitSince: o.external_wait_since as string | null, ownStatementSubmitted: false })
    const row = byId.get(o.id as string)
    return !!a && row?.action === a.action && row.dueAt === a.dueAt
  })
  check('FR-9.1: every order row is nextAction’s (what the NextStepBar shows)', sameRule)

  // The home itself (flag `home`).
  const home = await (await fetch(`${BASE}/app`, { headers: { cookie: buyer.cookie } })).text()
  const v = visible(home)
  const block = v.slice(v.indexOf('data-testid="home-actions"'), v.indexOf('data-testid="home-buy-again"'))
  // Rows can share a link (the expiring quote and its RFQ's quotes both open the RFQ), so search forward.
  const positions: number[] = []
  for (const it of items.slice(0, 5)) positions.push(block.indexOf(`href="${it.href}"`, (positions[positions.length - 1] ?? -1) + 1))
  check('FR-9.1: the home lists the first 5 rows in order, then "See all"', v.includes('data-testid="home-v3"') && positions.every((p) => p >= 0) && block.includes('href="/app/actions"'), positions.join(','))
  check('FR-9.4: the five tiles are gone; the completeness card stays under 80 %', !v.includes('📨') && !v.includes('📦') && v.includes('data-testid="home-completeness"'))
  // E18 (flag `guide`): the right rail's numbers come from these same fixtures — 2 live requirements (2 quotes),
  // 3 orders in flight (placed, accepted, delivered; the dispute is not "in progress") holding 3 × ₹1,180, 1 completed.
  if (GUIDE_ON) {
    const rail = v.slice(v.indexOf('data-testid="home-rail"'))
    const value = (k: string) => new RegExp(`data-testid="snapshot-${k}" data-value="([^"]*)"`).exec(rail)?.[1] ?? ''
    const got = ['requirements', 'in_progress', 'held', 'completed'].map(value)
    check('E18: the home rail shows the buyer\'s numbers (2 open · 2 quotes · 3 in progress · ₹3,540 held · 1 completed) and "Why AMClub"',
      v.includes('data-testid="home-rail"') && JSON.stringify(got) === JSON.stringify(['2', '3', '₹3,540', '1']) && rail.includes('2 quotes received') && rail.includes('data-testid="why-amclub"'),
      got.join(' | '))
    check('E18: the side rail carries "Post a requirement" under the menu', v.includes('data-testid="rail-card"') && v.includes('href="/app/rfq/new?entry=rail"'))
  }
  const all = visible(await (await fetch(`${BASE}/app/actions`, { headers: { cookie: buyer.cookie } })).text())
  check('FR-9.1: "See all" lists every row', all.includes('data-testid="actions-all"') && items.every((i) => all.includes(`href="${i.href}"`)))
  const me = (await (await fetch(`${BASE}/api/v1/profile/me`, { headers: { Authorization: `Bearer ${buyer.token}` } })).json()) as { homeV3Enabled?: boolean }
  check('mobile: /profile/me tells the app the home is on', me.homeV3Enabled === true)

  // FR-9.3 — Buy again at today's server price.
  await admin.from('packages').update({ price_paise: 1200_00 }).eq('id', pkg!.id)
  const ba = await fetch(`${BASE}/api/v1/orders/${oCompleted.id}/buy-again`, { headers: { Authorization: `Bearer ${buyer.token}` } })
  const bj = (await ba.json()) as { kind?: string; packageId?: string; priceChanged?: boolean; displayThen?: { taxablePaise: number; totalPaise: number }; displayNow?: Record<string, unknown>; href?: string }
  const expectNow = priceDisplay({ pricePaise: 1200_00, discountBps: 0 })
  check('FR-9.3: buy again → the same package, both prices (₹1,000 then · ₹1,200 now)', ba.ok && bj.kind === 'package' && bj.packageId === pkg!.id && bj.priceChanged === true && bj.displayThen?.taxablePaise === 1000_00 && bj.displayThen.totalPaise === 1180_00 && JSON.stringify(bj.displayNow) === JSON.stringify(expectNow) && bj.href === `/app/checkout/${pkg!.id}`)
  const home2 = visible(await (await fetch(`${BASE}/app`, { headers: { cookie: buyer.cookie } })).text())
  check('FR-9.3: the home shelf shows both prices', home2.includes('data-testid="buy-again-price-changed"') && home2.includes('₹1,000') && home2.includes('₹1,200') && home2.includes(`href="/app/checkout/${pkg!.id}"`))
  const orderPage = visible(await (await fetch(`${BASE}/app/orders/${oCompleted.id}`, { headers: { cookie: buyer.cookie } })).text())
  check('FR-9.3: the finished order offers Buy again', orderPage.includes('data-testid="order-buy-again"'))
  const co = await api(buyer.token, '/api/v1/checkout', { packageId: bj.packageId, idempotencyKey: crypto.randomUUID() })
  const cj = (await co.json()) as { amountPaise?: number; checkoutSessionId?: string }
  check('FR-9.3: checkout charges the NEW server price', co.ok && cj.amountPaise === expectNow.totalPaise, `amount ${cj.amountPaise}`)
  if (cj.checkoutSessionId) await admin.from('checkout_sessions').delete().eq('id', cj.checkoutSessionId)
  check('FR-9.3: an unfinished order → 409', (await fetch(`${BASE}/api/v1/orders/${oAccepted.id}/buy-again`, { headers: { Authorization: `Bearer ${buyer.token}` } })).status === 409)
  const other = await mkUser('e9other')
  const { data: om } = await admin.from('msme_profiles').insert({ user_id: other.uid, business_name: 'E9 Other', state: 'MZ', sector: 'services' }).select('id').single()
  created.msmeIds.push(om!.id)
  check('FR-9.3: someone else’s order → 404', (await fetch(`${BASE}/api/v1/orders/${oCompleted.id}/buy-again`, { headers: { Authorization: `Bearer ${other.token}` } })).status === 404)
  await admin.from('provider_profiles').update({ capacity_paused: true }).eq('id', pp!.id)
  const sim = (await (await fetch(`${BASE}/api/v1/orders/${oCompleted.id}/buy-again`, { headers: { Authorization: `Bearer ${buyer.token}` } })).json()) as { kind?: string; searchHref?: string }
  await admin.from('provider_profiles').update({ capacity_paused: false }).eq('id', pp!.id)
  check('FR-9.3: a paused provider → "Find similar" in search, prefilled with the service', sim.kind === 'similar' && (sim.searchHref ?? '').startsWith('/app/search?') && (sim.searchHref ?? '').includes('service=gst-filing'), sim.searchHref)

  // FR-9.3 — Repeat requirement for a quote order: the repost with service, band and must-haves.
  const rfqC = await mkRfq('E9 Monthly GST returns for our unit', 'accepted', { details: { notes: 'GSTR-1 and 3B every month', service_slug: 'gst-filing' }, budget_min_paise: 200_000, budget_max_paise: 500_000, must_haves: { credentials: ['icai'], languages: [], onSite: false, inStateOnly: true } })
  const { data: qc } = await admin.from('quotes').insert({ rfq_id: rfqC, provider_id: pp!.id, price_paise: 3000_00, delivery_days: 5, scope: 'E9 fixture accepted quote', status: 'accepted' }).select('id').single()
  const oQuote = await mkOrder('E9 f Monthly GST (quote)', 'completed', { source: 'quote', package_id: null, quote_id: qc!.id, completed_at: iso(now - 86400e3) })
  const { data: beforeC } = await admin.from('rfqs').select('title, details, status, must_haves, budget_min_paise, budget_max_paise, updated_at').eq('id', rfqC).single()
  const rep = (await (await fetch(`${BASE}/api/v1/orders/${oQuote.id}/buy-again`, { headers: { Authorization: `Bearer ${buyer.token}` } })).json()) as { kind?: string; href?: string }
  check('FR-9.3: a quote order → "Repeat requirement" (the repost)', rep.kind === 'repeat' && rep.href === `/app/rfq/new?from=${rfqC}&entry=buy_again`)
  const form = await (await fetch(`${BASE}${rep.href}`, { headers: { cookie: buyer.cookie } })).text()
  const attr = (html: string, name: string) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null
  check('FR-9.3: the form copies category, service, budget band and must-haves',
    attr(form, 'data-entry') === 'buy_again' && attr(form, 'data-prefill-category') === 'tax-accounting' && attr(form, 'data-prefill-service') === 'gst-filing' && attr(form, 'data-prefill-band') === '2kto5k' && (attr(form, 'data-prefill-must-haves') ?? '').includes('icai'))
  const again = await api(buyer.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title: beforeC!.title, details: beforeC!.details, budget_min_paise: 200_000, budget_max_paise: 500_000, must_haves: beforeC!.must_haves })
  const aj = (await again.json()) as { rfqId?: string; matched?: number }
  if (aj.rfqId) created.rfqIds.push(aj.rfqId)
  const { data: afterC } = await admin.from('rfqs').select('title, details, status, must_haves, budget_min_paise, budget_max_paise, updated_at').eq('id', rfqC).single()
  check('FR-9.3: repeating creates a NEW requirement that fans out; the original is unchanged', again.ok && !!aj.rfqId && aj.rfqId !== rfqC && (aj.matched ?? 0) >= 1 && JSON.stringify(afterC) === JSON.stringify(beforeC), `status ${again.status}, matched ${aj.matched}`)

  // Quote orders reference quotes: remove this section's orders, then the quotes.
  for (const id of created.orderIds) { await admin.from('order_events').delete().eq('order_id', id); await admin.from('orders').delete().eq('id', id) }
  for (const id of created.rfqIds) await admin.from('quotes').delete().eq('rfq_id', id)
}

async function e9b() {
  console.log('\nE9b — licences, reminders, "What do I need?" (dark, D-PRD5)')
  const cronSecret = process.env['CRON_SECRET']
  const cron = async () => (await (await fetch(`${BASE}/api/v1/cron/licence-reminders`, { headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {} })).json()) as { enabled?: boolean; sent?: number }
  const buyer = await mkUser('e9bbuyer')
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'E9b Foods', state: 'TS', sector: 'manufacturing', employee_band: '1-9' }).select('id').single()
  created.msmeIds.push(msme!.id)
  const bearer = { Authorization: `Bearer ${buyer.token}` }

  check('dark: /me/licences → 404 while obligations_enabled is off', (await fetch(`${BASE}/api/v1/me/licences`, { headers: bearer })).status === 404)
  check('dark: the reminder cron sends nothing while off', (await cron()).enabled === false)

  const restore = await setSetting('obligations_enabled', true)
  const istDate = (ms: number) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10)
  const plus = (days: number) => istDate(Date.now() + days * 86400e3)
  const reviewed: string[] = []
  let certPath: string | null = null
  const other = await mkUser('e9bother')
  const { data: om } = await admin.from('msme_profiles').insert({ user_id: other.uid, business_name: 'E9b Other', state: 'TS', sector: 'services' }).select('id').single()
  created.msmeIds.push(om!.id)
  const prov = await mkUser('e9bprov', ['provider'])
  const { data: pp } = await admin.from('provider_profiles').insert({ user_id: prov.uid, legal_name: 'E9b Prov', display_name: 'E9b Prov', slug: `${tag}-e9bprov`, state: 'TS', status: 'active', languages: ['en'] }).select('id').single()
  created.providerIds.push(pp!.id)
  try {
    const add = async (body: unknown) => {
      const r = await api(buyer.token, '/api/v1/me/licences', body)
      return { status: r.status, j: (await r.json().catch(() => ({}))) as { licence?: { id: string; daysLeft: number | null; source: string } } }
    }
    const fssai = await add({ licenceType: 'fssai', number: '10019022003456', expiresOn: plus(30), authority: 'FSSAI' })
    const factory = await add({ licenceType: 'factory_licence', expiresOn: plus(5) })
    const lapsed = await add({ licenceType: 'trade_licence', expiresOn: plus(-3) })
    const udyam = await add({ licenceType: 'udyam', number: 'UDYAM-TS-00-0000001' })
    check('FR-9.5: a buyer adds licences by hand (type, number, expiry, authority)', fssai.status === 201 && fssai.j.licence?.daysLeft === 30 && factory.status === 201 && lapsed.status === 201 && udyam.j.licence?.daysLeft === null)
    check('FR-9.5: an unknown licence type → 422', (await add({ licenceType: 'passport' })).status === 422)
    const otherList = (await (await fetch(`${BASE}/api/v1/me/licences`, { headers: { Authorization: `Bearer ${other.token}` } })).json()) as { licences?: unknown[] }
    const direct = await createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${other.token}` } }, auth: { persistSession: false } }).from('buyer_licences').select('id').eq('msme_id', msme!.id)
    check('RLS: another buyer sees none of them (API and direct)', otherList.licences?.length === 0 && (direct.data ?? []).length === 0)

    // Reminders: 60 / 30 / 7, once each — the 30-day licence gets the 30, the 5-day one only the 7, the lapsed none.
    const first = await cron()
    const second = await cron()
    const { data: rem } = await admin.from('licence_reminders').select('licence_id, threshold_days').in('licence_id', [fssai.j.licence!.id, factory.j.licence!.id, lapsed.j.licence!.id])
    const { data: notes } = await admin.from('notifications').select('kind, link').eq('user_id', buyer.uid).eq('kind', 'licence_renewal_due')
    const remKeys = (rem ?? []).map((r) => `${r.licence_id === fssai.j.licence!.id ? 'fssai' : r.licence_id === factory.j.licence!.id ? 'factory' : 'lapsed'}:${r.threshold_days}`).sort()
    check('FR-9.5: one reminder per due threshold (fssai@30, factory@7, lapsed none)', JSON.stringify(remKeys) === JSON.stringify(['factory:7', 'fssai:30']), remKeys.join(','))
    check('FR-9.5: exactly once — the second cron run sends nothing', (first.sent ?? 0) >= 2 && second.sent === 0 && (notes ?? []).length === 2, `first ${first.sent}, second ${second.sent}, notes ${(notes ?? []).length}`)
    check('FR-9.5: the reminder links to the category that renews it', (notes ?? []).some((n) => n.link === '/services/company-registrations/fssai-license'))

    // Coming due on the home; soft delete.
    const home = visible(await (await fetch(`${BASE}/app`, { headers: { cookie: buyer.cookie } })).text())
    check('FR-9.5: the home shows "Coming due" with Renew', home.includes('data-testid="home-coming-due"') && home.includes('href="/services/company-registrations/fssai-license"'))
    const del = await fetch(`${BASE}/api/v1/me/licences/${factory.j.licence!.id}`, { method: 'DELETE', headers: bearer })
    const { data: gone } = await admin.from('buyer_licences').select('deleted_at').eq('id', factory.j.licence!.id).single()
    const list = (await (await fetch(`${BASE}/api/v1/me/licences`, { headers: bearer })).json()) as { licences?: { id: string }[] }
    check('rule 4: removing a licence is a soft delete', del.ok && !!gone?.deleted_at && !(list.licences ?? []).some((l) => l.id === factory.j.licence!.id))

    // Certificate: private, owner-only.
    const fd = new FormData()
    fd.append('file', new Blob([Buffer.from('%PDF-1.4\n%e9b\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')], { type: 'application/pdf' }), 'fssai.pdf')
    const up = await fetch(`${BASE}/api/v1/me/licences/${fssai.j.licence!.id}/certificate`, { method: 'POST', headers: bearer, body: fd })
    const { data: withCert } = await admin.from('buyer_licences').select('certificate_path').eq('id', fssai.j.licence!.id).single()
    certPath = (withCert?.certificate_path as string | null) ?? null
    const mine = await fetch(`${BASE}/api/v1/me/licences/${fssai.j.licence!.id}/certificate`, { headers: bearer, redirect: 'manual' })
    const theirs = await fetch(`${BASE}/api/v1/me/licences/${fssai.j.licence!.id}/certificate`, { headers: { Authorization: `Bearer ${other.token}` }, redirect: 'manual' })
    check('FR-9.5: the certificate uploads to the private bucket; only the owner gets a signed link', up.status === 201 && !!certPath && [302, 307].includes(mine.status) && (mine.headers.get('location') ?? '').includes('/storage/v1/object/sign/') && theirs.status === 404, `up ${up.status}, mine ${mine.status}, theirs ${theirs.status}`)

    // From a finished registration order: the provider records, the buyer confirms.
    const { data: o } = await admin.from('orders').insert({ msme_id: msme!.id, provider_id: pp!.id, source: 'package', title: 'E9b FSSAI registration', scope_snapshot: {}, price_paise: 1000_00, gst_paise: 180_00, total_paise: 1180_00, commission_bps: 1000, commission_paise: 100_00, provider_earning_paise: 900_00, delivery_days: 5, status: 'completed', completed_at: new Date().toISOString() }).select('id').single()
    created.orderIds.push(o!.id)
    const rec = await api(prov.token, `/api/v1/orders/${o!.id}/licence-facts`, { licenceType: 'pollution_consent', number: 'TSPCB-CTO-123', expiresOn: plus(365) })
    const recByBuyer = await api(buyer.token, `/api/v1/orders/${o!.id}/licence-facts`, { licenceType: 'pollution_consent', number: 'X' })
    const conf = await add({ fromOrderId: o!.id })
    const again = await add({ fromOrderId: o!.id })
    check('FR-9.5: the provider records the certificate; only the provider may', rec.ok && recByBuyer.status === 403)
    check('FR-9.5: the buyer confirms it into a licence once (source order)', conf.status === 201 && conf.j.licence?.source === 'order' && again.status === 409)
    const orderPage = visible(await (await fetch(`${BASE}/app/orders/${o!.id}`, { headers: { cookie: buyer.cookie } })).text())
    check('FR-9.5: the order page says it is in the licences', orderPage.includes('data-testid="order-licence-facts"'))

    // "What do I need?" — only CA-reviewed rules, matched to the business, with the disclaimer.
    const obl0 = (await (await fetch(`${BASE}/api/v1/me/obligations`, { headers: bearer })).json()) as { rules?: unknown[] }
    check('FR-9.5: unreviewed rules are never shown', obl0.rules?.length === 0)
    const { data: seed } = await admin.from('obligation_rules').select('id, activity, licence_type').is('state', null).is('size_band', null).in('licence_type', ['udyam', 'factory_licence', 'trade_licence'])
    for (const r of seed ?? []) {
      reviewed.push(r.id as string)
      await admin.from('obligation_rules').update({ reviewed_by: 'E9b CA', reviewed_at: new Date().toISOString() }).eq('id', r.id)
    }
    const obl = (await (await fetch(`${BASE}/api/v1/me/obligations`, { headers: bearer })).json()) as { facts?: { activity?: string }; rules?: { licenceType: string; held: boolean; reviewedBy: string }[] }
    const got = (obl.rules ?? []).map((r) => `${r.licenceType}:${r.held}`).sort()
    check('FR-9.5: a manufacturer gets the national + manufacturing rules, marked held or not', obl.facts?.activity === 'manufacturing' && JSON.stringify(got) === JSON.stringify(['factory_licence:false', 'udyam:true']), got.join(','))
    const page = visible(await (await fetch(`${BASE}/app/obligations`, { headers: { cookie: buyer.cookie } })).text())
    check('FR-9.5: the checklist shows the business facts, the review stamp and the disclaimer', page.includes('data-testid="obligations-facts"') && page.includes('Reviewed by E9b CA') && page.includes('This is a checklist, not legal advice'))
  } finally {
    for (const id of reviewed) await admin.from('obligation_rules').update({ reviewed_by: null, reviewed_at: null }).eq('id', id)
    if (certPath) await admin.storage.from('licence-certificates').remove([certPath])
    const { data: lics } = await admin.from('buyer_licences').select('id').in('msme_id', [msme!.id, om!.id])
    const ids = (lics ?? []).map((l) => l.id as string)
    if (ids.length) await admin.from('licence_reminders').delete().in('licence_id', ids)
    await admin.from('buyer_licences').delete().in('msme_id', [msme!.id, om!.id])
    for (const id of created.orderIds) await admin.from('order_licence_facts').delete().eq('order_id', id)
    await admin.from('notifications').delete().eq('user_id', buyer.uid)
    await restore()
  }
}

async function e10() {
  console.log('\nE10 — provider onboarding v3')
  const cronSecret = process.env['CRON_SECRET']
  const cron = async () => (await (await fetch(`${BASE}/api/v1/cron/onboarding-nudges`, { headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {} })).json()) as { sent?: number }
  const cookieApi = (cookie: string, p: string, body: unknown) => fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body) })
  // A checksum-valid GSTIN issued in Telangana (code 36).
  const gstin = [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c) => `36AABCE${String(Date.now()).slice(-4)}F1Z${c}`).find((g) => isValidGstin(g))!
  const app = await mkUser('e10app')
  let providerId: string | null = null
  try {
    const needs = visible(await (await fetch(`${BASE}/partner/onboarding`, { headers: { cookie: app.cookie } })).text())
    const atStep = visible(await (await fetch(`${BASE}/partner/onboarding?step=business`, { headers: { cookie: app.cookie } })).text())
    check('FR-10.1/10.2: "What you’ll need" first; ?step= resumes at the exact step', needs.includes('data-testid="onboarding-needs"') && atStep.includes('data-step="business"'))
    const prog = await cookieApi(app.cookie, '/api/v1/profile/provider/onboarding-progress', { step: 'business', categorySlug: 'digital-marketing' })
    const { data: row } = await admin.from('provider_onboarding_progress').select('step, category_slug, submitted_at').eq('user_id', app.uid).maybeSingle()
    check('FR-10.4: each step is saved on the server', prog.ok && row?.step === 'business' && row.category_slug === 'digital-marketing' && row.submitted_at === null)

    // FR-10.3 — the stub registry fills legal name, trade name, state and date; a state that disagrees with the code is a flag.
    const v = await cookieApi(app.cookie, '/api/v1/profile/provider/kyc/verify-gstin', { gstin })
    const vj = (await v.json()) as { autofill?: GstinAutofill }
    const a = vj.autofill
    check('FR-10.3: a stub GSTIN fills 4 fields', v.ok && !!a && autofilledFields(a).length === 4 && a.active === true, JSON.stringify(a))
    check('FR-10.3: the GSTIN’s own state code is checked (a mismatch is flagged, not blocked)', !!a && a.stateMismatch === true && a.state === 'MH')

    // Submit through the ordinary route with the autofilled values.
    await api(app.token, '/api/v1/legal/accept', { docs: ['terms', 'privacy', 'provider_addendum'], surface: 'web', locale: 'en' })
    await cookieApi(app.cookie, '/api/v1/profile/provider/kyc/verify-bank', { accountNumber: '123456789012', ifsc: 'HDFC0000001', holderName: a?.legalName ?? 'E10' })
    const sub = await cookieApi(app.cookie, '/api/v1/profile/provider', { fullName: 'E10 Applicant', legalName: a?.legalName, displayName: a?.tradeName, gstin, categorySlugs: ['digital-marketing'], state: a?.state, city: 'Hyderabad', languages: ['en'], bankIfsc: 'HDFC0000001', bankAccount: '123456789012', bankHolder: a?.legalName, bankVerified: true })
    const sj = (await sub.json().catch(() => ({}))) as { providerId?: string }
    providerId = sj.providerId ?? null
    if (providerId) created.providerIds.push(providerId)
    const { data: after } = await admin.from('provider_onboarding_progress').select('submitted_at').eq('user_id', app.uid).single()
    check('FR-10.4: submitting stamps the draft done', sub.ok && !!after?.submitted_at, `status ${sub.status}`)

    const adm = await mkUser('e10admin', ['admin'])
    const q = visible(await (await fetch(`${BASE}/admin/verifications`, { headers: { cookie: adm.cookie } })).text())
    check('FR-10.3: the admin queue shows the source of each field and the state flag', q.includes(`data-testid="autofill-${providerId}"`) && q.includes(`data-testid="state-flag-${providerId}"`) && q.includes('From GST records'))
    const ov = await api(adm.token, `/api/v1/admin/verifications/${providerId}/legal-name`, { legalName: 'E10 Corrected LLP', reason: 'registry holds the old name' })
    const { data: pr } = await admin.from('provider_profiles').select('legal_name').eq('id', providerId ?? '').single()
    const { count: audits } = await admin.from('audit_logs').select('id', { count: 'exact', head: true }).eq('action', 'provider_legal_name_overridden').eq('entity_id', providerId ?? '')
    check('FR-10.3: an admin can override the locked legal name (audit-logged)', ov.ok && pr?.legal_name === 'E10 Corrected LLP' && audits === 1)
    check('FR-10.3: a non-admin cannot', (await api(app.token, `/api/v1/admin/verifications/${providerId}/legal-name`, { legalName: 'Nope Co', reason: 'nope nope' })).status === 403)
  } finally {
    if (providerId) {
      await admin.from('provider_bank_accounts').delete().eq('provider_id', providerId)
    }
    await admin.from('gstin_verifications').delete().eq('user_id', app.uid)
    await admin.from('bank_account_verifications').delete().eq('user_id', app.uid)
  }

  // FR-10.4 — the stall rule: one nudge after 24 h, none on a re-run, a second after another 24 h, never a third or after submit.
  const stalled = await mkUser('e10stall')
  const done = await mkUser('e10done')
  const ago = (h: number) => new Date(Date.now() - h * 3600e3).toISOString()
  await admin.from('provider_onboarding_progress').insert([
    { user_id: stalled.uid, step: 'credentials_bank', updated_at: ago(25), created_at: ago(26) },
    { user_id: done.uid, step: 'review', updated_at: ago(30), created_at: ago(31), submitted_at: ago(29) },
  ])
  try {
    const first = await cron()
    const second = await cron()
    const { data: n1 } = await admin.from('onboarding_nudges').select('nudge_no, step').eq('user_id', stalled.uid)
    const { data: notes } = await admin.from('notifications').select('link').eq('user_id', stalled.uid).eq('kind', 'onboarding_stalled')
    check('FR-10.4: a draft stalled 24 h gets exactly one nudge, deep-linked to its step', (first.sent ?? 0) >= 1 && second.sent === 0 && n1?.length === 1 && (notes ?? []).length === 1 && notes?.[0]?.link === '/partner/onboarding?step=credentials_bank', `first ${first.sent}, second ${second.sent}`)
    await admin.from('onboarding_nudges').update({ sent_at: ago(25) }).eq('user_id', stalled.uid)
    await cron()
    await admin.from('onboarding_nudges').update({ sent_at: ago(25) }).eq('user_id', stalled.uid)
    await cron()
    const { data: n2 } = await admin.from('onboarding_nudges').select('nudge_no').eq('user_id', stalled.uid)
    const { count: doneNudges } = await admin.from('onboarding_nudges').select('user_id', { count: 'exact', head: true }).eq('user_id', done.uid)
    check('FR-10.4: at most 2 nudges; a submitted draft gets none', n2?.length === 2 && doneNudges === 0)
  } finally {
    await admin.from('notifications').delete().in('user_id', [stalled.uid, done.uid, app.uid])
  }
}

async function e11a() {
  console.log('\nE11a — provider Today, inbox v2, view counts')
  const { data: tax } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
  const { data: gov } = await admin.from('categories').select('id').eq('slug', 'government-licensing').single()
  const buyer = await mkUser('e11buyer')
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'E11 Rao Textiles Secret Name', state: 'TS', sector: 'manufacturing', udyam_verified: true }).select('id').single()
  created.msmeIds.push(msme!.id)
  const other = await mkUser('e11other')
  const { data: om } = await admin.from('msme_profiles').insert({ user_id: other.uid, business_name: 'E11 Other', state: 'TS', sector: 'services' }).select('id').single()
  created.msmeIds.push(om!.id)
  const prov = await mkUser('e11prov', ['provider'])
  const slug = `${tag.replace(/_/g, '-')}-e11prov`
  const { data: pp } = await admin.from('provider_profiles').insert({ user_id: prov.uid, legal_name: 'E11 Prov', display_name: 'E11 Prov', slug, state: 'TS', status: 'active', languages: ['en'], next_available_on: new Date(Date.now() + 5 * 86400e3).toISOString().slice(0, 10) }).select('id').single()
  created.providerIds.push(pp!.id)
  const { data: pkg } = await admin.from('packages').insert({ provider_id: pp!.id, category_id: tax!.id, slug: `${slug}-pkg`, title_i18n: { en: 'E11 GST filing' }, scope_included: ['x'], deliverables: ['y'], price_paise: 1000_00, delivery_days: 5, status: 'active' }).select('id').single()
  created.packageIds.push(pkg!.id)
  const iso = (h: number) => new Date(Date.now() + h * 3600e3).toISOString()
  const mk = async (title: string, category: string, extra: Record<string, unknown>, msmeId = msme!.id, match = true) => {
    const { data: r } = await admin.from('rfqs').insert({ msme_id: msmeId, category_id: category, title, details: {}, status: 'open', fanout_at: iso(-2), ...extra }).select('id').single()
    created.rfqIds.push(r!.id)
    if (match) await admin.from('rfq_matches').insert({ rfq_id: r!.id, provider_id: pp!.id, notified_at: iso(-1) })
    return r!.id as string
  }
  const r1 = await mk('E11 GST returns FY 25-26', tax!.id, { expires_at: iso(9), budget_min_paise: 400_000, budget_max_paise: 600_000, attachments: [{ url: 'rfq-attachments/x/y.pdf', name: 'gstr.pdf' }] })
  const r2 = await mk('E11 Factory licence renewal', gov!.id, { expires_at: iso(40) })
  const r4 = await mk('E11 Unmatched secret request', tax!.id, { expires_at: iso(20) }, om!.id, false)
  // A paid order with anyone makes the buyer "verified" under D2 (identity verified + ≥ 1 paid order).
  const { data: paidOrder } = await admin.from('orders').insert({ msme_id: msme!.id, provider_id: pp!.id, source: 'package', package_id: pkg!.id, title: 'E11 earlier order', scope_snapshot: {}, price_paise: 1000_00, gst_paise: 180_00, total_paise: 1180_00, commission_bps: 1000, commission_paise: 100_00, provider_earning_paise: 900_00, delivery_days: 5, status: 'completed', completed_at: iso(-48) }).select('id').single()
  created.orderIds.push(paidOrder!.id)
  await admin.from('payouts').insert({ provider_id: pp!.id, order_id: paidOrder!.id, amount_paise: 900_00, status: 'scheduled', scheduled_for: new Date(Date.now() + 2 * 86400e3).toISOString().slice(0, 10) })

  const inbox = async (qs = '') => visible(await (await fetch(`${BASE}/partner/rfqs${qs}`, { headers: { cookie: prov.cookie } })).text())
  const ids = (html: string) => [r1, r2, r4].filter((id) => html.includes(`data-rfq="${id}"`))
  try {
    const all = await inbox()
    check('FR-11.2: inbox v2 lists my matches as a table', all.includes('data-testid="inbox-v3"') && ids(all).join() === [r1, r2].join(), ids(all).join())
    const cases: [string, string[]][] = [['?q=gst', [r1]], ['?closing=1', [r1]], ['?files=1', [r1]], ['?budget=5kto10k', [r1]], ['?category=government-licensing', [r2]], ['?q=secret', []], ['?state=TS&sort=closing', [r1, r2]]]
    const bad: string[] = []
    for (const [qs, want] of cases) { const got = ids(await inbox(qs)); if (got.join() !== want.join()) bad.push(`${qs} → ${got.length}`) }
    check('FR-11.2: filters, search and sort narrow my own matches — never an unmatched RFQ', bad.length === 0, bad.join('; '))
    const noBadge = await inbox('?verified=1')
    check('FR-11.3: with the D2 badge off, "verified" shows nothing', ids(noBadge).length === 0 && !noBadge.includes('data-verified="1"'))
    const restore = await setSetting('buyer_verified_badge_enabled', true)
    try {
      // r1 and r2 are both this buyer's (identity verified + a paid order) — the filter keeps both.
      const badge = await inbox('?verified=1')
      check('FR-11.3: badge on → the verified buyer’s requests, as a boolean only (no buyer name or id)', ids(badge).join() === [r1, r2].join() && badge.includes('data-verified="1"') && !badge.includes('Rao Textiles Secret Name') && !badge.includes(msme!.id), ids(badge).join())
      // Without a verified identity the same buyer (still with a paid order) is not "verified".
      await admin.from('msme_profiles').update({ udyam_verified: false }).eq('id', msme!.id)
      const unverified = await inbox('?verified=1')
      check('FR-11.3: the badge needs a verified identity — a paid order alone is not enough', ids(unverified).length === 0 && !unverified.includes('data-verified="1"'), ids(unverified).join())
    } finally {
      await admin.from('msme_profiles').update({ udyam_verified: true }).eq('id', msme!.id)
      await restore()
    }

    // FR-11.1 Today.
    const { data: q2 } = await admin.from('quotes').insert({ rfq_id: r2, provider_id: pp!.id, price_paise: 5000_00, delivery_days: 5, scope: 'E11 fixture quote scope text' }).select('id').single()
    const { data: conv } = await admin.from('conversations').insert({ context_type: 'quote', context_id: q2!.id, msme_id: msme!.id, provider_id: pp!.id }).select('id').single()
    await admin.from('messages').insert({ conversation_id: conv!.id, sender_id: buyer.uid, body: 'Can you also file the annual return?' })
    const acts = (await (await fetch(`${BASE}/api/v1/me/actions`, { headers: { Authorization: `Bearer ${prov.token}` } })).json()) as { provider?: { items?: { kind: string; objectId: string; href: string }[] } }
    const kinds = (acts.provider?.items ?? []).map((i) => i.kind)
    check('FR-11.1: provider rows include new RFQs (closing soonest first) and the buyer’s unanswered message', kinds.includes('rfq_new') && kinds.includes('buyer_message') && (acts.provider?.items ?? []).find((i) => i.kind === 'buyer_message')?.href === `/partner/rfqs/${r2}`, kinds.join(','))
    const today = visible(await (await fetch(`${BASE}/partner`, { headers: { cookie: prov.cookie } })).text())
    check('FR-11.1: Today shows what’s due, the funnel, payouts and the next-available date', today.includes('data-testid="partner-today"') && today.includes('data-testid="partner-funnel"') && today.includes('data-testid="partner-payouts"') && today.includes('data-testid="next-available"') && today.includes('₹900'))

    // N29 view beacon: once per visitor per day; never a bot; never the owner.
    const beacon = (headers: Record<string, string>) => fetch(`${BASE}/api/v1/views`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) E11Rig', ...headers }, body: JSON.stringify({ kind: 'package', id: pkg!.id }) })
    const b1 = await beacon({})
    await beacon({})
    await beacon({ 'User-Agent': 'Googlebot/2.1' })
    await beacon({ cookie: prov.cookie, 'User-Agent': 'Mozilla/5.0 OwnerBrowser' })
    const { data: vc } = await admin.from('view_counts_daily').select('views').eq('subject_kind', 'package').eq('subject_id', pkg!.id)
    check('N29: a view counts once per visitor per day, never for a bot or the owner', b1.status === 204 && (vc ?? []).reduce((a, r) => a + Number(r.views), 0) === 1, JSON.stringify(vc))
    const funnel = visible(await (await fetch(`${BASE}/partner`, { headers: { cookie: prov.cookie } })).text()).match(/data-funnel="([^"]+)"/)?.[1]
    check('N29: the funnel reads views → matched → quoted → won', funnel === '1/2/1/0', funnel ?? '')
  } finally {
    await admin.from('messages').delete().eq('sender_id', buyer.uid)
    await admin.from('conversations').delete().eq('provider_id', pp!.id)
    await admin.from('payouts').delete().eq('provider_id', pp!.id)
    await admin.from('view_counts_daily').delete().eq('provider_id', pp!.id)
    for (const id of [r1, r2, r4]) await admin.from('rfq_matches').delete().eq('rfq_id', id)
    for (const id of [r1, r2, r4]) await admin.from('quotes').delete().eq('rfq_id', id)
  }
}

async function e11b() {
  console.log('\nE11b — quote form v3 + the server preview (one number per quote, ADR-017)')
  const { data: tax } = await admin.from('categories').select('id, commission_bps').eq('slug', 'tax-accounting').single()
  const buyer = await mkUser('e11bbuyer')
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'E11b Buyer', state: 'TS', sector: 'services' }).select('id').single()
  created.msmeIds.push(msme!.id)
  await api(buyer.token, '/api/v1/legal/accept', { docs: ['terms', 'privacy'], surface: 'web', locale: 'en' })
  const mkProv = async (label: string) => {
    const u = await mkUser(label, ['provider'])
    const { data: pp } = await admin.from('provider_profiles').insert({ user_id: u.uid, legal_name: label, display_name: label, slug: `${tag.replace(/_/g, '-')}-${label}`, state: 'TS', status: 'active', languages: ['en'] }).select('id').single()
    created.providerIds.push(pp!.id)
    return { ...u, providerId: pp!.id as string }
  }
  const p1 = await mkProv('e11bp1')
  const p2 = await mkProv('e11bp2')
  const outsider = await mkProv('e11bout')
  const { data: r } = await admin.from('rfqs').insert({ msme_id: msme!.id, category_id: tax!.id, title: 'E11b GST returns', details: {}, status: 'open', fanout_at: new Date().toISOString(), expires_at: new Date(Date.now() + 48 * 3600e3).toISOString() }).select('id').single()
  const rfqId = r!.id as string
  created.rfqIds.push(rfqId)
  await admin.from('rfq_matches').insert([{ rfq_id: rfqId, provider_id: p1.providerId }, { rfq_id: rfqId, provider_id: p2.providerId }])
  const commissionBps = Number(tax!.commission_bps ?? 1000)
  const sessions: string[] = []
  try {
    const pv = await api(p1.token, `/api/v1/rfq/${rfqId}/quote/preview`, { price_paise: 4_500_00, gst_included: false })
    const pj = (await pv.json()) as { totalPaise?: number; earningPaise?: number; gstMode?: string }
    const want = quotePreview({ pricePaise: 4_500_00, gstIncluded: false, commissionBps })
    check('FR-11.4: the preview is the shared rule (₹4,500 + 18 % = ₹5,310; you receive at the category rate)', pv.ok && pj.totalPaise === 5_310_00 && pj.earningPaise === want.earningPaise && pj.gstMode === 'extra', JSON.stringify(pj))
    check('FR-11.4: only a matched provider may ask for a preview', (await api(outsider.token, `/api/v1/rfq/${rfqId}/quote/preview`, { price_paise: 4_500_00, gst_included: false })).status === 404)
    check('FR-11.4: the preview never writes', ((await admin.from('quotes').select('id').eq('rfq_id', rfqId)).data ?? []).length === 0)

    // One number: an INCLUDED quote and an UNSTATED quote — preview = compare = checkout for each.
    const { data: qi } = await admin.from('quotes').insert({ rfq_id: rfqId, provider_id: p1.providerId, price_paise: 11_800_00, delivery_days: 5, scope: 'E11b included quote scope text', gst_included: true }).select('id').single()
    const { data: qn } = await admin.from('quotes').insert({ rfq_id: rfqId, provider_id: p2.providerId, price_paise: 10_000_00, delivery_days: 4, scope: 'E11b unstated quote scope text', gst_included: null }).select('id').single()
    const cmp = (await (await fetch(`${BASE}/api/v1/rfq/${rfqId}/compare`, { headers: { Authorization: `Bearer ${buyer.token}` } })).json()) as { results?: { id: string; normalizedTotalPaise: number; flags: string[] }[] }
    const byId = new Map((cmp.results ?? []).map((x) => [x.id, x]))
    const charge = async (quoteId: string) => {
      const res = await api(buyer.token, '/api/v1/checkout', { quoteId, idempotencyKey: crypto.randomUUID() })
      const j = (await res.json().catch(() => ({}))) as { amountPaise?: number; checkoutSessionId?: string }
      if (j.checkoutSessionId) sessions.push(j.checkoutSessionId)
      return j.amountPaise
    }
    const pInc = (await (await api(p1.token, `/api/v1/rfq/${rfqId}/quote/preview`, { price_paise: 11_800_00, gst_included: true })).json()) as { totalPaise?: number }
    // One open checkout per request (`rfq_checkout_in_progress`): clear each session before the next charge.
    const clearSessions = async () => { for (const id of sessions.splice(0)) await admin.from('checkout_sessions').delete().eq('id', id) }
    const cInc = await charge(qi!.id as string)
    check('ADR-015/017: GST included — preview = compare = checkout = the quoted price', pInc.totalPaise === 11_800_00 && byId.get(qi!.id as string)?.normalizedTotalPaise === 11_800_00 && cInc === 11_800_00, `${pInc.totalPaise} / ${byId.get(qi!.id as string)?.normalizedTotalPaise} / ${cInc}`)
    await clearSessions()
    const cNull = await charge(qn!.id as string)
    const unstated = byId.get(qn!.id as string)
    check('ADR-017: GST unstated — compare shows what checkout charges (GST on top), still flagged', unstated?.normalizedTotalPaise === 11_800_00 && cNull === 11_800_00 && (unstated?.flags ?? []).includes('gst_unstated'), `${unstated?.normalizedTotalPaise} / ${cNull}`)

    // The provider page renders the v3 form (required GST, presets) for a services RFQ (sessions first: they reference the quotes).
    await clearSessions()
    const { error: qDelErr } = await admin.from('quotes').delete().eq('rfq_id', rfqId)
    if (qDelErr) console.error('  ! quote cleanup', qDelErr.message)
    const page = visible(await (await fetch(`${BASE}/partner/rfqs/${rfqId}`, { headers: { cookie: p1.cookie } })).text())
    check('FR-11.4: the quote form v3 renders its terms block', page.includes('data-testid="quote-v3-terms"'))
  } finally {
    for (const id of sessions) await admin.from('checkout_sessions').delete().eq('id', id)
    await admin.from('quotes').delete().eq('rfq_id', rfqId)
    await admin.from('rfq_matches').delete().eq('rfq_id', rfqId)
  }
}

async function e11c() {
  console.log('\nE11c — insights (privacy gates), tenders + GeM checklist (dark)')
  const { data: tax } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
  const { data: gov } = await admin.from('categories').select('id').eq('slug', 'government-licensing').single()
  const buyer = await mkUser('e11cbuyer')
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'E11c Buyer', state: 'TS', sector: 'services' }).select('id').single()
  created.msmeIds.push(msme!.id)
  const mkProv = async (label: string, display: string, cat: string) => {
    const u = await mkUser(label, ['provider'])
    const { data: pp } = await admin.from('provider_profiles').insert({ user_id: u.uid, legal_name: display, display_name: display, slug: `${tag.replace(/_/g, '-')}-${label}`, state: 'TS', status: 'active', languages: ['en'] }).select('id').single()
    created.providerIds.push(pp!.id)
    await admin.from('provider_categories').insert({ provider_id: pp!.id, category_id: cat })
    return { ...u, providerId: pp!.id as string }
  }
  const me = await mkProv('e11cme', 'E11c Me', tax!.id)
  const rival = await mkProv('e11crival', 'E11c Rival Secret Co', tax!.id)
  const govProv = await mkProv('e11cgov', 'E11c Licensing', gov!.id)
  const rfqs: string[] = []
  const alerts: string[] = []
  const { data: gem } = await admin.from('cms_pages').select('id').eq('slug', 'gem-seller-checklist').single()
  let restoreTenders: (() => Promise<void>) | null = null
  try {
    // Five RFQs I lost on price by 20 % (₹12,000 + GST vs the winner's ₹10,000 + GST), and three declined on price.
    for (let i = 0; i < 5; i++) {
      const { data: r } = await admin.from('rfqs').insert({ msme_id: msme!.id, category_id: tax!.id, title: `E11c lost ${i}`, details: {}, status: 'accepted', fanout_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400e3).toISOString() }).select('id').single()
      rfqs.push(r!.id)
      created.rfqIds.push(r!.id)
      await admin.from('quotes').insert([
        // A buyer decline as the decline route writes it (status, reason, who, when — the funnel reads updated_at).
        { rfq_id: r!.id, provider_id: me.providerId, price_paise: 12_000_00, delivery_days: 5, scope: 'E11c my quote scope text here', gst_included: false, status: i < 3 ? 'declined' : 'submitted', ...(i < 3 ? { decline_reason: 'price_high', declined_by: 'buyer', declined_at: new Date().toISOString(), updated_at: new Date().toISOString() } : {}) },
        { rfq_id: r!.id, provider_id: rival.providerId, price_paise: 10_000_00, delivery_days: 5, scope: 'E11c rival quote scope text', gst_included: false, status: 'accepted' },
      ])
    }
    const { data: pkg } = await admin.from('packages').insert({ provider_id: me.providerId, category_id: tax!.id, slug: `${tag.replace(/_/g, '-')}-e11cpkg`, title_i18n: { en: 'E11c listing' }, scope_included: ['x'], deliverables: ['y'], price_paise: 1000_00, delivery_days: 5, status: 'active' }).select('id').single()
    created.packageIds.push(pkg!.id)
    await admin.from('view_counts_daily').insert({ subject_kind: 'package', subject_id: pkg!.id, provider_id: me.providerId, day: new Date().toISOString().slice(0, 10), views: 3 })

    const ins = await fetch(`${BASE}/api/v1/partner/insights?range=30d`, { headers: { Authorization: `Bearer ${me.token}` } })
    const raw = await ins.text()
    const j = JSON.parse(raw) as { loss?: { price?: { n: number; of: number; medianPct: number | null } }; declineReasons?: { reason: string; n: number }[]; listings?: { views: number }[] }
    check('FR-11.5: "lost on price by a median of 20 %" from n = 5', ins.ok && j.loss?.price?.n === 5 && j.loss.price.medianPct === 20, JSON.stringify(j.loss))
    check('FR-11.5: decline reasons show at n ≥ 3', (j.declineReasons ?? []).some((d) => d.reason === 'price_high' && d.n === 3), JSON.stringify(j.declineReasons))
    check('FR-11.5: deltas only — no other provider’s name or price, no composite score', !raw.includes('Rival Secret') && !raw.includes('1180000') && !raw.includes('1000000') && !/score/i.test(raw))
    check('FR-11.5: listing performance counts views', (j.listings ?? []).some((l) => l.views === 3))
    // Below the gate: drop to four losses and the median disappears (the count stays).
    await admin.from('quotes').delete().eq('rfq_id', rfqs[4]!)
    const j4 = (await (await fetch(`${BASE}/api/v1/partner/insights?range=30d`, { headers: { Authorization: `Bearer ${me.token}` } })).json()) as { loss?: { price?: { n: number; medianPct: number | null } } }
    check('FR-11.5: n < 5 → the count only, never a median', j4.loss?.price?.n === 4 && j4.loss.price.medianPct === null)
    const page = visible(await (await fetch(`${BASE}/partner/insights`, { headers: { cookie: me.cookie } })).text())
    check('FR-11.5: /partner/insights renders the weekly bars and listings', page.includes('data-testid="weekly-bars"') && page.includes('data-testid="listing-performance"') && !page.includes('Rival Secret'))

    // Tenders + GeM — dark by default.
    // (provider) has a loading boundary, so a page redirect streams: assert the page itself never renders.
    check('D9: tenders are dark (feedback 404, no tenders page)', (await api(govProv.token, `/api/v1/partner/tenders/${crypto.randomUUID()}/feedback`, { verdict: 'saved' })).status === 404 && !visible(await (await fetch(`${BASE}/partner/tenders`, { headers: { cookie: govProv.cookie } })).text()).includes('data-testid="tenders-page"'))
    restoreTenders = await setSetting('tenders_enabled', true)
    const day = (d: number) => new Date(Date.now() + d * 86400e3 + 5.5 * 3600e3).toISOString().slice(0, 10)
    const { data: al } = await admin.from('tender_alerts').insert([
      { source: 'e11c', source_ref: `${tag}-a1`, title: 'E11c Supply of fire safety audit services', department: 'TS Fire Services', value_band: '5l_to_25l', closes_on: day(10), portal_url: 'https://tender.telangana.gov.in/', category_slugs: ['government-licensing'], states: ['TS'] },
      { source: 'e11c', source_ref: `${tag}-a2`, title: 'E11c Karnataka only', department: 'KA', closes_on: day(10), portal_url: 'https://kppp.karnataka.gov.in/', category_slugs: ['government-licensing'], states: ['KA'] },
      { source: 'e11c', source_ref: `${tag}-a3`, title: 'E11c Closed yesterday', department: 'TS', closes_on: day(-1), portal_url: 'https://tender.telangana.gov.in/', category_slugs: ['government-licensing'], states: [] },
    ]).select('id, source_ref')
    for (const a of al ?? []) alerts.push(a.id as string)
    const a1 = (al ?? []).find((a) => (a.source_ref as string).endsWith('-a1'))!.id as string
    const tp = await (await fetch(`${BASE}/partner/tenders`, { headers: { cookie: govProv.cookie } })).text()
    const tv = visible(tp)
    const shown = (al ?? []).filter((a) => tv.includes(`data-alert="${a.id}"`)).map((a) => (a.source_ref as string).slice(-2))
    check('FR-11.6: alerts matched by category + state, open ones only', JSON.stringify(shown) === JSON.stringify(['a1']), shown.join(','))
    check('FR-11.6: alerts only — no form, no bid / apply / submit control', !/<form/i.test(tv) && !/>\s*(Bid|Apply|Submit)\b/i.test(tv) && tv.includes('https://tender.telangana.gov.in/'))
    check('FR-11.6: a provider outside government & licensing is not eligible', visible(await (await fetch(`${BASE}/partner/tenders`, { headers: { cookie: me.cookie } })).text()).includes('data-testid="tenders-not-eligible"'))
    const fb = await api(govProv.token, `/api/v1/partner/tenders/${a1}/feedback`, { verdict: 'not_relevant' })
    const after = visible(await (await fetch(`${BASE}/partner/tenders`, { headers: { cookie: govProv.cookie } })).text())
    check('FR-11.6: "Not relevant" is stored and hides the alert', fb.ok && !after.includes(`data-alert="${a1}"`))
    const gemPage = async () => visible(await (await fetch(`${BASE}/partner/tenders/gem-checklist`, { headers: { cookie: govProv.cookie } })).text())
    const unreviewed = await gemPage()
    await admin.from('cms_pages').update({ reviewed_by: 'E11c reviewer', reviewed_at: new Date().toISOString() }).eq('id', gem!.id)
    const fresh = await gemPage()
    await admin.from('cms_pages').update({ reviewed_at: new Date(Date.now() - 200 * 86400e3).toISOString() }).eq('id', gem!.id)
    const stale = await gemPage()
    check('FR-11.6: the GeM checklist shows only within 180 days of review', unreviewed.includes('data-testid="gem-unavailable"') && fresh.includes('data-testid="gem-reviewed"') && fresh.includes('E11c reviewer') && stale.includes('data-testid="gem-unavailable"'))
  } finally {
    if (restoreTenders) await restoreTenders()
    await admin.from('cms_pages').update({ reviewed_by: null, reviewed_at: null }).eq('id', gem!.id)
    if (alerts.length) await admin.from('tender_alerts').delete().in('id', alerts)
    await admin.from('view_counts_daily').delete().eq('provider_id', me.providerId)
    for (const id of rfqs) await admin.from('quotes').delete().eq('rfq_id', id)
  }
}

async function e7() {
  console.log('\nE7 — compare v3: grouped rows, sticky header, scope on desktop (loss labels: verify-rfq criterion 10)')
  const { data: tax } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
  const buyer = await mkUser('e7buyer')
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'E7 Buyer', state: 'TS', sector: 'services' }).select('id').single()
  created.msmeIds.push(msme!.id)
  await api(buyer.token, '/api/v1/legal/accept', { docs: ['terms', 'privacy'], surface: 'web', locale: 'en' })
  const mkProv = async (label: string) => {
    const u = await mkUser(label, ['provider'])
    const { data: pp } = await admin.from('provider_profiles').insert({ user_id: u.uid, legal_name: label, display_name: `E7 ${label}`, slug: `${tag.replace(/_/g, '-')}-${label}`, state: 'TS', status: 'active', languages: ['en'] }).select('id').single()
    created.providerIds.push(pp!.id)
    return pp!.id as string
  }
  const pa = await mkProv('e7pa')
  const pb = await mkProv('e7pb')
  const pc = await mkProv('e7pc')
  const { data: r } = await admin.from('rfqs').insert({ msme_id: msme!.id, category_id: tax!.id, title: 'E7 GST returns FY 25-26', details: {}, status: 'quoted', fanout_at: new Date().toISOString(), expires_at: new Date(Date.now() + 48 * 3600e3).toISOString() }).select('id').single()
  const rfqId = r!.id as string
  created.rfqIds.push(rfqId)
  // The PRD's three quotes: A ₹4,500 + GST, B ₹3,900 unstated, C ₹5,200 incl. GST.
  const scopeA = 'E7 scope A: twelve monthly returns plus reconciliation'
  const scopeB = 'E7 scope B: twelve monthly returns only'
  const scopeC = 'E7 scope C: twelve monthly returns plus ITC matching'
  const { error: qErr } = await admin.from('quotes').insert([
    { rfq_id: rfqId, provider_id: pa, price_paise: 4_500_00, delivery_days: 4, scope: scopeA, gst_included: false, advance_percent: 0 },
    { rfq_id: rfqId, provider_id: pb, price_paise: 3_900_00, delivery_days: 6, scope: scopeB, gst_included: null, advance_percent: 60 },
    { rfq_id: rfqId, provider_id: pc, price_paise: 5_200_00, delivery_days: 3, scope: scopeC, gst_included: true, advance_percent: 20 },
  ])
  if (qErr) throw new Error(`e7 quotes: ${qErr.message}`)
  try {
    const html = visible(await (await fetch(`${BASE}/app/rfq/${rfqId}`, { headers: { cookie: buyer.cookie } })).text())
    const t0 = html.indexOf('data-testid="compare-v3-table"')
    const t1 = html.indexOf('data-testid="compare-v3-cards"')
    const table = t0 >= 0 && t1 > t0 ? html.slice(t0, t1) : ''
    check('FR-7.1: the v3 table renders with its row groups (Price · Time · Terms · Provider · Flags)', ['price', 'time', 'terms', 'provider', 'flags'].every((g) => table.includes(`data-group="${g}"`)), `table=${table.length > 0}`)
    check('FR-7.1: scope is on the desktop table (every quote)', [scopeA, scopeB, scopeC].every((x) => table.includes(x)))
    check('FR-7.1: GST state per quote — on top / not stated / included; normalised totals as checkout charges (ADR-017)',
      table.includes('+ 18 % on top') && table.includes('Not stated') && table.includes('Included in the price') && table.includes('₹5,310') && table.includes('₹4,602') && table.includes('₹5,200'))
    check('FR-7.1: facts from code — lowest total and fastest tagged, high advance flagged', table.includes('>lowest<') && table.includes('>fastest<') && table.includes('>high<'))
    check('FR-7.1: below md the same groups as cards', t1 > 0 && html.slice(t1).includes('Terms') && html.slice(t1).includes(scopeA))
    check('FR-7.4: accept stays one tap + the confirm sheet (no inline pay)', table.includes('Accept') && !html.includes('checkoutSessionId'))
  } finally {
    await admin.from('quotes').delete().eq('rfq_id', rfqId)
  }
}

async function e8() {
  console.log('\nE8a — order workspace v3: NextStepBar, section tabs, Gold Thread, provider money line')
  const buyer = await mkUser('e8buyer')
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'E8 Buyer', state: 'TS', sector: 'services' }).select('id').single()
  created.msmeIds.push(msme!.id)
  await api(buyer.token, '/api/v1/legal/accept', { docs: ['terms', 'privacy'], surface: 'web', locale: 'en' })
  const prov = await mkUser('e8prov', ['provider'])
  const { data: pp } = await admin.from('provider_profiles').insert({ user_id: prov.uid, legal_name: 'E8 Prov', display_name: 'E8 Prov', slug: `${tag.replace(/_/g, '-')}-e8prov`, state: 'TS', status: 'active', languages: ['en'] }).select('id').single()
  created.providerIds.push(pp!.id)
  const payouts: string[] = []
  const mkOrder = async (status: string, extra: Record<string, unknown> = {}) => {
    const { data: o, error } = await admin.from('orders').insert({
      msme_id: msme!.id, provider_id: pp!.id, source: 'package', title: `E8 ${status}`, scope_snapshot: {},
      price_paise: 300_000, gst_paise: 54_000, total_paise: 354_000, commission_bps: 1000, commission_paise: 30_000,
      provider_earning_paise: 270_000, delivery_days: 5, revision_max: 2, status, ...extra,
    }).select('id').single()
    if (error || !o) throw new Error(`e8 order ${status}: ${error?.message}`)
    created.orderIds.push(o.id)
    return o.id as string
  }
  const due = new Date(Date.now() + 3 * 86400e3).toISOString()
  const oWork = await mkOrder('in_progress', { due_at: due })
  const oDelivered = await mkOrder('delivered', { auto_accept_at: new Date(Date.now() + 72 * 3600e3).toISOString() })
  const oDone = await mkOrder('completed', { completed_at: new Date().toISOString() })
  const oDisputed = await mkOrder('disputed')
  for (const [oid, ev] of [[oWork, ['placed', 'accept', 'submit_requirements', 'start']], [oDelivered, ['placed', 'accept', 'submit_requirements', 'start', 'deliver']]] as const) {
    await admin.from('order_events').insert(ev.map((e) => ({ order_id: oid, event: e })))
  }
  const { data: p1 } = await admin.from('payouts').insert({ provider_id: pp!.id, order_id: oDone, amount_paise: 270_000, status: 'scheduled', scheduled_for: '2026-10-05' }).select('id').single()
  const { data: p2 } = await admin.from('payouts').insert({ provider_id: pp!.id, order_id: oDisputed, amount_paise: 270_000, status: 'held' }).select('id').single()
  for (const p of [p1, p2]) if (p) payouts.push(p.id as string)
  await admin.from('order_events').insert({ order_id: oDisputed, event: 'payout_held', payload: { reasons: ['dispute_open'] } })
  const page = async (who: { cookie: string }, path: string) => visible(await (await fetch(`${BASE}${path}`, { headers: { cookie: who.cookie } })).text())
  const panelHidden = (html: string, v: string) => { const m = html.match(new RegExp(`<div[^>]*data-panel="${v}"[^>]*>`)); return m ? / hidden=""/.test(m[0]) : null }
  try {
    const bWork = await page(buyer, `/app/orders/${oWork}`)
    check('FR-8.2: the buyer sees the one next step from the shared rule (waiting on delivery, with the deadline)', bWork.includes('data-testid="order-v3"') && bWork.includes('data-next="wait_delivery"') && bWork.includes('Work in progress'))
    check('FR-8.3: five tabs (messages stays off until E8b), every panel in the page, overview open', ['overview', 'requirements', 'work', 'documents', 'timeline'].every((v) => bWork.includes(`data-panel="${v}"`)) && !bWork.includes('data-panel="messages"') && panelHidden(bWork, 'overview') === false && panelHidden(bWork, 'timeline') === true)
    check('FR-8.3: ?tab= opens that section', panelHidden(await page(buyer, `/app/orders/${oWork}?tab=timeline`), 'timeline') === false)
    check('Gold Thread: in progress reaches Work', /data-testid="gold-thread" data-reached="2"/.test(bWork))
    check('the buyer money line: paid and held until acceptance (server paise)', bWork.includes('data-testid="buyer-money-line"') && bWork.includes('₹3,540 paid · held by AMClub until you accept'))
    const pWork = await page(prov, `/partner/orders/${oWork}`)
    check('FR-8.2: the provider must deliver — the bar opens the Work tab', pWork.includes('data-next="deliver_work"') && pWork.includes('Upload &amp; deliver'))
    check('FR-8.5 (N37): "Payment secured ✓ ₹X held by AMClub" while active', pWork.includes('data-kind="secured"') && pWork.includes('Payment secured ✓ ₹3,540 held by AMClub'))
    const bDel = await page(buyer, `/app/orders/${oDelivered}`)
    check('FR-8.2: a delivered order — Accept delivery is the one primary action, the rest in the overflow; the auto-accept consequence shows', bDel.includes('data-next="review_delivery"') && bDel.includes('Accept delivery') && bDel.includes('aria-label="More actions"') && bDel.includes('accepted for you'))
    const pDone = await page(prov, `/partner/orders/${oDone}`)
    check('FR-8.5: after completion "Payout scheduled for <date>" from the payout row', pDone.includes('data-kind="scheduled"') && pDone.includes('Payout scheduled for'))
    const pDisp = await page(prov, `/partner/orders/${oDisputed}`)
    check('FR-8.5: on hold "Payout on hold: <reason>" from the existing hold reasons', pDisp.includes('data-kind="held"') && pDisp.includes('Payout on hold: A dispute is open on this order.'))
    check('the buyer never sees the provider money line', !bWork.includes('provider-money-line') && !(await page(buyer, `/app/orders/${oDisputed}`)).includes('provider-money-line'))
  } finally {
    for (const id of payouts) await admin.from('payouts').delete().eq('id', id)
  }
}

async function e13() {
  console.log('\nE13a — mobile parity: role-aware tabs, provider listings / earnings, buyer invoices (Bearer, as the app calls them)')
  const buyer = await mkUser('e13buyer')
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'E13 Buyer', state: 'TS', sector: 'services' }).select('id').single()
  created.msmeIds.push(msme!.id)
  const mkP = async (label: string) => {
    const u = await mkUser(label, ['provider'])
    const { data: pp } = await admin.from('provider_profiles').insert({ user_id: u.uid, legal_name: label, display_name: label, slug: `${tag.replace(/_/g, '-')}-${label}`, state: 'TS', status: 'active', languages: ['en'] }).select('id').single()
    created.providerIds.push(pp!.id)
    return { ...u, providerId: pp!.id as string }
  }
  const prov = await mkP('e13prov')
  const other = await mkP('e13other')
  const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
  const mkPkg = async (providerId: string, slug: string, status: string) => {
    const { data } = await admin.from('packages').insert({ provider_id: providerId, category_id: cat!.id, slug: `${tag.replace(/_/g, '-')}-${slug}`, title_i18n: { en: `E13 ${slug}` }, price_paise: 250_000, discount_bps: 1000, delivery_days: 4, revision_count: 1, status, scope_included: ['x'], scope_excluded: [], deliverables: ['y'] }).select('id').single()
    created.packageIds.push(data!.id)
    return data!.id as string
  }
  const mine = await mkPkg(prov.providerId, 'mine', 'active')
  const theirs = await mkPkg(other.providerId, 'theirs', 'active')
  const { data: o } = await admin.from('orders').insert({ msme_id: msme!.id, provider_id: prov.providerId, source: 'package', title: 'E13 order', scope_snapshot: {}, price_paise: 250_000, gst_paise: 45_000, total_paise: 295_000, commission_bps: 1000, commission_paise: 25_000, provider_earning_paise: 225_000, delivery_days: 4, status: 'completed' }).select('id').single()
  created.orderIds.push(o!.id)
  const { data: po } = await admin.from('payouts').insert({ provider_id: prov.providerId, order_id: o!.id, amount_paise: 225_000, status: 'held' }).select('id').single()
  await admin.from('order_events').insert({ order_id: o!.id, event: 'payout_held', payload: { reasons: ['bank_unverified'] } })
  const get = async (token: string, path: string) => { const r = await api(token, path, undefined, 'GET'); return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> } }
  try {
    const me = await get(prov.token, '/api/v1/profile/me')
    check('FR-13.1: /profile/me tells the app the mobile experience is on', me.body['mobileV3Enabled'] === true)
    const ls = await get(prov.token, '/api/v1/partner/packages?locale=en')
    const ids = ((ls.body['listings'] as { id: string }[] | undefined) ?? []).map((x) => x.id)
    check('FR-13.2 listings: the provider sees their own listings only (Bearer)', ls.status === 200 && ids.includes(mine) && !ids.includes(theirs), JSON.stringify(ids))
    check('FR-13.2 listings: a buyer has no listings (403)', (await get(buyer.token, '/api/v1/partner/packages')).status === 403)
    const pause = await api(prov.token, `/api/v1/partner/packages/${mine}`, { status: 'paused' })
    const { data: afterPause } = await admin.from('packages').select('status').eq('id', mine).single()
    const resume = await api(prov.token, `/api/v1/partner/packages/${mine}`, { status: 'active' })
    const { data: afterResume } = await admin.from('packages').select('status').eq('id', mine).single()
    check('FR-13.2 listings: pause / resume from the phone (Bearer) through the web status route', pause.ok && afterPause?.status === 'paused' && resume.ok && afterResume?.status === 'active', `${pause.status}/${afterPause?.status} ${resume.status}/${afterResume?.status}`)
    const steal = await api(other.token, `/api/v1/partner/packages/${mine}`, { status: 'paused' })
    const { data: afterSteal } = await admin.from('packages').select('status').eq('id', mine).single()
    check('FR-13.2 listings: another provider cannot pause it (404, unchanged)', steal.status === 404 && afterSteal?.status === 'active', String(steal.status))
    const pay = await get(prov.token, '/api/v1/partner/payouts')
    const rows = (pay.body['payouts'] as { id: string; status: string; holdReasons: string[] }[] | undefined) ?? []
    check('FR-13.2 earnings: own payouts with the hold reasons (the web ledger)', pay.status === 200 && rows.length === 1 && rows[0]!.status === 'held' && rows[0]!.holdReasons.includes('bank_unverified'))
    check('FR-13.2 earnings: another provider sees none of them', ((await get(other.token, '/api/v1/partner/payouts')).body['payouts'] as unknown[] | undefined)?.length === 0)
    const inv = await get(buyer.token, '/api/v1/me/invoices')
    check('FR-13.3 invoices: the buyer list answers (the web rows, signed links)', inv.status === 200 && Array.isArray(inv.body['invoices']))
    check('every new route is private (no session → 401)', (await fetch(`${BASE}/api/v1/partner/payouts`)).status === 401 && (await fetch(`${BASE}/api/v1/me/invoices`)).status === 401)
  } finally {
    if (po) await admin.from('payouts').delete().eq('id', po.id)
  }
}

async function e13c() {
  console.log('\nE13c — native provider onboarding: the E10 routes answer the app\'s Bearer session')
  const gstin = [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((c) => `36AABCM${String(Date.now()).slice(-4)}F1Z${c}`).find((g) => isValidGstin(g))!
  const app = await mkUser('e13capp')
  let providerId: string | null = null
  try {
    const prog = await api(app.token, '/api/v1/profile/provider/onboarding-progress', { step: 'business', categorySlug: 'digital-marketing' })
    const { data: row } = await admin.from('provider_onboarding_progress').select('step').eq('user_id', app.uid).maybeSingle()
    check('FR-13.4: the phone saves its step on the server (the row the stall nudge reads)', prog.ok && row?.step === 'business', String(prog.status))
    const v = await api(app.token, '/api/v1/profile/provider/kyc/verify-gstin', { gstin })
    const a = ((await v.json().catch(() => ({}))) as { autofill?: GstinAutofill }).autofill
    check('FR-13.4: GSTIN autofill over Bearer (the same stub registry as the web)', v.ok && !!a && autofilledFields(a).length === 4)
    await api(app.token, '/api/v1/legal/accept', { docs: ['terms', 'privacy', 'provider_addendum'], surface: 'mobile', locale: 'en' })
    const b = await api(app.token, '/api/v1/profile/provider/kyc/verify-bank', { accountNumber: '123456789012', ifsc: 'HDFC0000001', holderName: a?.legalName ?? 'E13c' })
    check('FR-13.4: bank verification over Bearer', b.ok, String(b.status))
    const sub = await api(app.token, '/api/v1/profile/provider', { fullName: 'E13c Applicant', legalName: a?.legalName, displayName: a?.tradeName, gstin, categorySlugs: ['digital-marketing'], state: a?.state, city: 'Hyderabad', languages: ['en'], bankIfsc: 'HDFC0000001', bankAccount: '123456789012', bankHolder: a?.legalName, bankVerified: true })
    providerId = ((await sub.json().catch(() => ({}))) as { providerId?: string }).providerId ?? null
    if (providerId) created.providerIds.push(providerId)
    const { data: pp } = await admin.from('provider_profiles').select('status, user_id').eq('id', providerId ?? '').maybeSingle()
    const { data: after } = await admin.from('provider_onboarding_progress').select('submitted_at').eq('user_id', app.uid).single()
    check('FR-13.4: the phone submits the same profile the web does (under review, draft stamped done)', sub.ok && pp?.user_id === app.uid && pp?.status === 'under_review' && !!after?.submitted_at, `status ${sub.status} ${pp?.status}`)
    const anon = await fetch(`${BASE}/api/v1/profile/provider/onboarding-progress`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step: 'contact' }) })
    const bogus = await api('not-a-jwt', '/api/v1/profile/provider/kyc/verify-gstin', { gstin })
    check('FR-13.4: no session / a bad Bearer → 401', anon.status === 401 && bogus.status === 401, `${anon.status}/${bogus.status}`)
  } finally {
    if (providerId) await admin.from('provider_bank_accounts').delete().eq('provider_id', providerId)
    await admin.from('gstin_verifications').delete().eq('user_id', app.uid)
    await admin.from('bank_account_verifications').delete().eq('user_id', app.uid)
  }
}

async function e14() {
  console.log('\nE14a — language: te / ta drafts stay dark, category names in four languages')
  const flagOn = (process.env['EXP_V3_LOCALES'] ?? '').trim().toLowerCase() === 'on'
  const te = visible(await (await fetch(`${BASE}/te/services`)).text())
  if (flagOn) {
    check('FR-14.1: with EXP_V3_LOCALES on, the te drafts render on the buying path', te.includes('అన్ని సేవలు'))
  } else {
    check('FR-14.1: te drafts never render while EXP_V3_LOCALES is off (English fallback key by key)', te.includes('Browse verified providers across every category') && !te.includes('అన్ని సేవలు'))
  }
  const { data: cat } = await admin.from('categories').select('name_i18n').eq('slug', 'tax-accounting').single()
  const names = (cat?.name_i18n ?? {}) as Record<string, string>
  check('FR-14.2: category names carry te + ta (migration 0060 / seed)', names['te'] === 'పన్ను & అకౌంటింగ్' && names['ta'] === 'வரி & கணக்கியல்', JSON.stringify(names))
  check('FR-14.2: a te page shows the Telugu category name (pickI18n, en fallback per slot)', te.includes('పన్ను &amp; అకౌంటింగ్') || te.includes('పన్ను & అకౌంటింగ్'))
  const ta = visible(await (await fetch(`${BASE}/ta/services`)).text())
  check('FR-14.2: a ta page shows the Tamil category name', ta.includes('வரி &amp; கணக்கியல்') || ta.includes('வரி & கணக்கியல்'))
}

async function e14b() {
  console.log('\nE14b — notification copy from the notify namespace; voice search one language at a time')
  // FR-14.1 — a notification built from `notify.*`: en + hi exactly as before, te / ta drafts absent while the flag is off.
  const flagOn = (process.env['EXP_V3_LOCALES'] ?? '').trim().toLowerCase() === 'on'
  const { data: tax } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
  const buyer = await mkUser('e14bbuyer')
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'E14b Buyer', state: 'TS', sector: 'services' }).select('id').single()
  created.msmeIds.push(msme!.id)
  const pu = await mkUser('e14bprov', ['provider'])
  const { data: pp } = await admin.from('provider_profiles').insert({ user_id: pu.uid, legal_name: 'E14b Prov', display_name: 'E14b Prov', slug: `${tag.replace(/_/g, '-')}-e14bprov`, state: 'TS', status: 'active', languages: ['en'] }).select('id').single()
  created.providerIds.push(pp!.id)
  const { data: r } = await admin.from('rfqs').insert({ msme_id: msme!.id, category_id: tax!.id, title: 'E14b GST returns', details: {}, status: 'open', fanout_at: new Date().toISOString(), expires_at: new Date(Date.now() + 48 * 3600e3).toISOString() }).select('id').single()
  created.rfqIds.push(r!.id)
  await admin.from('rfq_matches').insert({ rfq_id: r!.id, provider_id: pp!.id })
  try {
    const ask = await api(pu.token, `/api/v1/rfq/${r!.id}/clarifications`, { question: 'Which financial year are the returns for?' })
    const { data: n } = await admin.from('notifications').select('title_i18n').eq('user_id', buyer.uid).eq('kind', 'rfq_question').maybeSingle()
    const t = (n?.title_i18n ?? {}) as Record<string, string>
    check('FR-14.1: notification copy comes from notify.* — en / hi unchanged', ask.ok && t['en'] === 'A provider asked a question' && t['hi'] === 'एक प्रदाता ने सवाल पूछा', JSON.stringify(t))
    check(flagOn ? 'FR-14.1: with EXP_V3_LOCALES on, the te / ta drafts are carried' : 'FR-14.1: te / ta drafts are not carried while EXP_V3_LOCALES is off (readers get English)', flagOn ? !!t['te'] && !!t['ta'] : !('te' in t) && !('ta' in t))
  } finally {
    await admin.from('notifications').delete().eq('user_id', buyer.uid)
    await admin.from('rfq_clarifications').delete().eq('rfq_id', r!.id)
    await admin.from('rfq_matches').delete().eq('rfq_id', r!.id)
  }

  // FR-14.5 — the keyless STT stub reports te-IN: listed but no passing eval → "type instead"; a passing eval → answered.
  // The voice route allows 3 calls a minute per user: two buyers, two calls each.
  const buyer2 = await mkUser('e14bbuyer2')
  const spoken = (who: { token: string } = buyer) => {
    const fd = new FormData()
    fd.append('audio', new Blob([new Uint8Array(2048)], { type: 'audio/webm' }), 'q.webm')
    fd.append('duration_ms', '2500')
    fd.append('mode', 'query')
    return fetch(`${BASE}/api/v1/rfq/voice-parse`, { method: 'POST', headers: { Authorization: `Bearer ${who.token}` }, body: fd })
  }
  const restores: (() => Promise<void>)[] = []
  try {
    restores.push(await setSetting('voice_search_enabled', true))
    restores.push(await setSetting('voice_search_languages', ['en', 'hi', 'te']))
    restores.push(await setSetting('voice_language_evals', {}))
    const noEval = (await (await spoken()).json()) as { query?: string | null; unsupported_language?: boolean; original_language?: string }
    check('FR-14.5: a listed language with no eval is not answered ("type instead", no parse)', noEval.unsupported_language === true && !noEval.query && noEval.original_language === 'te-IN', JSON.stringify(noEval))
    const good = { version: VOICE_EVAL_VERSION, n: 50, wer: 0.12, categoryAccuracy: 0.9, ranAt: new Date().toISOString() }
    await setSetting('voice_language_evals', { te: { ...good, n: 49 } })
    const short = (await (await spoken()).json()) as { unsupported_language?: boolean }
    check('FR-14.5: an eval under 50 queries does not count', short.unsupported_language === true)
    await setSetting('voice_language_evals', { te: good })
    const ok = (await (await spoken(buyer2)).json()) as { query?: string | null; unsupported_language?: boolean }
    check('FR-14.5: listed + a passing eval → the mic answers', !ok.unsupported_language && typeof ok.query === 'string' && ok.query.length > 0, JSON.stringify(ok))
    await setSetting('voice_search_languages', ['en', 'hi'])
    const unlisted = (await (await spoken(buyer2)).json()) as { unsupported_language?: boolean }
    check('FR-14.5: a passing eval alone is not enough — the language must be listed', unlisted.unsupported_language === true)
  } finally {
    for (const restore of restores.reverse()) await restore()
  }
}

async function e14c() {
  console.log('\nE14c — provider content translation (dark): a draft never renders; an approved slot is labelled')
  const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
  const prov = await mkUser('e14cprov', ['provider'])
  const slug = `${tag.replace(/_/g, '-')}-e14cprov`
  const about = 'We file GST returns for 12 months.'
  const { data: pp } = await admin.from('provider_profiles').insert({ user_id: prov.uid, legal_name: 'E14c Prov', display_name: 'E14c Prov', slug, state: 'TS', status: 'active', languages: ['en'], about }).select('id').single()
  created.providerIds.push(pp!.id)
  await admin.from('provider_categories').insert({ provider_id: pp!.id, category_id: cat!.id })
  const pkgSlug = `${tag.replace(/_/g, '-')}-e14cpkg`
  // An APPROVED te title (as the approve route writes it: the slot + its source) …
  const { data: pk } = await admin.from('packages').insert({
    provider_id: pp!.id, category_id: cat!.id, slug: pkgSlug, title_i18n: { en: 'E14c GST filing 12 months', te: 'E14c 12 నెలల GST ఫైలింగ్' }, i18n_sources: { title: { te: 'machine_approved' } },
    scope_included: ['x'], deliverables: ['y'], price_paise: 1000_00, delivery_days: 5, status: 'active',
  }).select('id').single()
  created.packageIds.push(pk!.id)
  // … and open DRAFTS for ta and for the About (never rendered).
  await admin.from('content_translations').insert([
    { provider_id: pp!.id, subject_kind: 'package', subject_id: pk!.id, field: 'title', lang: 'ta', source_text: 'E14c GST filing 12 months', draft_text: 'E14c DRAFT-TA 12' },
    { provider_id: pp!.id, subject_kind: 'profile', subject_id: pp!.id, field: 'about', lang: 'te', source_text: about, draft_text: 'E14c DRAFT-ABOUT 12' },
  ])
  try {
    const list = await api(prov.token, '/api/v1/partner/translations', undefined, 'GET')
    const draft = await api(prov.token, '/api/v1/partner/translations/draft', { subjectKind: 'profile', lang: 'te' })
    const approve = await api(prov.token, `/api/v1/partner/translations/${crypto.randomUUID()}/approve`, {})
    check('FR-14.3: the translation surface is dark (AGENT_ENABLED + agents_enabled.content_translate + cohort) — 404', list.status === 404 && draft.status === 404 && approve.status === 404, `${list.status}/${draft.status}/${approve.status}`)
    const te = visible(await (await fetch(`${BASE}/te/p/${slug}/${pkgSlug}`)).text())
    check('FR-14.3: an approved machine translation renders in te, labelled "Translated · View original"', te.includes('E14c 12 నెలల GST ఫైలింగ్') && te.includes('data-translated="translation"'))
    const ta = visible(await (await fetch(`${BASE}/ta/p/${slug}/${pkgSlug}`)).text())
    check('FR-14.3: a draft never renders — ta shows the English title, unlabelled', ta.includes('E14c GST filing 12 months') && !ta.includes('DRAFT-TA') && !ta.includes('data-translated'))
    const prof = visible(await (await fetch(`${BASE}/te/p/${slug}`)).text())
    check('FR-14.3: the About draft never renders either', prof.includes(about) && !prof.includes('DRAFT-ABOUT'))
  } finally {
    await admin.from('content_translations').delete().eq('provider_id', pp!.id)
  }
}

async function e15a() {
  console.log('\nE15a — data foundations: typed CAD features, the shadow price band + fit (shown to nobody)')
  const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
  const buyer = await mkUser('e15buyer')
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'E15 Buyer', state: 'TS', sector: 'services' }).select('id').single()
  created.msmeIds.push(msme!.id)
  await api(buyer.token, '/api/v1/legal/accept', { docs: ['terms', 'privacy'], surface: 'web', locale: 'en' })
  const prov = await mkUser('e15prov', ['provider'])
  const { data: pp } = await admin.from('provider_profiles').insert({ user_id: prov.uid, legal_name: 'E15 Prov', display_name: 'E15 Prov', slug: `${tag.replace(/_/g, '-')}-e15prov`, state: 'TS', status: 'active', languages: ['en', 'te'] }).select('id').single()
  created.providerIds.push(pp!.id)
  await admin.from('provider_categories').insert({ provider_id: pp!.id, category_id: cat!.id })
  const ops = await mkUser('e15admin', ['admin'])
  // A confirmed drawing, as document-extract writes it (the deterministic STEP parse; never a model).
  const summary = { format: 'step', product_name: 'E15 BRACKET', units: 'mm', bbox_mm: [120, 80, 10], counts: { faces: 42 }, hole_estimate: 6, layers: [], summary_english: 'A bracket', spec_rows: [] }
  const { data: ix } = await admin.from('rfq_intake_extractions').insert({ user_id: buyer.uid, kind: 'drawing', input_refs: { format: 'step' }, proposed: summary, model: null, stub: false, cost_est_paise: 0 }).select('id').single()
  const restores = [await setSetting('shadow_cad_price_band_enabled', true), await setSetting('shadow_provider_fit_enabled', true)]
  let rfqId = ''
  try {
    const bad = await api(buyer.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title: 'E15 bad spec block', details: { mfg_spec: { process: 'magic' } } })
    check('FR-15.1: a malformed mfg_spec block is refused (422)', bad.status === 422, String(bad.status))
    const res = await api(buyer.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title: 'E15 machined bracket', details: { notes: 'Bracket per drawing', mfg_spec: { process: 'cnc_machining', material: 'SS304', tolerance: '±0.05 mm' } }, intake_extraction_ids: [ix!.id] })
    const rj = (await res.json().catch(() => ({}))) as { rfqId?: string; matched?: number }
    rfqId = rj.rfqId ?? ''
    if (rfqId) created.rfqIds.push(rfqId)
    const { data: r } = await admin.from('rfqs').select('cad_features, details').eq('id', rfqId).maybeSingle()
    const cad = (r?.cad_features ?? null) as { hole_estimate?: number; bbox_mm?: number[] } | null
    check('FR-15.1: cad_features from the drawing parse (bbox, holes, counts — no product name, no prose); mfg_spec kept', res.ok && cad?.hole_estimate === 6 && cad.bbox_mm?.[0] === 120 && !JSON.stringify(cad).includes('BRACKET') && (r?.details as { mfg_spec?: { process?: string } } | null)?.mfg_spec?.process === 'cnc_machining', JSON.stringify(cad))
    const { data: preds } = await admin.from('shadow_predictions').select('feature, predicted, resolved_at').eq('subject_id', rfqId)
    const bands = (preds ?? []).filter((p) => p.feature === 'cad_price_band')
    const fits = (preds ?? []).filter((p) => p.feature === 'provider_fit')
    check('FR-15.5: at fan-out one CAD band + one fit per matched provider, all unresolved', bands.length === 1 && fits.length === (rj.matched ?? -1) && fits.some((f) => (f.predicted as { provider_id?: string }).provider_id === pp!.id) && (preds ?? []).every((p) => !p.resolved_at), `bands ${bands.length}, fits ${fits.length}, matched ${rj.matched}`)
    const asBuyer = createClient(URL_, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${buyer.token}` } } })
    const { data: leak } = await asBuyer.from('shadow_predictions').select('id').eq('subject_id', rfqId)
    check('FR-15.5: shadow_predictions is service-role only (a signed-in client reads nothing)', !leak || leak.length === 0)
    // The provider quotes ₹5,000 + GST; the buyer pays → finalize resolves the shadows.
    const { data: q } = await admin.from('quotes').insert({ rfq_id: rfqId, provider_id: pp!.id, price_paise: 5000_00, delivery_days: 5, scope: 'E15 quote scope for the bracket', gst_included: false }).select('id').single()
    const co = (await (await api(buyer.token, '/api/v1/checkout', { quoteId: q!.id, idempotencyKey: crypto.randomUUID() })).json().catch(() => ({}))) as { simulated?: boolean; checkoutSessionId?: string }
    if (co.simulated) await api(buyer.token, '/api/v1/checkout/simulate', { checkoutSessionId: co.checkoutSessionId })
    const { data: after } = await admin.from('shadow_predictions').select('feature, predicted, actual, error, resolved_at').eq('subject_id', rfqId)
    const band = (after ?? []).find((p) => p.feature === 'cad_price_band')
    const mine = (after ?? []).find((p) => p.feature === 'provider_fit' && (p.predicted as { provider_id?: string }).provider_id === pp!.id)
    const others = (after ?? []).filter((p) => p.feature === 'provider_fit' && (p.predicted as { provider_id?: string }).provider_id !== pp!.id)
    check('FR-15.5: acceptance resolves the band against the winner (₹5,900 all-in) with an error', !!band?.resolved_at && (band.actual as { total_paise?: number })?.total_paise === 5900_00 && band.error !== null, JSON.stringify(band?.actual))
    check('FR-15.5: the winner\'s fit resolves quoted + won; every other matched provider quoted = false', (mine?.actual as { quoted?: boolean; won?: boolean } | null)?.quoted === true && (mine?.actual as { won?: boolean }).won === true && others.every((p) => (p.actual as { quoted?: boolean } | null)?.quoted === false))
    const page = visible(await (await fetch(`${BASE}/admin/shadow`, { headers: { cookie: ops.cookie } })).text())
    check('FR-15.5: the weekly error report is in the admin console (admin only)', page.includes('data-feature="cad_price_band"') && page.includes('data-feature="provider_fit"') && !visible(await (await fetch(`${BASE}/admin/shadow`, { headers: { cookie: buyer.cookie } })).text()).includes('data-testid="admin-shadow"'))
  } finally {
    for (const restore of restores.reverse()) await restore()
    if (rfqId) {
      await admin.from('shadow_predictions').delete().eq('subject_id', rfqId)
      const { data: ords } = await admin.from('orders').select('id').eq('msme_id', msme!.id)
      for (const o of ords ?? []) {
        await admin.from('payouts').delete().eq('order_id', o.id)
        const { data: pays } = await admin.from('payments').select('id').eq('order_id', o.id)
        for (const pay of pays ?? []) await admin.from('refunds').delete().eq('payment_id', pay.id)
        await admin.from('payments').delete().eq('order_id', o.id)
        await admin.from('invoices').delete().eq('order_id', o.id)
        created.orderIds.push(o.id as string)
      }
      await admin.from('checkout_sessions').delete().eq('msme_id', msme!.id)
      await admin.from('conversations').delete().eq('msme_id', msme!.id)
      await admin.from('quote_events').delete().in('quote_id', ((await admin.from('quotes').select('id').eq('rfq_id', rfqId)).data ?? []).map((x) => x.id as string))
    }
    await admin.from('rfq_intake_extractions').delete().eq('user_id', buyer.uid)
    await admin.from('ai_decisions').delete().eq('decided_by', buyer.uid)
  }
}

async function e17() {
  console.log('\nE17 — analytics consent (gated D-UX2): dark unless NEXT_PUBLIC_ANALYTICS_CONSENT_REQUIRED is on')
  const on = (process.env['NEXT_PUBLIC_ANALYTICS_CONSENT_REQUIRED'] ?? '') === 'true'
  const buyer = await mkUser('e17buyer')
  const get = () => fetch(`${BASE}/api/v1/me/analytics-consent`, { headers: { cookie: buyer.cookie } })
  if (!on) {
    const home = visible(await (await fetch(`${BASE}/`)).text())
    const r = await get()
    check('E17 off: the consent route is 404 and no notice renders (PostHog loads as before)', r.status === 404 && !home.includes('data-testid="analytics-consent"'), String(r.status))
    return
  }
  const first = (await (await get()).json().catch(() => ({}))) as { choice?: string | null }
  const accept = await api(buyer.token, '/api/v1/me/analytics-consent', { choice: 'granted' })
  const afterAccept = (await (await get()).json().catch(() => ({}))) as { choice?: string | null }
  const decline = await api(buyer.token, '/api/v1/me/analytics-consent', { choice: 'denied' })
  const afterDecline = (await (await get()).json().catch(() => ({}))) as { choice?: string | null }
  const bad = await api(buyer.token, '/api/v1/me/analytics-consent', { choice: 'maybe' })
  check('E17 on: not asked yet → null; accept / decline stored for the current version; anything else 422', first.choice == null && accept.ok && afterAccept.choice === 'granted' && decline.ok && afterDecline.choice === 'denied' && bad.status === 422)
}

async function e15b() {
  console.log('\nE15b — data foundations: search telemetry + attribution, declared vs actual, consented corpora, synonyms')
  const cronSecret = process.env['CRON_SECRET']
  const { data: tax } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
  const { data: legal } = await admin.from('categories').select('id').eq('slug', 'legal').single()
  const buyer = await mkUser('e15bbuyer')
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'E15b Buyer', state: 'TS', sector: 'services' }).select('id').single()
  created.msmeIds.push(msme!.id)
  await api(buyer.token, '/api/v1/legal/accept', { docs: ['terms', 'privacy'], surface: 'web', locale: 'en' })
  const prov = await mkUser('e15bprov', ['provider'])
  const provSlug = `${tag.replace(/_/g, '-')}-e15bprov`
  const { data: pp } = await admin.from('provider_profiles').insert({ user_id: prov.uid, legal_name: 'E15b Prov', display_name: 'E15b Prov', slug: provSlug, state: 'TS', status: 'active', languages: ['en'] }).select('id').single()
  created.providerIds.push(pp!.id)
  await admin.from('provider_categories').insert({ provider_id: pp!.id, category_id: tax!.id })
  const word = `Vexmora${Date.now() % 100000}`
  const { data: pk } = await admin.from('packages').insert({ provider_id: pp!.id, category_id: tax!.id, slug: `${tag.replace(/_/g, '-')}-e15bpkg`, title_i18n: { en: `${word} GST filing` }, scope_included: ['x'], deliverables: ['y'], price_paise: 2000_00, delivery_days: 3, status: 'active' }).select('id').single()
  created.packageIds.push(pk!.id)
  const restores = [await setSetting('search_telemetry_sample_pct', 100)]
  const extraOrders: string[] = []
  try {
    // F5 — the search page mints a search id on the result links; the (100 %) sample records it, with no user id.
    const html = visible(await (await fetch(`${BASE}/services?query=${word}`, { headers: { cookie: buyer.cookie } })).text())
    const sid = /[?&]sid=([0-9a-f-]{36})/.exec(html)?.[1] ?? null
    type SearchRow = { query_norm: string | null; result_count: number; params: unknown }
    let row = null as SearchRow | null
    for (let i = 0; i < 10 && sid && !row; i++) {
      row = ((await admin.from('search_queries').select('query_norm, result_count, params').eq('id', sid).maybeSingle()).data as SearchRow | null) ?? null
      if (!row) await new Promise((r) => setTimeout(r, 300))
    }
    const found = row as SearchRow | null
    check('FR-15.3: a results page carries a search id and the sample records it (normalised query + count, no user id)', !!sid && found?.query_norm === word.toLowerCase() && (found?.result_count ?? 0) >= 1 && !JSON.stringify(found).includes(buyer.uid), JSON.stringify(found))
    // … and it rides package → checkout → the order.
    const co = (await (await api(buyer.token, '/api/v1/checkout', { packageId: pk!.id, idempotencyKey: crypto.randomUUID(), attribution: { search_id: sid, position: 1 } })).json().catch(() => ({}))) as { simulated?: boolean; checkoutSessionId?: string }
    let orderId = ''
    if (co.simulated) orderId = ((await (await api(buyer.token, '/api/v1/checkout/simulate', { checkoutSessionId: co.checkoutSessionId })).json().catch(() => ({}))) as { orderId?: string }).orderId ?? ''
    if (orderId) created.orderIds.push(orderId)
    const { data: ord } = await admin.from('orders').select('attribution').eq('id', orderId).maybeSingle()
    check('FR-15.3: the order carries the search that produced it (orders.attribution)', (ord?.attribution as { search_id?: string; position?: number } | null)?.search_id === sid && (ord?.attribution as { position?: number }).position === 1, JSON.stringify(ord?.attribution))
    const bad = await api(buyer.token, '/api/v1/checkout', { packageId: pk!.id, idempotencyKey: crypto.randomUUID(), attribution: { search_id: 'nope' } })
    check('FR-15.3: a malformed attribution is refused (422) — never stored', bad.status === 422, String(bad.status))

    // F4 — five paid orders in a category the provider did not declare → one flag for ops.
    const { data: lp } = await admin.from('packages').insert({ provider_id: pp!.id, category_id: legal!.id, slug: `${tag.replace(/_/g, '-')}-e15blegal`, title_i18n: { en: 'E15b legal notice' }, scope_included: ['x'], deliverables: ['y'], price_paise: 1000_00, delivery_days: 3, status: 'paused' }).select('id').single()
    created.packageIds.push(lp!.id)
    for (let i = 0; i < 5; i++) {
      const { data: o } = await admin.from('orders').insert({ msme_id: msme!.id, provider_id: pp!.id, package_id: lp!.id, source: 'package', title: `E15b legal ${i}`, scope_snapshot: {}, price_paise: 1000_00, gst_paise: 180_00, total_paise: 1180_00, commission_bps: 1000, commission_paise: 100_00, provider_earning_paise: 900_00, delivery_days: 3, status: 'completed' }).select('id').single()
      if (o) { extraOrders.push(o.id as string); created.orderIds.push(o.id as string) }
    }
    const cron = await fetch(`${BASE}/api/v1/cron/data-foundations`, { headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {} })
    const again = await fetch(`${BASE}/api/v1/cron/data-foundations`, { headers: cronSecret ? { Authorization: `Bearer ${cronSecret}` } : {} })
    const { data: flags } = await admin.from('audit_logs').select('after').eq('action', 'category_mismatch_flagged').eq('entity_id', pp!.id)
    check('FR-15.2: > 50 % of ≥ 5 paid orders outside the declared categories → ONE ops flag (a re-run adds none)', cron.ok && again.ok && (flags ?? []).length === 1 && (flags![0]!.after as { n?: number }).n === 6, JSON.stringify(flags))
    const ops = await mkUser('e15bops', ['admin'])
    const q = visible(await (await fetch(`${BASE}/admin/verifications`, { headers: { cookie: ops.cookie } })).text())
    const pub = visible(await (await fetch(`${BASE}/p/${provSlug}`)).text())
    check('FR-15.2: the flag is on the admin verification queue — never the public profile', q.includes(`data-flag="${pp!.id}"`) && !pub.includes('data-testid="category-flags"'))

    // F6 — consent: off by default, on keeps text-only pairs, off deletes them.
    const docExtract = { doc_type: 'gst_notice', facts: [{ k: 'notice', v: 'ASMT-10', confidence: 'high' }], suggested_category_slug: 'legal', description_english: 'A GST scrutiny notice', uncertain: false }
    const mkIntake = async () => (await admin.from('rfq_intake_extractions').insert({ user_id: buyer.uid, kind: 'document', input_refs: { attachment_path: `${buyer.uid}/e15b-notice.jpg`, mime: 'image/jpeg' }, proposed: docExtract, model: null, stub: true, cost_est_paise: 0 }).select('id').single()).data!.id as string
    const rfqBody = (intakeId: string) => ({ category_slug: 'tax-accounting', title: 'E15b reply to a GST notice', details: { notes: 'ASMT-10 reply' }, intake_extraction_ids: [intakeId] })
    const r0 = (await (await api(buyer.token, '/api/v1/rfq', rfqBody(await mkIntake()))).json().catch(() => ({}))) as { rfqId?: string }
    if (r0.rfqId) created.rfqIds.push(r0.rfqId)
    const { count: none } = await admin.from('corpus_image_pairs').select('id', { count: 'exact', head: true }).eq('user_id', buyer.uid)
    check('FR-15.4: no consent → nothing kept', none === 0)
    const dark = await api(buyer.token, '/api/v1/me/corpus-consent', { on: true })
    const prof = visible(await (await fetch(`${BASE}/app/profile`, { headers: { cookie: buyer.cookie } })).text())
    check('FR-15.4: the switch off → no opt-in on the profile and opting in 404s', dark.status === 404 && !prof.includes('data-testid="corpus-consent"'), String(dark.status))
    restores.push(await setSetting('corpus_consent_enabled', true))
    const profOn = visible(await (await fetch(`${BASE}/app/profile`, { headers: { cookie: buyer.cookie } })).text())
    check('FR-15.4: the switch on → the profile offers the opt-in, off by default', profOn.includes('data-testid="corpus-consent"'))
    const on = await api(buyer.token, '/api/v1/me/corpus-consent', { on: true })
    const r1 = (await (await api(buyer.token, '/api/v1/rfq', rfqBody(await mkIntake()))).json().catch(() => ({}))) as { rfqId?: string }
    if (r1.rfqId) created.rfqIds.push(r1.rfqId)
    const { data: pairs } = await admin.from('corpus_image_pairs').select('storage_key, corrections, final').eq('user_id', buyer.uid)
    check('FR-15.4: with consent, the image → final-request pair is kept by key with the corrected fields', on.ok && (pairs ?? []).length === 1 && pairs![0]!.storage_key === `${buyer.uid}/e15b-notice.jpg` && JSON.stringify(pairs![0]!.corrections) === '["category"]', JSON.stringify(pairs))
    const asBuyer = createClient(URL_, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${buyer.token}` } } })
    check('FR-15.4: the buyer cannot read the corpus rows directly (service role only)', ((await asBuyer.from('corpus_image_pairs').select('id')).data ?? []).length === 0)
    const off = await api(buyer.token, '/api/v1/me/corpus-consent', { on: false })
    const { count: afterOff } = await admin.from('corpus_image_pairs').select('id', { count: 'exact', head: true }).eq('user_id', buyer.uid)
    check('FR-15.4: revoking consent deletes that user\'s rows', off.ok && afterOff === 0 && ((await off.json()) as { deleted?: number }).deleted === 1)

    // F6 — service_synonyms: anyone reads reviewed rows only.
    await admin.from('service_synonyms').insert([
      { term: `${word} reviewed`, term_key: `${word.toLowerCase()} reviewed`, lang: 'en', category_slug: 'tax-accounting', service_slug: 'gst-filing', source: 'curated', reviewed: true },
      { term: `${word} draft`, term_key: `${word.toLowerCase()} draft`, lang: 'en', category_slug: 'legal', service_slug: null, source: 'search_log', reviewed: false },
    ])
    const { data: syn } = await createClient(URL_, ANON, { auth: { persistSession: false } }).from('service_synonyms').select('term_key').like('term_key', `${word.toLowerCase()}%`)
    check('FR-15.4: service_synonyms — anon reads the reviewed row, never the unreviewed one', (syn ?? []).length === 1 && syn![0]!.term_key.endsWith('reviewed'), JSON.stringify(syn))
  } finally {
    for (const restore of restores.reverse()) await restore()
    await admin.from('service_synonyms').delete().like('term_key', `${word.toLowerCase()}%`)
    await admin.from('audit_logs').delete().eq('action', 'category_mismatch_flagged').eq('entity_id', pp!.id)
    await admin.from('corpus_image_pairs').delete().eq('user_id', buyer.uid)
    await admin.from('rfq_intake_extractions').delete().eq('user_id', buyer.uid)
    await admin.from('ai_decisions').delete().eq('decided_by', buyer.uid)
    const { data: ords } = await admin.from('orders').select('id').eq('msme_id', msme!.id)
    for (const o of ords ?? []) {
      await admin.from('payouts').delete().eq('order_id', o.id)
      const { data: pays } = await admin.from('payments').select('id').eq('order_id', o.id)
      for (const pay of pays ?? []) await admin.from('refunds').delete().eq('payment_id', pay.id)
      await admin.from('payments').delete().eq('order_id', o.id)
      await admin.from('invoices').delete().eq('order_id', o.id)
      if (!created.orderIds.includes(o.id as string)) created.orderIds.push(o.id as string)
    }
    await admin.from('checkout_sessions').delete().eq('msme_id', msme!.id)
    await admin.from('search_queries').delete().eq('query_norm', word.toLowerCase())
  }
}

async function e18() {
  console.log('\nE18 — "Why AMClub", the trust strip, the assistant home (AGENT_ENABLED)')
  const services = visible(await (await fetch(`${BASE}/services`)).text())
  if (!GUIDE_ON) {
    check('E18 off: /services has no panel and no trust strip', !services.includes('data-testid="why-amclub"') && !services.includes('data-testid="trust-strip"'))
  } else {
    check('E18: the /services front page shows "Why AMClub" with both tabs, and the trust strip under the search',
      services.includes('data-testid="why-amclub"') && services.includes('data-testid="why-amclub-tab-buyers"') && services.includes('data-testid="why-amclub-tab-providers"') && services.includes('data-testid="trust-strip"'))
    const count = /data-testid="why-amclub-items" data-count="(\d+)"/.exec(services)?.[1]
    // 11 buyer promises + the Mart one only with MART_ENABLED (off on this server).
    check('E18: the buyer tab counts every buyer promise; the headline ones render first', count === '11' && services.includes('No spam calls') && services.includes('Speak, don') && services.includes('Up to 7 quotes'), String(count))
    const searching = visible(await (await fetch(`${BASE}/services?query=gst`)).text())
    check('E18: a search keeps the trust strip; the panel gives the results the width', searching.includes('data-testid="trust-strip"') && !searching.includes('data-testid="why-amclub"'))
  }

  const buyer = await mkUser('e18buyer')
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'E18 Buyer Co', state: 'MZ', sector: 'services' }).select('id').single()
  created.msmeIds.push(msme!.id)
  await api(buyer.token, '/api/v1/legal/accept', { docs: ['terms', 'privacy'], surface: 'web', locale: 'en' })
  const offPage = await fetch(`${BASE}/app/ai`, { headers: { cookie: buyer.cookie }, redirect: 'manual' })
  const offApi = await fetch(`${BASE}/api/v1/agent/assistant`, { headers: { Authorization: `Bearer ${buyer.token}` } })
  check('E18: with AGENT_ENABLED off, /app/ai and /api/v1/agent/assistant do not exist (404)', offPage.status === 404 && offApi.status === 404, `${offPage.status}/${offApi.status}`)
  if (!AGENT_BASE) return

  const page = visible(await (await fetch(`${AGENT_BASE}/app/ai`, { headers: { cookie: buyer.cookie } })).text())
  const caps = page.match(/data-capability="/g)?.length ?? 0
  check('E18: /app/ai explains the assistant — 9 capabilities with their state, what it asks first, what it never does, its settings',
    page.includes('data-testid="assistant-home"') && caps === 9 && page.includes('It always asks you first') && page.includes('It never') && page.includes('data-testid="assistant-permission"'), `capabilities ${caps}`)
  check('E18: outside the cohort only the always-on capability reads "On"', (page.match(/data-on="true"/g)?.length ?? 0) === 1 && page.includes('data-capability="voice_rfq" data-on="true"'))
  check('E18: the permission card speaks plainly (no tool names), split by what needs a tap', page.includes('Accept a quote') && page.includes('Only after you tap') && !/accept_quote|place_order|search_catalog/.test(page))
  const a = await fetch(`${AGENT_BASE}/api/v1/agent/assistant?persona=buyer`, { headers: { Authorization: `Bearer ${buyer.token}` } })
  const aj = (await a.json().catch(() => ({}))) as { on?: Record<string, boolean>; allowed?: boolean }
  check('E18: the launcher API — voice is always on, agent features off outside the cohort, not allowed yet', a.ok && aj.on?.['voice_rfq'] === true && aj.on?.['support'] === false && aj.allowed === false, JSON.stringify(aj))
  const profile = visible(await (await fetch(`${AGENT_BASE}/app/profile`, { headers: { cookie: buyer.cookie } })).text())
  check('E18: the profile page links to the assistant home instead of listing tool names', profile.includes('data-testid="assistant-profile-link"') && profile.includes('href="/app/ai"') && !profile.includes('font-mono">search_catalog'))

  const prov = await mkUser('e18prov', ['provider'])
  const { data: pp } = await admin.from('provider_profiles').insert({ user_id: prov.uid, legal_name: 'E18 Firm', display_name: 'E18 Firm', slug: `${tag.replace(/_/g, '-')}-e18prov`, state: 'MZ', status: 'active', languages: ['en'] }).select('id').single()
  created.providerIds.push(pp!.id)
  const ppage = visible(await (await fetch(`${AGENT_BASE}/partner/ai`, { headers: { cookie: prov.cookie } })).text())
  check('E18: /partner/ai lists the 6 provider capabilities (Munshi first)', ppage.includes('data-persona="provider"') && (ppage.match(/data-capability="/g)?.length ?? 0) === 6 && ppage.indexOf('data-capability="munshi"') > 0)
}

async function main() {
  console.log(`\nExperience v3 verification → ${BASE}\n`)
  // `--only=e18` (money-rigs, once the agent-on server is up): just that section.
  if (process.argv.includes('--only=e18')) {
    try { await e18() } finally { await cleanup() }
    console.log(`\n${pass} passed, ${fail} failed\n`)
    process.exit(fail ? 1 : 0)
  }
  try {
    await e0()
    await e1()
    await e3()
    await e4()
    const fx = await e2a()
    await e2b(fx)
    await e5()
    await e6()
    await e9()
    await e9b()
    await e10()
    await e11a()
    await e11b()
    await e11c()
    await e7()
    await e8()
    await e13()
    await e13c()
    await e14()
    await e14b()
    await e14c()
    await e15a()
    await e15b()
    await e17()
    await e18()
  } finally {
    await cleanup()
  }
  console.log(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail ? 1 : 0)
}

async function cleanup() {
  console.log('\n🧹 cleanup…')
  const t = async (p: PromiseLike<unknown>) => { try { const r = (await p) as { error?: { message: string } | null } | null; if (r?.error) console.error('  ! delete error', r.error.message) } catch (e) { console.error('  ! delete error', (e as Error)?.message ?? e) } }
  for (const id of created.orderIds) { await t(admin.from('order_events').delete().eq('order_id', id)); await t(admin.from('orders').delete().eq('id', id)) }
  for (const id of created.packageIds) await t(admin.from('packages').delete().eq('id', id))
  for (const id of created.rfqIds) await t(admin.from('rfqs').delete().eq('id', id))
  for (const id of created.providerIds) { await t(admin.from('provider_categories').delete().eq('provider_id', id)); await t(admin.from('provider_verifications').delete().eq('provider_id', id)); await t(admin.from('provider_public_stats').delete().eq('provider_id', id)); await t(admin.from('provider_profiles').delete().eq('id', id)) }
  for (const id of created.msmeIds) await t(admin.from('msme_profiles').delete().eq('id', id))
  for (const uid of created.users) { await t(admin.from('audit_logs').delete().eq('actor_id', uid)); await t(admin.from('users').delete().eq('id', uid)); await admin.auth.admin.deleteUser(uid).catch(() => {}) }
}

main().catch((e) => { console.error(e); process.exit(1) })
