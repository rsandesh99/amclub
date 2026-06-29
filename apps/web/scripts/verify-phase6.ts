/**
 * Phase 6 (Reviews, Notifications, Coupons, CMS) done-criteria proof against the
 * deployed app. Sets up buyer + provider + admin via the service-role client,
 * drives the real APIs with per-user Bearer tokens, and asserts all 7 criteria.
 *
 * Run: BASE_URL=https://amclub-web.vercel.app tsx scripts/verify-phase6.ts
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

const URL = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })

let pass = 0, fail = 0
const check = (n: string, ok: boolean, extra = '') => { console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++ }
const tag = `p6_${Date.now()}`
const created = { users: [] as string[], providerIds: [] as string[], msmeIds: [] as string[], packageIds: [] as string[], orderIds: [] as string[], couponIds: [] as string[], bannerIds: [] as string[] }

async function mkUser(label: string, roles: string[] = ['msme']): Promise<{ uid: string; token: string }> {
  const email = `${tag}_${label}@killtest.amclub`
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error(`${label}: ${error.message}`)
  created.users.push(data.user.id)
  await admin.from('users').insert({ id: data.user.id, email, roles })
  const anon = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
  return { uid: data.user.id, token: s.session!.access_token }
}

const api = (token: string, p: string, body?: unknown, method = 'POST') =>
  fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

async function placeOrder(buyer: { token: string }, packageId: string): Promise<string> {
  const co = await api(buyer.token, '/api/v1/checkout', { packageId, idempotencyKey: crypto.randomUUID() })
  const cod = await co.json()
  if (cod.simulated) {
    const sim = await api(buyer.token, '/api/v1/checkout/simulate', { checkoutSessionId: cod.checkoutSessionId })
    return (await sim.json()).orderId
  }
  return ''
}

async function main() {
  console.log(`\nPhase 6 verification → ${BASE}\n`)

  try {
  const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
  const categoryId = cat!.id

  // Actors
  const buyer = await mkUser('buyer')
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'P6 Buyer Co', state: 'KA', sector: 'services' }).select('id').single()
  created.msmeIds.push(msme!.id)

  const provUser = await mkUser('prov', ['provider'])
  const { data: prov } = await admin.from('provider_profiles').insert({
    user_id: provUser.uid, legal_name: 'P6 Prov', display_name: 'P6 Prov', slug: `${tag}-prov`,
    state: 'KA', status: 'active', languages: ['en'],
  }).select('id, avg_rating, review_count').single()
  created.providerIds.push(prov!.id)
  await admin.from('provider_categories').insert({ provider_id: prov!.id, category_id: categoryId })

  const adminUser = await mkUser('admin', ['admin', 'ops'])

  // Package: ₹10,000, no listing discount
  const { data: pkg } = await admin.from('packages').insert({
    provider_id: prov!.id, category_id: categoryId, slug: `${tag}-pkg`,
    title_i18n: { en: 'GST filing pkg', hi: 'जीएसटी पैकेज' },
    price_paise: 1_000_000, discount_bps: 0, delivery_days: 3, revision_count: 1, status: 'active',
    scope_included: ['Filing'], scope_excluded: [], deliverables: ['Acknowledgement'],
  }).select('id').single()
  created.packageIds.push(pkg!.id)

  // ── Drive an order to 'completed' ───────────────────────────────────────────
  const orderId = await placeOrder(buyer, pkg!.id)
  created.orderIds.push(orderId)
  await api(provUser.token, `/api/v1/orders/${orderId}/transition`, { action: 'accept' })
  await api(buyer.token, `/api/v1/orders/${orderId}/transition`, { action: 'submit_requirements' })
  await api(provUser.token, `/api/v1/orders/${orderId}/transition`, { action: 'start' })
  await api(provUser.token, `/api/v1/orders/${orderId}/transition`, { action: 'deliver' })
  await api(buyer.token, `/api/v1/orders/${orderId}/transition`, { action: 'accept_delivery' })
  const { data: completed } = await admin.from('orders').select('status').eq('id', orderId).single()

  // ── Criterion 1: review prompt + avg_rating/review_count + one reply ─────────
  const { data: prompt } = await admin.from('notifications').select('id').eq('user_id', buyer.uid).eq('kind', 'review_prompt').maybeSingle()
  const rev = await api(buyer.token, `/api/v1/orders/${orderId}/review`, { rating: 5, text: 'Excellent, very thorough.' })
  const revd = await rev.json()
  const { data: provAfter } = await admin.from('provider_profiles').select('avg_rating, review_count').eq('id', prov!.id).single()
  const reply1 = await api(provUser.token, `/api/v1/reviews/${revd.reviewId}/reply`, { reply: 'Thank you!' })
  const reply2 = await api(provUser.token, `/api/v1/reviews/${revd.reviewId}/reply`, { reply: 'Again' })
  check('1. Completed → prompt; review updates avg+count; one reply only',
    completed!.status === 'completed' && !!prompt && rev.ok && provAfter!.avg_rating === '5.0' && provAfter!.review_count === 1 && reply1.ok && reply2.status === 409,
    `status=${completed!.status} prompt=${!!prompt} avg=${provAfter!.avg_rating} count=${provAfter!.review_count} reply1=${reply1.status} reply2=${reply2.status}`)

  // ── Criterion 2: no double review; no review on non-completed; RLS enforced ──
  const dup = await api(buyer.token, `/api/v1/orders/${orderId}/review`, { rating: 4 })
  const placedOrderId = await placeOrder(buyer, pkg!.id) // stays 'placed'
  created.orderIds.push(placedOrderId)
  const onPlaced = await api(buyer.token, `/api/v1/orders/${placedOrderId}/review`, { rating: 5 })
  // Direct RLS probe: user-token insert on the placed order must be rejected.
  const buyerDb = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${buyer.token}` } }, auth: { persistSession: false } })
  const { error: rlsErr } = await buyerDb.from('reviews').insert({ order_id: placedOrderId, msme_id: msme!.id, provider_id: prov!.id, rating: 5 })
  check('2. Double review blocked; non-completed blocked; RLS enforced',
    dup.status === 409 && (onPlaced.status === 409 || onPlaced.status === 403) && !!rlsErr,
    `dup=${dup.status} onPlaced=${onPlaced.status} rls=${rlsErr ? 'rejected' : 'ALLOWED!'}`)

  // ── Criterion 3: flag → /admin/reviews queue → ops remove ───────────────────
  const flag = await api(buyer.token, `/api/v1/reviews/${revd.reviewId}/flag`, { reason: 'spam' })
  const queue = await api(adminUser.token, '/api/v1/admin/reviews?status=flagged', undefined, 'GET')
  const queued = ((await queue.json()).reviews ?? []).some((r: { id: string }) => r.id === revd.reviewId)
  const remove = await api(adminUser.token, `/api/v1/admin/reviews/${revd.reviewId}`, { action: 'remove' })
  const { data: provRemoved } = await admin.from('provider_profiles').select('avg_rating, review_count').eq('id', prov!.id).single()
  check('3. Flag routes to admin queue; ops removes; rating recomputed',
    flag.ok && queued && remove.ok && provRemoved!.review_count === 0 && provRemoved!.avg_rating === '0.0',
    `flag=${flag.status} queued=${queued} remove=${remove.status} count→${provRemoved!.review_count} avg→${provRemoved!.avg_rating}`)

  // ── Criterion 4: notifications (locale, unread, mark-read), email + stubs ────
  const { data: placedRows } = await admin.from('notifications').select('channels, title_i18n').eq('user_id', provUser.uid).eq('kind', 'order_placed').order('created_at', { ascending: false }).limit(1)
  const placedNotif = placedRows?.[0]
  const list1 = await (await api(buyer.token, '/api/v1/notifications', undefined, 'GET')).json()
  const unreadBefore = list1.unread
  await api(buyer.token, '/api/v1/notifications/read', { all: true })
  const list2 = await (await api(buyer.token, '/api/v1/notifications', undefined, 'GET')).json()
  const localeReady = !!placedNotif?.title_i18n?.hi && !!placedNotif?.title_i18n?.en
  const stubChannels = (placedNotif?.channels ?? []).includes('sms') && (placedNotif?.channels ?? []).includes('whatsapp')
  const emailConfigured = !!process.env['RESEND_API_KEY']
  check('4. In-app notifications (bi-locale), unread→mark-read, SMS/WhatsApp stubbed',
    unreadBefore > 0 && list2.unread === 0 && localeReady && stubChannels,
    `unread ${unreadBefore}→${list2.unread} biLocale=${localeReady} stubCh=${stubChannels} email=${emailConfigured ? 'Resend live' : 'stub-log'}`)

  // ── Criterion 5: coupon — exact paise, cap/limit/validity, redemption, reject ─
  const future = new Date(Date.now() + 7 * 86400000).toISOString()
  const past = new Date(Date.now() - 1000).toISOString()
  const mkCoupon = (body: Record<string, unknown>) => api(adminUser.token, '/api/v1/admin/coupons', body)
  const c1 = await (await mkCoupon({ code: `${tag}-SAVE`, kind: 'percent', value: 10, maxDiscountRupees: 100, validFrom: new Date(Date.now() - 1000).toISOString(), validTo: future, usageLimit: 1 })).json()
  if (c1.coupon) created.couponIds.push(c1.coupon.id)
  const c2 = await (await mkCoupon({ code: `${tag}-OLD`, kind: 'percent', value: 20, validFrom: new Date(Date.now() - 2 * 86400000).toISOString(), validTo: past })).json()
  if (c2.coupon) created.couponIds.push(c2.coupon.id)

  // Validate: 10% of ₹10,000 = ₹1,000 but capped at ₹100 → 10,000 paise.
  const v = await (await api(buyer.token, '/api/v1/coupons/validate', { code: `${tag}-SAVE`, packageId: pkg!.id })).json()
  // Checkout WITH the coupon and assert the frozen discount + redemption.
  const coCoupon = await api(buyer.token, '/api/v1/checkout', { packageId: pkg!.id, couponCode: `${tag}-SAVE`, idempotencyKey: crypto.randomUUID() })
  const coCouponD = await coCoupon.json()
  let couponOrderId = ''
  if (coCouponD.simulated) couponOrderId = (await (await api(buyer.token, '/api/v1/checkout/simulate', { checkoutSessionId: coCouponD.checkoutSessionId })).json()).orderId
  created.orderIds.push(couponOrderId)
  const { data: couponOrder } = await admin.from('orders').select('discount_paise').eq('id', couponOrderId).maybeSingle()
  const { data: redemption } = await admin.from('coupon_redemptions').select('order_id').eq('order_id', couponOrderId).maybeSingle()
  const { data: couponRow } = await admin.from('coupons').select('used_count').eq('id', c1.coupon.id).single()
  const overLimit = await (await api(buyer.token, '/api/v1/coupons/validate', { code: `${tag}-SAVE`, packageId: pkg!.id })).json()
  const expired = await (await api(buyer.token, '/api/v1/coupons/validate', { code: `${tag}-OLD`, packageId: pkg!.id })).json()
  const invalid = await (await api(buyer.token, '/api/v1/coupons/validate', { code: 'NOPE_NOPE', packageId: pkg!.id })).json()
  check('5. Coupon: exact paise, cap+limit+validity, redemption, reject invalid/expired',
    v.ok && v.discountPaise === 10000 && Number(couponOrder?.discount_paise) === 10000 && !!redemption && couponRow!.used_count === 1 &&
      overLimit.ok === false && overLimit.error === 'coupon_usage_exceeded' && expired.error === 'coupon_expired' && invalid.error === 'coupon_not_found',
    `discount=${v.discountPaise} orderDisc=${couponOrder?.discount_paise} redeemed=${!!redemption} used=${couponRow!.used_count} overLimit=${overLimit.error} expired=${expired.error} invalid=${invalid.error}`)

  // ── Criterion 6: banner renders in slot respecting locale + dates ───────────
  const mkBanner = (body: Record<string, unknown>) => api(adminUser.token, '/api/v1/admin/cms', body)
  const bActive = await (await mkBanner({ slot: `${tag}-slot`, imageUrl: 'https://example.com/a.png', locale: 'en', startsAt: past, endsAt: future })).json()
  if (bActive.banner) created.bannerIds.push(bActive.banner.id)
  const bExpired = await (await mkBanner({ slot: `${tag}-slot`, imageUrl: 'https://example.com/b.png', locale: 'en', startsAt: new Date(Date.now() - 2 * 86400000).toISOString(), endsAt: past })).json()
  if (bExpired.banner) created.bannerIds.push(bExpired.banner.id)
  const bHi = await (await mkBanner({ slot: `${tag}-slot`, imageUrl: 'https://example.com/c.png', locale: 'hi', startsAt: past, endsAt: future })).json()
  if (bHi.banner) created.bannerIds.push(bHi.banner.id)

  const enList = await (await fetch(`${BASE}/api/v1/cms/banners?slot=${tag}-slot&locale=en`)).json()
  const enIds = (enList.banners ?? []).map((b: { id: string }) => b.id)
  const showsActive = enIds.includes(bActive.banner.id)
  const hidesExpired = !enIds.includes(bExpired.banner.id)
  const hidesOtherLocale = !enIds.includes(bHi.banner.id)
  check('6. Banner renders in slot; respects schedule + locale',
    showsActive && hidesExpired && hidesOtherLocale,
    `active=${showsActive} expiredHidden=${hidesExpired} hiHiddenForEn=${hidesOtherLocale}`)

  // ── Criterion 7: rate limiting on new write endpoints ────────────────────────
  // couponValidate = 30/1m per user → fire 36 and expect 429s.
  const statuses: number[] = []
  for (let i = 0; i < 36; i++) {
    const r = await api(buyer.token, '/api/v1/coupons/validate', { code: 'NOPE_NOPE', packageId: pkg!.id })
    statuses.push(r.status)
  }
  const throttled = statuses.filter((s) => s === 429).length
  check('7. Rate limiting active on coupon-validate (review-write shares limiter)',
    throttled > 0, `429s=${throttled}/36 (expected >0 when Upstash live)`)

  } finally {
  // ── cleanup — ALWAYS runs (even on a thrown assertion) so no residue is left ──
  console.log('\n🧹 cleanup…')
  const t = (p: PromiseLike<unknown>) => Promise.resolve(p).catch(() => {})
  for (const id of created.bannerIds) await t(admin.from('cms_banners').delete().eq('id', id))
  for (const oid of created.orderIds.filter(Boolean)) {
    await t(admin.from('coupon_redemptions').delete().eq('order_id', oid))
    await t(admin.from('reviews').delete().eq('order_id', oid))
    await t(admin.from('payouts').delete().eq('order_id', oid))
    await t(admin.from('payments').delete().eq('order_id', oid))
    await t(admin.from('invoices').delete().eq('order_id', oid))
    await t(admin.from('order_events').delete().eq('order_id', oid))
    await t(admin.from('order_documents').delete().eq('order_id', oid))
    await t(admin.from('orders').delete().eq('id', oid))
  }
  for (const mid of created.msmeIds) await t(admin.from('checkout_sessions').delete().eq('msme_id', mid))
  for (const id of created.couponIds) await t(admin.from('coupons').delete().eq('id', id))
  for (const id of created.packageIds) await t(admin.from('packages').delete().eq('id', id))
  for (const id of created.providerIds) { await t(admin.from('provider_categories').delete().eq('provider_id', id)); await t(admin.from('provider_profiles').delete().eq('id', id)) }
  for (const mid of created.msmeIds) await t(admin.from('msme_profiles').delete().eq('id', mid))
  for (const uid of created.users) { await t(admin.from('notifications').delete().eq('user_id', uid)); await t(admin.from('users').delete().eq('id', uid)); await admin.auth.admin.deleteUser(uid).catch(() => {}) }

  }
  console.log(`\n${fail === 0 ? '✅ PHASE 6 — ALL CRITERIA PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
