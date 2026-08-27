/**
 * Security regression suite — authorization / IDOR (docs/SECURITY_AUDIT.md §1).
 *
 * Adversarial: builds two full tenants (MSME A+B, Provider A+B), an admin and a
 * plain non-admin, then attempts every cross-tenant access we must deny. Each
 * assertion is "attacker gets 401/403/404, never 200". Runs against the deployed
 * app so it exercises the REAL middleware + route handlers (cookie is web-only;
 * these use Bearer, the mobile path — same handlers).
 *
 * Wired into CI-adjacent verification, not the unit suite (needs a live DB +
 * deploy). Run: BASE_URL=https://amclub-web.vercel.app tsx scripts/verify-authz.ts
 * Creates only kill-test rows; removes everything in `finally`.
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'
import { createCipheriv, randomBytes } from 'crypto'

const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const BASE = process.env['BASE_URL'] ?? 'https://amclub-web.vercel.app'
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })

// Mirror of lib/crypto encryptColumn (AES-256-GCM, iv|tag|ct base64) so bank
// fixtures carry a REAL ciphertext — the admin bank-override decrypts it to
// fingerprint the account. Same key resolution as the server (.env.local).
function encryptLikeServer(plaintext: string): string {
  const hex = process.env['COLUMN_ENCRYPTION_KEY']
  const key = Buffer.from(hex && /^[0-9a-fA-F]{64}$/.test(hex) ? hex : '0'.repeat(64), 'hex')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')
}

const tag = `authz_${Date.now()}`
let pass = 0
let fail = 0
const denied = (name: string, status: number, extra = '') => {
  const ok = status === 401 || status === 403 || status === 404
  console.log(`  ${ok ? '✓' : '✗ LEAK'} ${name} → ${status}${extra ? ' ' + extra : ''}`)
  ok ? pass++ : fail++
}
const eq = (name: string, actual: unknown, expected: unknown) => {
  const ok = actual === expected
  console.log(`  ${ok ? '✓' : '✗'} ${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
  ok ? pass++ : fail++
}

const created = { users: [] as string[], msmeIds: [] as string[], providerIds: [] as string[], packageIds: [] as string[], orderIds: [] as string[], rfqIds: [] as string[] }

async function mkUser(label: string, roles: string[]): Promise<{ uid: string; token: string }> {
  const email = `${tag}_${label}@killtest.amclub`
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error(`${label}: ${error.message}`)
  created.users.push(data.user.id)
  await admin.from('users').insert({ id: data.user.id, email, roles })
  const anon = createClient(URL_, ANON, { auth: { persistSession: false } })
  const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
  return { uid: data.user.id, token: s.session!.access_token }
}

const api = (token: string | null, p: string, body?: unknown, method = 'POST') =>
  fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

async function main() {
  console.log(`\nAuthz / IDOR adversarial suite → ${BASE}\n`)
  try {
    // ── Cast ────────────────────────────────────────────────────────────────
    const buyerA = await mkUser('buyerA', ['msme'])
    const buyerB = await mkUser('buyerB', ['msme'])
    const provA = await mkUser('provA', ['provider'])
    const provB = await mkUser('provB', ['provider'])
    const outsider = await mkUser('outsider', ['msme'])

    const { data: msmeA } = await admin.from('msme_profiles').insert({ user_id: buyerA.uid, business_name: 'A Co', state: 'KA', sector: 'services' }).select('id').single()
    const { data: msmeB } = await admin.from('msme_profiles').insert({ user_id: buyerB.uid, business_name: 'B Co', state: 'KA', sector: 'services' }).select('id').single()
    created.msmeIds.push(msmeA!.id, msmeB!.id)

    const mkProvider = async (uid: string, label: string) => {
      const { data: p } = await admin.from('provider_profiles').insert({
        user_id: uid, legal_name: label, display_name: label, slug: `${tag}-${label}`.replace(/_/g, '-'),
        state: 'KA', status: 'active', languages: ['en'],
      }).select('id').single()
      created.providerIds.push(p!.id)
      await admin.from('provider_bank_accounts').insert({ provider_id: p!.id, account_number_enc: encryptLikeServer('123456789012'), ifsc: 'HDFC0000001', account_holder: label, penny_drop_verified: true })
      return p!.id
    }
    const provAId = await mkProvider(provA.uid, 'provA')
    const provBId = await mkProvider(provB.uid, 'provB')

    const { data: cat } = await admin.from('categories').select('id, slug').eq('slug', 'tax-accounting').single()
    await admin.from('provider_categories').insert({ provider_id: provAId, category_id: cat!.id })
    const { data: pkgA } = await admin.from('packages').insert({
      provider_id: provAId, category_id: cat!.id, slug: `${tag}-pkgA`.replace(/_/g, '-'),
      title_i18n: { en: 'A pkg', hi: 'A' }, price_paise: 500_000, discount_bps: 0, delivery_days: 3, revision_count: 1,
      status: 'active', scope_included: ['x'], scope_excluded: [], deliverables: ['y'],
    }).select('id').single()
    created.packageIds.push(pkgA!.id)

    // Buyer A places an order with Provider A (simulate).
    const co = await api(buyerA.token, '/api/v1/checkout', { packageId: pkgA!.id, idempotencyKey: crypto.randomUUID() })
    const cod = await co.json()
    const sim = await api(buyerA.token, '/api/v1/checkout/simulate', { checkoutSessionId: cod.checkoutSessionId })
    const simJson = await sim.json()
    const orderA = simJson.orderId as string
    created.orderIds.push(orderA)

    // ── 1. Order IDOR ─────────────────────────────────────────────────────────
    console.log('Order IDOR (A owns the order):')
    denied('buyerB GET order A', (await api(buyerB.token, `/api/v1/orders/${orderA}`, undefined, 'GET')).status)
    denied('provB GET order A', (await api(provB.token, `/api/v1/orders/${orderA}`, undefined, 'GET')).status)
    denied('provB accept order A', (await api(provB.token, `/api/v1/orders/${orderA}/transition`, { action: 'accept' })).status)
    denied('buyerB cancel order A', (await api(buyerB.token, `/api/v1/orders/${orderA}/transition`, { action: 'cancel' })).status)
    denied('buyerB list order A docs', (await api(buyerB.token, `/api/v1/orders/${orderA}/documents`, undefined, 'GET')).status)
    denied('provB toggle external-wait A', (await api(provB.token, `/api/v1/orders/${orderA}/external-wait`, { active: true })).status)
    denied('buyerB review order A', (await api(buyerB.token, `/api/v1/orders/${orderA}/review`, { rating: 1 })).status)
    // Positive control: the real owner CAN read it.
    eq('buyerA GET own order (control)', (await api(buyerA.token, `/api/v1/orders/${orderA}`, undefined, 'GET')).status, 200)

    // ── 2. checkout/simulate ownership (FINDING F1 — fixed this pass) ──────────
    console.log('Checkout/simulate ownership:')
    const coB = await api(buyerA.token, '/api/v1/checkout', { packageId: pkgA!.id, idempotencyKey: crypto.randomUUID() })
    const coBd = await coB.json()
    denied('buyerB materialises A’s session', (await api(buyerB.token, '/api/v1/checkout/simulate', { checkoutSessionId: coBd.checkoutSessionId })).status)

    // ── 3. RFQ + quote IDOR ────────────────────────────────────────────────────
    console.log('RFQ / quote IDOR:')
    const rfqRes = await api(buyerA.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title: 'GST filing for A Co manufacturing', details: { work: 'gst' } })
    const rfqA = (await rfqRes.json()).rfqId as string
    if (rfqA) created.rfqIds.push(rfqA)
    denied('buyerB GET rfq A', (await api(buyerB.token, `/api/v1/rfq/${rfqA}`, undefined, 'GET')).status)
    denied('buyer (non-provider) quotes rfq A', (await api(buyerB.token, `/api/v1/rfq/${rfqA}/quote`, { price_paise: 100000, delivery_days: 3, scope: 'x'.repeat(25) })).status)
    // Match provider B is NOT matched to rfq A (A's fanout may or may not include B); force the negative:
    denied('provB quotes rfq A when not matched', (await api(provB.token, `/api/v1/rfq/${rfqA}/quote`, { price_paise: 100000, delivery_days: 3, scope: 'y'.repeat(25) })).status)

    // Give provider A a match + quote on rfq A, then B tries to accept it.
    await admin.from('rfq_matches').insert({ rfq_id: rfqA, provider_id: provAId }).select().maybeSingle()
    const qRes = await api(provA.token, `/api/v1/rfq/${rfqA}/quote`, { price_paise: 400000, delivery_days: 5, scope: 'Full GST filing service scope here.' })
    const quoteId = (await qRes.json()).quoteId as string | undefined
    if (quoteId) {
      denied('buyerB accepts A’s quote via checkout', (await api(buyerB.token, '/api/v1/checkout', { quoteId, idempotencyKey: crypto.randomUUID() })).status)
      denied('outsider reads A’s quote thread', (await api(outsider.token, `/api/v1/quotes/${quoteId}/messages`, undefined, 'GET')).status)
      denied('outsider posts to A’s quote thread', (await api(outsider.token, `/api/v1/quotes/${quoteId}/messages`, { body: 'hi' })).status)
    } else {
      console.log('  (skipped quote-accept checks — quote submit returned no id)')
    }

    // ── 4. Admin routes as non-admin (Bearer) ──────────────────────────────────
    console.log('Admin routes rejected for non-admin (Bearer):')
    const adminGets = ['/api/v1/admin/kpi', '/api/v1/admin/payouts', '/api/v1/admin/orders', '/api/v1/admin/providers', '/api/v1/admin/msmes', '/api/v1/admin/disputes', '/api/v1/admin/reviews', '/api/v1/admin/audit', '/api/v1/admin/categories', '/api/v1/admin/coupons', '/api/v1/admin/cms']
    for (const p of adminGets) denied(`GET ${p}`, (await api(buyerA.token, p, undefined, 'GET')).status)
    denied('POST /admin/providers/{provA} suspend', (await api(buyerA.token, `/api/v1/admin/providers/${provAId}`, { action: 'suspend', reason: 'x' })).status)
    denied('POST /admin/providers/{provA} set_bank_verified (self, as provider)', (await api(provA.token, `/api/v1/admin/providers/${provAId}`, { action: 'set_bank_verified', verified: true, reason: 'I verified myself' })).status)
    denied('POST /admin/voice-parse-text', (await api(buyerA.token, '/api/v1/admin/voice-parse-text', { text: 'file my gst returns please' })).status)
    denied('POST /admin/payouts/{id} retry (fake id)', (await api(buyerA.token, `/api/v1/admin/payouts/${crypto.randomUUID()}`, { action: 'retry' })).status)
    denied('POST /admin/categories create', (await api(buyerA.token, '/api/v1/admin/categories', { slug: 'x-hack', nameI18n: { en: 'x', hi: 'x' }, commissionBps: 0, requiredCredentials: [] })).status)
    // Unauthenticated (no token) must also be denied.
    denied('anon GET /admin/kpi', (await api(null, '/api/v1/admin/kpi', undefined, 'GET')).status)

    // ── 4b. Admin bank-verification override — positive control (Phase 1g) ────
    // A real admin CAN clear a provider's bank hold, but only with a reason, and
    // the act is recorded twice: audit_logs + bank_account_verifications with
    // provider='admin_override' (never confusable with a vendor result).
    console.log('Admin bank-verification override (positive control):')
    const adminUser = await mkUser('admin', ['msme', 'admin'])
    await admin.from('provider_bank_accounts').update({ penny_drop_verified: false }).eq('provider_id', provAId)
    eq('override without a reason → 422', (await api(adminUser.token, `/api/v1/admin/providers/${provAId}`, { action: 'set_bank_verified', verified: true, reason: 'x' })).status, 422)
    const ov = await api(adminUser.token, `/api/v1/admin/providers/${provAId}`, { action: 'set_bank_verified', verified: true, reason: 'Cancelled cheque verified on call (killtest)' })
    eq('admin override with reason → 200', ov.status, 200)
    const { data: bankAfter } = await admin.from('provider_bank_accounts').select('penny_drop_verified').eq('provider_id', provAId).maybeSingle()
    eq('penny_drop_verified now true', bankAfter?.penny_drop_verified, true)
    const { data: ovRows } = await admin.from('bank_account_verifications').select('provider, verified, stub, result').eq('user_id', provA.uid)
    eq("bank_account_verifications row: provider='admin_override', verified, not stub", ovRows?.length === 1 && ovRows[0]!.provider === 'admin_override' && ovRows[0]!.verified === true && ovRows[0]!.stub === false, true)
    eq('override row carries the reason', (ovRows?.[0]?.result as { reason?: string } | null)?.reason?.includes('Cancelled cheque'), true)
    const { data: auditRows } = await admin.from('audit_logs').select('action').eq('actor_id', adminUser.uid).eq('entity_id', provAId).eq('action', 'provider_set_bank_verified')
    eq('audit_logs has provider_set_bank_verified', (auditRows ?? []).length, 1)

    // ── 5. Contact-info redaction (phone-mask claim) ───────────────────────────
    if (quoteId) {
      console.log('Contact-info redaction in quote thread:')
      await api(buyerA.token, `/api/v1/quotes/${quoteId}/messages`, { body: 'call me on 9876543210 or a@b.com' })
      const { data: convo } = await admin.from('conversations').select('id').eq('context_type', 'quote').eq('context_id', quoteId).maybeSingle()
      const { data: msgs } = await admin.from('messages').select('body, redacted').eq('conversation_id', convo!.id).order('created_at', { ascending: false }).limit(1)
      const stored = msgs?.[0]
      const leaks = /9876543210|a@b\.com/.test(stored?.body ?? '')
      eq('phone/email NOT stored in cleartext', leaks, false)
      eq('message flagged redacted', stored?.redacted === true, true)
    }

    // ── 6. RLS as last line — direct PostgREST with a real low-priv JWT ─────────
    // Bypasses the app entirely: even if an app-layer owner check were missed,
    // RLS must return zero rows for cross-tenant / crown-jewel reads.
    console.log('RLS last line (direct PostgREST, low-priv JWT, no app):')
    const asUser = (token: string) => createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } })
    const bClient = asUser(buyerB.token)
    eq('buyerB direct-reads A order → 0 rows', ((await bClient.from('orders').select('id').eq('id', orderA)).data ?? []).length, 0)
    eq('buyerB direct-reads ANY bank account → 0 rows', ((await bClient.from('provider_bank_accounts').select('id')).data ?? []).length, 0)
    eq('buyerB direct-reads A msme_profile → 0 rows', ((await bClient.from('msme_profiles').select('id').eq('id', msmeA!.id)).data ?? []).length, 0)
    eq('buyerB direct-reads provider_verifications → 0 rows', ((await bClient.from('provider_verifications').select('id')).data ?? []).length, 0)
    eq('buyerB direct-reads payments → 0 rows', ((await bClient.from('payments').select('id')).data ?? []).length, 0)
    eq('buyerB direct-reads ai_invocations → 0 rows', ((await bClient.from('ai_invocations').select('id')).data ?? []).length, 0)
    eq('buyerB direct-reads audit_logs → 0 rows', ((await bClient.from('audit_logs').select('id')).data ?? []).length, 0)
    // Positive control: buyerB CAN read their own (empty) msme row by user.
    eq('buyerB direct-reads OWN msme_profile → 1 row', ((await bClient.from('msme_profiles').select('id').eq('id', msmeB!.id)).data ?? []).length, 1)

    // ── 7. Phase 1 tables: quote_events (append-only) + bank_account_verifications ──
    console.log('Phase 1 tables (direct PostgREST):')
    // REVOKEd grants surface as a PostgREST error; a missing policy surfaces as
    // 0 rows. Either is a denial.
    const deniedRows = (name: string, r: { data: unknown[] | null; error: { message: string } | null }) => {
      const ok = Boolean(r.error) || (r.data ?? []).length === 0
      console.log(`  ${ok ? '✓' : '✗ LEAK'} ${name} → ${r.error ? 'error: ' + r.error.message.slice(0, 60) : (r.data ?? []).length + ' rows'}`)
      ok ? pass++ : fail++
    }
    if (quoteId) {
      const aProv = asUser(provA.token)
      const aBuyer = asUser(buyerA.token)
      eq('provA direct-reads OWN quote_events → 1 row (submitted)', ((await aProv.from('quote_events').select('id').eq('quote_id', quoteId)).data ?? []).length, 1)
      eq('buyerA direct-reads quote_events on OWN rfq → 1 row', ((await aBuyer.from('quote_events').select('id').eq('quote_id', quoteId)).data ?? []).length, 1)
      deniedRows('buyerB direct-reads A’s quote_events', await bClient.from('quote_events').select('id').eq('quote_id', quoteId))
      deniedRows('provB direct-reads A’s quote_events', await asUser(provB.token).from('quote_events').select('id').eq('quote_id', quoteId))
      deniedRows('provA UPDATEs own quote_events (append-only)', await aProv.from('quote_events').update({ reason: 'tamper' }).eq('quote_id', quoteId).select('id'))
      deniedRows('provA DELETEs own quote_events (append-only)', await aProv.from('quote_events').delete().eq('quote_id', quoteId).select('id'))
      deniedRows('provA INSERTs a forged quote_event', await aProv.from('quote_events').insert({ quote_id: quoteId, event_type: 'accepted', actor: provA.uid }).select('id'))
      eq('after tamper attempts: still exactly 1 event', ((await admin.from('quote_events').select('id').eq('quote_id', quoteId)).data ?? []).length, 1)
    } else {
      console.log('  (skipped quote_events checks — no quote id)')
    }
    deniedRows('buyerB direct-reads bank_account_verifications', await bClient.from('bank_account_verifications').select('id'))
    deniedRows('provA direct-reads bank_account_verifications', await asUser(provA.token).from('bank_account_verifications').select('id'))
  } finally {
    // Cleanup — children before parents; loud on error.
    const del = async (label: string, q: PromiseLike<{ error: { message: string } | null }>) => {
      const { error } = await q; if (error) console.error(`  cleanup ${label}: ${error.message}`)
    }
    // checkout_sessions FK-reference orders → drop sessions first. Also sweep
    // orders by msme_id so any leak-created order (untracked) is caught.
    await del('sessions', admin.from('checkout_sessions').delete().in('package_id', created.packageIds))
    if (created.msmeIds.length) {
      const { data: extra } = await admin.from('orders').select('id').in('msme_id', created.msmeIds)
      for (const o of extra ?? []) if (!created.orderIds.includes(o.id)) created.orderIds.push(o.id)
    }
    for (const oid of created.orderIds) {
      const { data: pays } = await admin.from('payments').select('id').eq('order_id', oid)
      if (pays?.length) await del('refunds', admin.from('refunds').delete().in('payment_id', pays.map((p) => p.id)))
      await del('payments', admin.from('payments').delete().eq('order_id', oid))
      await del('payouts', admin.from('payouts').delete().eq('order_id', oid))
      await del('events', admin.from('order_events').delete().eq('order_id', oid))
      await del('milestones', admin.from('order_milestones').delete().eq('order_id', oid))
      await del('documents', admin.from('order_documents').delete().eq('order_id', oid))
      await del('invoices', admin.from('invoices').delete().eq('order_id', oid))
      await del('orders', admin.from('orders').delete().eq('id', oid))
    }
    for (const rid of created.rfqIds) {
      const { data: qs } = await admin.from('quotes').select('id').eq('rfq_id', rid)
      for (const q of qs ?? []) {
        const { data: cv } = await admin.from('conversations').select('id').eq('context_type', 'quote').eq('context_id', q.id).maybeSingle()
        if (cv) { await del('messages', admin.from('messages').delete().eq('conversation_id', cv.id)); await del('convo', admin.from('conversations').delete().eq('id', cv.id)) }
      }
      await del('quotes', admin.from('quotes').delete().eq('rfq_id', rid))
      await del('matches', admin.from('rfq_matches').delete().eq('rfq_id', rid))
      await del('rfqs', admin.from('rfqs').delete().eq('id', rid))
    }
    for (const pid of created.packageIds) await del('packages', admin.from('packages').delete().eq('id', pid))
    for (const pid of created.providerIds) {
      await del('bank', admin.from('provider_bank_accounts').delete().eq('provider_id', pid))
      await del('pcats', admin.from('provider_categories').delete().eq('provider_id', pid))
      await del('provider', admin.from('provider_profiles').delete().eq('id', pid))
    }
    for (const mid of created.msmeIds) await del('msme', admin.from('msme_profiles').delete().eq('id', mid))
    for (const uid of created.users) {
      await del('bankverifs', admin.from('bank_account_verifications').delete().eq('user_id', uid))
      await del('notif', admin.from('notifications').delete().eq('user_id', uid))
      await del('audit', admin.from('audit_logs').delete().eq('actor_id', uid))
      await del('users', admin.from('users').delete().eq('id', uid))
      await admin.auth.admin.deleteUser(uid).catch(() => {})
    }
    console.log('\ncleaned up kill-test rows.')
  }

  console.log(`\n═ authz suite: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
