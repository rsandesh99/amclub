/**
 * Phase 8 §7/§8 verification against the DEPLOYED app:
 *  1. Emergency takedown: suspend a kill-test provider → its public page must
 *     404 within 5s (revalidatePath cache-bust), then reactivate → 200 again.
 *  2. Payout monitor: failed payout appears in /api/v1/admin/payouts, retry
 *     transitions it failed → scheduled (audit-logged).
 *  3. Security headers on the production origin.
 *
 * Creates kill-test rows and removes them in `finally`.
 * Run: BASE_URL=https://amclub-web.vercel.app tsx scripts/verify-phase8.ts
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const BASE = process.env['BASE_URL'] ?? 'https://amclub-web.vercel.app'
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })

const tag = `p8_${Date.now()}`
let pass = 0
let fail = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`)
  ok ? pass++ : fail++
}

async function mkUser(label: string, roles: string[]) {
  const email = `${tag}_${label}@killtest.amclub`
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error(`${label}: ${error.message}`)
  await admin.from('users').insert({ id: data.user.id, email, roles })
  const anon = createClient(URL_, ANON, { auth: { persistSession: false } })
  const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
  return { uid: data.user.id, token: s.session!.access_token }
}

const api = (token: string, p: string, body?: unknown, method = 'POST') =>
  fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

async function main() {
  console.log(`\nPhase 8 verification → ${BASE}\n`)
  const created = { users: [] as string[], providerId: '', packageId: '', msmeId: '', orderId: '' }

  try {
    const adminUser = await mkUser('admin', ['admin', 'ops'])
    const prov = await mkUser('prov', ['provider'])
    const buyer = await mkUser('buyer', ['msme'])
    created.users.push(adminUser.uid, prov.uid, buyer.uid)

    const slug = `${tag}-prov`.replace(/_/g, '-')
    const { data: provider } = await admin.from('provider_profiles').insert({
      user_id: prov.uid, legal_name: 'P8 Prov', display_name: 'P8 Prov', slug,
      state: 'KA', status: 'active', languages: ['en'],
    }).select('id').single()
    created.providerId = provider!.id
    await admin.from('provider_bank_accounts').insert({ provider_id: provider!.id, account_number_enc: 'enc_test', ifsc: 'HDFC0000001', account_holder: 'P8 Prov', penny_drop_verified: true })
    const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
    await admin.from('provider_categories').insert({ provider_id: provider!.id, category_id: cat!.id })
    const { data: pkg } = await admin.from('packages').insert({
      provider_id: provider!.id, category_id: cat!.id, slug: `${tag}-pkg`.replace(/_/g, '-'),
      title_i18n: { en: 'P8 pkg', hi: 'P8' }, price_paise: 500_000, discount_bps: 0, delivery_days: 3,
      revision_count: 1, status: 'active', scope_included: ['x'], scope_excluded: [], deliverables: ['y'],
    }).select('id').single()
    created.packageId = pkg!.id
    const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'P8 Buyer', state: 'KA', sector: 'services' }).select('id').single()
    created.msmeId = msme!.id

    // ── 1. Emergency takedown <5s ─────────────────────────────────────────────
    const pageUrl = `${BASE}/p/${slug}`
    const before = await fetch(pageUrl)
    check('provider page live pre-suspension', before.status === 200, `GET /p/${slug} → ${before.status}`)

    const susp = await api(adminUser.token, `/api/v1/admin/providers/${provider!.id}`, { action: 'suspend', reason: 'phase8 verify' })
    // The criterion is "<5s public disappearance" — poll until 404 or 5s.
    const t0 = Date.now()
    let gone = 0
    let lastStatus = 0
    while (Date.now() - t0 < 5000) {
      const r = await fetch(pageUrl)
      lastStatus = r.status
      if (r.status === 404) { gone = Date.now() - t0; break }
      await new Promise((res) => setTimeout(res, 400))
    }
    check(
      'public page gone <5s after suspend',
      susp.ok && gone > 0,
      `suspend=${susp.status}, 404 after ${gone || '>5000'}ms (last=${lastStatus})`,
    )
    const react = await api(adminUser.token, `/api/v1/admin/providers/${provider!.id}`, { action: 'reactivate' })
    const restored = await fetch(pageUrl)
    check('reactivate restores the page', react.ok && restored.status === 200, `→ ${restored.status}`)

    // ── 2. Payout monitor + retry ─────────────────────────────────────────────
    const co = await api(buyer.token, '/api/v1/checkout', { packageId: pkg!.id, idempotencyKey: crypto.randomUUID() })
    const cod = await co.json()
    const sim = await api(buyer.token, '/api/v1/checkout/simulate', { checkoutSessionId: cod.checkoutSessionId })
    const orderId = (await sim.json()).orderId as string
    created.orderId = orderId
    await api(prov.token, `/api/v1/orders/${orderId}/transition`, { action: 'accept' })
    await api(buyer.token, `/api/v1/orders/${orderId}/transition`, { action: 'submit_requirements' })
    await api(prov.token, `/api/v1/orders/${orderId}/transition`, { action: 'start' })
    await api(prov.token, `/api/v1/orders/${orderId}/transition`, { action: 'deliver' })
    await api(buyer.token, `/api/v1/orders/${orderId}/transition`, { action: 'accept_delivery' })
    // Force the scheduled payout into 'failed' to exercise retry.
    const { data: payout } = await admin.from('payouts').select('id, status').eq('order_id', orderId).single()
    await admin.from('payouts').update({ status: 'failed' }).eq('id', payout!.id)

    const list = await (await api(adminUser.token, '/api/v1/admin/payouts?status=failed', undefined, 'GET')).json()
    const inQueue = (list.payouts ?? []).some((p: { id: string }) => p.id === payout!.id)
    check('failed payout visible in monitor', inQueue, `${(list.payouts ?? []).length} failed row(s), counts=${JSON.stringify(list.counts)}`)

    const retry = await api(adminUser.token, `/api/v1/admin/payouts/${payout!.id}`, { action: 'retry' })
    const { data: afterRetry } = await admin.from('payouts').select('status').eq('id', payout!.id).single()
    const { data: auditRow } = await admin.from('audit_logs').select('id').eq('action', 'payout_retry').eq('entity_id', payout!.id).maybeSingle()
    check('retry: failed → scheduled + audit-logged', retry.ok && afterRetry!.status === 'scheduled' && !!auditRow)

    const illegal = await api(adminUser.token, `/api/v1/admin/payouts/${payout!.id}`, { action: 'retry' })
    check('retry from scheduled rejected (state machine)', illegal.status === 409, `→ ${illegal.status}`)

    // ── 3. Security headers on prod ───────────────────────────────────────────
    const res = await fetch(`${BASE}/`)
    const missing = ['content-security-policy', 'strict-transport-security', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy'].filter((h) => !res.headers.get(h))
    check('all six security headers on prod', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : 'all present')
  } finally {
    // Cleanup — loud on error (lesson from the §2 cleanup near-miss).
    const must = async (label: string, q: PromiseLike<{ error: { message: string } | null }>) => {
      const { error } = await q
      if (error) console.error(`  cleanup ${label}: ${error.message}`)
    }
    // FK order matters: checkout_sessions references orders, audit_logs
    // references users — delete children first.
    if (created.packageId) {
      await must('sessions', admin.from('checkout_sessions').delete().eq('package_id', created.packageId))
    }
    if (created.orderId) {
      const { data: pays } = await admin.from('payments').select('id').eq('order_id', created.orderId)
      if (pays?.length) await must('refunds', admin.from('refunds').delete().in('payment_id', pays.map((p) => p.id)))
      await must('payments', admin.from('payments').delete().eq('order_id', created.orderId))
      await must('payouts', admin.from('payouts').delete().eq('order_id', created.orderId))
      await must('events', admin.from('order_events').delete().eq('order_id', created.orderId))
      await must('milestones', admin.from('order_milestones').delete().eq('order_id', created.orderId))
      await must('documents', admin.from('order_documents').delete().eq('order_id', created.orderId))
      await must('invoices', admin.from('invoices').delete().eq('order_id', created.orderId))
      await must('orders', admin.from('orders').delete().eq('id', created.orderId))
    }
    if (created.packageId) {
      await must('packages', admin.from('packages').delete().eq('id', created.packageId))
    }
    for (const uid of created.users) {
      await must('audit', admin.from('audit_logs').delete().eq('actor_id', uid))
    }
    if (created.providerId) {
      await must('bank', admin.from('provider_bank_accounts').delete().eq('provider_id', created.providerId))
      await must('pcats', admin.from('provider_categories').delete().eq('provider_id', created.providerId))
      await must('provider', admin.from('provider_profiles').delete().eq('id', created.providerId))
    }
    if (created.msmeId) await must('msme', admin.from('msme_profiles').delete().eq('id', created.msmeId))
    for (const uid of created.users) {
      await must('notif', admin.from('notifications').delete().eq('user_id', uid))
      await must('user', admin.from('users').delete().eq('id', uid))
      await admin.auth.admin.deleteUser(uid).catch(() => {})
    }
    console.log('\ncleaned up kill-test rows.')
  }

  console.log(`\n═ Phase 8 verify: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
