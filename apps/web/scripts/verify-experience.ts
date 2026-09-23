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
const created: { users: string[]; providerIds: string[]; msmeIds: string[]; orderIds: string[] } = { users: [], providerIds: [], msmeIds: [], orderIds: [] }

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

  const { data: seedProv } = await admin.from('provider_profiles').select('slug').eq('status', 'active').neq('slug', `${tag}-prov`).limit(1).maybeSingle()
  if (seedProv) {
    const page = await fetch(`${BASE}/p/${seedProv.slug}`)
    const ph = await page.text()
    check('U9: the provider page shows no "Top Rated"', page.ok && !/Top Rated/i.test(ph))
    check('U4: the provider page links a requirement in its category', page.ok && ph.includes('/app/rfq/new?category='))
    const reviews = await fetch(`${BASE}/p/${seedProv.slug}/reviews`)
    check('U11: /p/[slug]/reviews renders', reviews.ok, `status ${reviews.status}`)
    const { data: pk } = await admin.from('packages').select('slug, provider:provider_profiles!inner(slug)').eq('status', 'active').limit(1).maybeSingle()
    if (pk) {
      const provSlug = (pk.provider as unknown as { slug: string }).slug
      const pkgHtml = await (await fetch(`${BASE}/p/${provSlug}/${pk.slug}`)).text()
      check('U2: no member-price line while NEXT_PUBLIC_MEMBER_PRICING_ENABLED is off', !/for members/i.test(pkgHtml))
    }
  } else {
    check('seed has an active provider', false)
  }
}

async function main() {
  console.log(`\nExperience v3 verification → ${BASE}\n`)
  try {
    await e0()
  } finally {
    console.log('\n🧹 cleanup…')
    const t = async (p: PromiseLike<unknown>) => { try { const r = (await p) as { error?: { message: string } | null } | null; if (r?.error) console.error('  ! delete error', r.error.message) } catch (e) { console.error('  ! delete error', (e as Error)?.message ?? e) } }
    for (const id of created.orderIds) { await t(admin.from('order_events').delete().eq('order_id', id)); await t(admin.from('orders').delete().eq('id', id)) }
    for (const id of created.providerIds) { await t(admin.from('provider_categories').delete().eq('provider_id', id)); await t(admin.from('provider_profiles').delete().eq('id', id)) }
    for (const id of created.msmeIds) await t(admin.from('msme_profiles').delete().eq('id', id))
    for (const uid of created.users) { await t(admin.from('users').delete().eq('id', uid)); await admin.auth.admin.deleteUser(uid).catch(() => {}) }
  }
  console.log(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
