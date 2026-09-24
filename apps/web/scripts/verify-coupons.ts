/**
 * Audit M10 (parts 2–3) + M11 (coupons) — ADR 027 — against a server with
 * COUPONS_ENABLED=true (production has it on; CI runs this on the
 * production-flags server, :3001). Drives the real checkout with per-user Bearer
 * tokens in simulate-payment mode.
 *
 *   1. coupon create is audit-logged (coupon_create, with per_buyer_limit)
 *   2. two buyers check out at the LAST use at the same moment → exactly one
 *      200 and one 409 coupon_unavailable; the winner's order carries the
 *      discount; one redemption; a later checkout is refused too
 *   3. a per-buyer limit of 1 → a second parallel checkout of the same buyer is
 *      refused (coupon_in_checkout) and, once the first is paid, a second order
 *      is refused (coupon_per_buyer_exceeded); another buyer is unaffected
 *   4. an unusable code is ignored (full price) and leaves NO coupon on the
 *      session — nothing to redeem at payment
 *   5. the claim / record functions are not callable by a signed-in user
 *
 * Run: BASE_URL=http://localhost:3001 tsx scripts/verify-coupons.ts
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
const tag = `cpn_${Date.now()}`
const created = { users: [] as string[], providerIds: [] as string[], msmeIds: [] as string[], packageIds: [] as string[], couponIds: [] as string[] }

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
  fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) })

type Co = { status: number; body: Record<string, unknown> }
async function checkout(token: string, packageId: string, couponCode?: string): Promise<Co> {
  const r = await api(token, '/api/v1/checkout', { packageId, idempotencyKey: crypto.randomUUID(), ...(couponCode ? { couponCode } : {}) })
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> }
}
async function pay(token: string, co: Co): Promise<string | null> {
  if (!co.body['simulated'] || typeof co.body['checkoutSessionId'] !== 'string') return null
  const sim = await api(token, '/api/v1/checkout/simulate', { checkoutSessionId: co.body['checkoutSessionId'] })
  return ((await sim.json().catch(() => ({}))) as { orderId?: string }).orderId ?? null
}

async function main() {
  console.log(`\nCoupons (audit M10 / M11, ADR 027) → ${BASE}\n`)
  try {
    const adminUser = await mkUser('admin', ['admin', 'ops'])
    const probe = await api(adminUser.token, '/api/v1/admin/coupons', undefined, 'GET')
    if (probe.status === 404) {
      console.log('  ⏭ COUPONS_ENABLED is off on this server — nothing to prove here (run against the production-flags server)')
      return
    }

    const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
    const buyers: { uid: string; token: string; msmeId: string }[] = []
    for (const label of ['b1', 'b2']) {
      const u = await mkUser(label)
      const { data: m } = await admin.from('msme_profiles').insert({ user_id: u.uid, business_name: `Coupon ${label}`, state: 'KA', sector: 'services' }).select('id').single()
      created.msmeIds.push(m!.id)
      buyers.push({ ...u, msmeId: m!.id as string })
    }
    const b1 = buyers[0]!, b2 = buyers[1]!
    const provUser = await mkUser('prov', ['provider'])
    const { data: prov } = await admin.from('provider_profiles').insert({ user_id: provUser.uid, legal_name: 'Coupon Prov', display_name: 'Coupon Prov', slug: `${tag}-prov`, state: 'KA', status: 'active', languages: ['en'] }).select('id').single()
    created.providerIds.push(prov!.id)
    await admin.from('provider_categories').insert({ provider_id: prov!.id, category_id: cat!.id })
    const { data: pkg } = await admin.from('packages').insert({
      provider_id: prov!.id, category_id: cat!.id, slug: `${tag}-pkg`, title_i18n: { en: 'Coupon pkg', hi: 'कूपन' },
      price_paise: 1_000_000, discount_bps: 0, delivery_days: 3, revision_count: 1, status: 'active', scope_included: ['x'], scope_excluded: [], deliverables: ['y'],
    }).select('id').single()
    created.packageIds.push(pkg!.id)
    const packageId = pkg!.id as string

    const window = { validFrom: new Date(Date.now() - 60_000).toISOString(), validTo: new Date(Date.now() + 86_400_000).toISOString() }
    const mkCoupon = async (suffix: string, extra: Record<string, unknown>) => {
      const code = `${tag}-${suffix}`.toUpperCase()
      const r = await api(adminUser.token, '/api/v1/admin/coupons', { code, kind: 'percent', value: 10, maxDiscountRupees: 100, ...window, ...extra })
      const id = ((await r.json().catch(() => ({}))) as { coupon?: { id: string } }).coupon?.id
      if (id) created.couponIds.push(id)
      return { code, id, status: r.status }
    }

    // ── 1 (M11): the create is audit-logged with the whole row ──
    const once = await mkCoupon('ONCE', { perBuyerLimit: 1 })
    const { data: aud } = await admin.from('audit_logs').select('after').eq('actor_id', adminUser.uid).eq('action', 'coupon_create').eq('entity_id', once.id ?? '').maybeSingle()
    const after = (aud?.after ?? {}) as Record<string, unknown>
    check('1. coupon create → 200 and an audit_logs row (coupon_create) carrying the per-buyer limit', once.status === 200 && after['code'] === once.code && after['per_buyer_limit'] === 1 && after['usage_limit'] === null, `http=${once.status} after=${JSON.stringify(after)}`)

    // ── 2 (M10): the last use, twice at once ──
    const last = await mkCoupon('LAST', { usageLimit: 1 })
    const [c1, c2] = await Promise.all([checkout(b1.token, packageId, last.code), checkout(b2.token, packageId, last.code)])
    const winner = c1.status === 200 ? { co: c1, buyer: b1 } : c2.status === 200 ? { co: c2, buyer: b2 } : null
    const loser = c1.status === 200 ? c2 : c1
    const statuses = [c1.status, c2.status].sort().join(',')
    check('2a. two checkouts at the last use: exactly one 200, one 409 coupon_unavailable (coupon_usage_exceeded), and the loser has no payment open',
      statuses === '200,409' && loser.body['code'] === 'coupon_unavailable' && loser.body['couponError'] === 'coupon_usage_exceeded' && !loser.body['razorpayOrderId'],
      `statuses=${statuses} loser=${JSON.stringify(loser.body)}`)
    const orderId = winner ? await pay(winner.buyer.token, winner.co) : null
    const { data: ord } = orderId ? await admin.from('orders').select('discount_paise').eq('id', orderId).maybeSingle() : { data: null }
    const { data: lastRow } = await admin.from('coupons').select('used_count').eq('id', last.id ?? '').maybeSingle()
    const { count: lastRedemptions } = await admin.from('coupon_redemptions').select('order_id', { count: 'exact', head: true }).eq('coupon_id', last.id ?? '')
    check('2b. the winner pays: the order carries the ₹100 discount; used_count 1; one redemption row',
      !!orderId && Number(ord?.discount_paise) === 10_000 && lastRow?.used_count === 1 && lastRedemptions === 1,
      `order=${orderId} discount=${ord?.discount_paise} used=${lastRow?.used_count} redemptions=${lastRedemptions}`)
    const third = await checkout(b2.token, packageId, last.code)
    check('2c. after the last use is redeemed, another checkout with the code → 409 coupon_unavailable', third.status === 409 && third.body['code'] === 'coupon_unavailable', `http=${third.status} ${JSON.stringify(third.body)}`)

    // ── 3 (M10): one use per buyer ──
    const o1 = await checkout(b1.token, packageId, once.code)
    const o2 = await checkout(b1.token, packageId, once.code)
    check('3a. per-buyer limit 1: a second parallel checkout of the same buyer (first unpaid) → 409 coupon_in_checkout', o1.status === 200 && o2.status === 409 && o2.body['couponError'] === 'coupon_in_checkout', `first=${o1.status} second=${o2.status}:${String(o2.body['couponError'])}`)
    const paid1 = await pay(b1.token, o1)
    const val = (await (await api(b1.token, '/api/v1/coupons/validate', { code: once.code, packageId })).json().catch(() => ({}))) as { ok?: boolean; error?: string }
    const o3 = await checkout(b1.token, packageId, once.code)
    check('3b. once the first order is paid, validate says coupon_per_buyer_exceeded and a second order → 409 (coupon_per_buyer_exceeded)',
      !!paid1 && val.ok === false && val.error === 'coupon_per_buyer_exceeded' && o3.status === 409 && o3.body['couponError'] === 'coupon_per_buyer_exceeded',
      `paid=${paid1} validate=${JSON.stringify(val)} second=${o3.status}:${String(o3.body['couponError'])}`)
    const other = await checkout(b2.token, packageId, once.code)
    check('3c. the limit is per buyer: another buyer still gets the coupon (200)', other.status === 200, `http=${other.status} ${JSON.stringify(other.body)}`)

    // ── 4 (M10): an unusable code leaves no phantom redemption ──
    const bogus = await checkout(b2.token, packageId, `${tag}-NOPE`)
    const { data: bogusSess } = typeof bogus.body['checkoutSessionId'] === 'string'
      ? await admin.from('checkout_sessions').select('coupon_code, discount_paise, coupon_claimed_at').eq('id', bogus.body['checkoutSessionId']).maybeSingle()
      : { data: null }
    check('4. an unknown code is ignored (200, full price) and the session carries no coupon to redeem',
      bogus.status === 200 && !!bogusSess && bogusSess.coupon_code === null && Number(bogusSess.discount_paise) === 0 && bogusSess.coupon_claimed_at === null,
      `http=${bogus.status} session=${JSON.stringify(bogusSess)}`)

    // ── 5: the functions are the server's ──
    const asBuyer = createClient(URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${b1.token}` } } })
    const claimRpc = await asBuyer.rpc('claim_coupon_for_session', { p_session_id: String(o1.body['checkoutSessionId'] ?? crypto.randomUUID()) })
    const recordRpc = await asBuyer.rpc('record_coupon_redemption', { p_order_id: paid1 ?? crypto.randomUUID() })
    check('5. a signed-in buyer cannot call claim_coupon_for_session or record_coupon_redemption', !!claimRpc.error && !!recordRpc.error, `claim=${claimRpc.error?.code ?? 'ALLOWED'} record=${recordRpc.error?.code ?? 'ALLOWED'}`)
  } finally {
    console.log('\n🧹 cleanup…')
    const t = async (p: PromiseLike<unknown>) => { try { const r = (await p) as { error?: { message: string } | null } | null; if (r?.error) console.error('  ! cleanup', r.error.message) } catch (e) { console.error('  ! cleanup', (e as Error)?.message ?? e) } }
    for (const mid of created.msmeIds) {
      const { data: orders } = await admin.from('orders').select('id').eq('msme_id', mid)
      await t(admin.from('checkout_sessions').delete().eq('msme_id', mid))
      for (const o of orders ?? []) {
        await t(admin.from('coupon_redemptions').delete().eq('order_id', o.id))
        await t(admin.from('payouts').delete().eq('order_id', o.id))
        const { data: pays } = await admin.from('payments').select('id').eq('order_id', o.id)
        for (const pay of pays ?? []) await t(admin.from('refunds').delete().eq('payment_id', pay.id))
        await t(admin.from('payments').delete().eq('order_id', o.id))
        await t(admin.from('invoices').delete().eq('order_id', o.id))
        await t(admin.from('order_events').delete().eq('order_id', o.id))
        await t(admin.from('orders').delete().eq('id', o.id))
      }
    }
    for (const id of created.couponIds) await t(admin.from('coupons').delete().eq('id', id))
    for (const id of created.packageIds) await t(admin.from('packages').delete().eq('id', id))
    for (const id of created.providerIds) { await t(admin.from('provider_categories').delete().eq('provider_id', id)); await t(admin.from('provider_profiles').delete().eq('id', id)) }
    for (const mid of created.msmeIds) await t(admin.from('msme_profiles').delete().eq('id', mid))
    for (const uid of created.users) {
      await t(admin.from('audit_logs').delete().eq('actor_id', uid))
      await t(admin.from('notifications').delete().eq('user_id', uid))
      await t(admin.from('users').delete().eq('id', uid))
      await admin.auth.admin.deleteUser(uid).catch(() => {})
    }
  }
  console.log(`\n${fail === 0 ? '✅ COUPONS — ALL CRITERIA PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
