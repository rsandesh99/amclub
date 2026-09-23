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
import { createServerClient } from '@supabase/ssr'
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
    // Phase 4b — provA states its commercial terms (the optional fields).
    const qRes = await api(provA.token, `/api/v1/rfq/${rfqA}/quote`, { price_paise: 400000, delivery_days: 5, scope: 'Full GST filing service scope here.', gst_included: true, transport_included: false, valid_until: '2027-03-31', advance_percent: 40 })
    const quoteId = (await qRes.json()).quoteId as string | undefined
    eq('quote submit WITH optional terms → 200', qRes.status, 200)
    if (quoteId) {
      const { data: qRow } = await admin.from('quotes').select('gst_included, transport_included, valid_until, advance_percent').eq('id', quoteId).maybeSingle()
      eq('terms stored on the quote row', JSON.stringify(qRow), JSON.stringify({ gst_included: true, transport_included: false, valid_until: '2027-03-31', advance_percent: 40 }))
      const { data: qEv } = await admin.from('quote_events').select('payload').eq('quote_id', quoteId).eq('event_type', 'submitted').maybeSingle()
      const ep = (qEv?.payload ?? {}) as Record<string, unknown>
      eq('submitted event payload carries the terms', ep['advance_percent'] === 40 && ep['gst_included'] === true && ep['valid_until'] === '2027-03-31', true)
      eq('advance_percent > 100 → 422', (await api(provB.token, `/api/v1/rfq/${rfqA}/quote`, { price_paise: 1000, delivery_days: 1, scope: 'y'.repeat(25), advance_percent: 150 })).status, 422)
    }
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
    // Onboard a fresh provider THROUGH THE API (cookie session, like the
    // wizard) so its bank row is encrypted with the SERVER's key — the
    // override decrypts it to fingerprint the account, and a fixture encrypted
    // with a local key can never be decrypted in prod. This also proves 1g on
    // the deployed build: the client-sent bankVerified:true must be ignored.
    const provC = await mkUser('provC', ['provider'])
    const jar: Record<string, string> = {}
    const ssr = createServerClient(URL_, ANON, {
      cookies: {
        getAll() { return Object.entries(jar).map(([name, value]) => ({ name, value })) },
        setAll(list) { for (const { name, value } of list) jar[name] = value },
      },
    })
    await ssr.auth.signInWithPassword({ email: `${tag}_provC@killtest.amclub`, password: 'Test1234!' })
    const cookie = Object.entries(jar).map(([n, v]) => `${n}=${v}`).join('; ')
    // Phase 2: provider signup is refused until Terms + Privacy + Addendum are on record.
    const onbNoLegal = await fetch(`${BASE}/api/v1/profile/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ legalName: 'C Co Marketing', displayName: 'C Co', categorySlugs: ['digital-marketing'], state: 'KA', languages: ['en'], bankIfsc: 'HDFC0000001', bankAccount: '123456789012', bankHolder: 'C Co Marketing' }),
    })
    eq('provider signup WITHOUT legal acceptance → 403 legal_acceptance_required', onbNoLegal.status === 403 && ((await onbNoLegal.json().catch(() => ({}))) as { error?: string }).error === 'legal_acceptance_required', true)
    const legalC = await api(provC.token, '/api/v1/legal/accept', { docs: ['terms', 'privacy', 'provider_addendum'], surface: 'web' })
    eq('provC accepts terms+privacy+addendum → 200', legalC.status, 200)
    const onb = await fetch(`${BASE}/api/v1/profile/provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        legalName: 'C Co Marketing', displayName: 'C Co', categorySlugs: ['digital-marketing'], state: 'KA', languages: ['en'],
        bankIfsc: 'HDFC0000001', bankAccount: '123456789012', bankHolder: 'C Co Marketing', bankVerified: true,
      }),
    })
    const provCId = ((await onb.json().catch(() => ({}))) as { providerId?: string }).providerId
    if (provCId) created.providerIds.push(provCId)
    eq('provC onboarded via API (bank encrypted server-side)', onb.status, 200)
    const { data: bankC } = await admin.from('provider_bank_accounts').select('penny_drop_verified').eq('provider_id', provCId ?? '').maybeSingle()
    eq('client bankVerified:true IGNORED → penny_drop_verified false (1g)', bankC?.penny_drop_verified, false)
    eq('override without a reason → 422', (await api(adminUser.token, `/api/v1/admin/providers/${provCId}`, { action: 'set_bank_verified', verified: true, reason: 'x' })).status, 422)
    const ov = await api(adminUser.token, `/api/v1/admin/providers/${provCId}`, { action: 'set_bank_verified', verified: true, reason: 'Cancelled cheque verified on call (killtest)' })
    eq('admin override with reason → 200', ov.status, 200)
    const { data: bankAfter } = await admin.from('provider_bank_accounts').select('penny_drop_verified').eq('provider_id', provCId ?? '').maybeSingle()
    eq('penny_drop_verified now true', bankAfter?.penny_drop_verified, true)
    const { data: ovRows } = await admin.from('bank_account_verifications').select('provider, verified, stub, result').eq('user_id', provC.uid)
    eq("bank_account_verifications row: provider='admin_override', verified, not stub", ovRows?.length === 1 && ovRows[0]!.provider === 'admin_override' && ovRows[0]!.verified === true && ovRows[0]!.stub === false, true)
    eq('override row carries the reason', (ovRows?.[0]?.result as { reason?: string } | null)?.reason?.includes('Cancelled cheque'), true)
    const { data: auditRows } = await admin.from('audit_logs').select('action').eq('actor_id', adminUser.uid).eq('entity_id', provCId ?? '').eq('action', 'provider_set_bank_verified')
    eq('audit_logs has provider_set_bank_verified', (auditRows ?? []).length, 1)

    // ── 4c. Phase 3a — Route account via the admin UI path (same action) ──
    console.log('Route account (set_route_account) — admin-only, validated, audited:')
    denied('provC sets Route account on OWN row (provider)', (await api(provC.token, `/api/v1/admin/providers/${provCId}`, { action: 'set_route_account', routeAccountId: 'acc_SELFSERVE01' })).status)
    eq('admin: invalid acc_ format → 422', (await api(adminUser.token, `/api/v1/admin/providers/${provCId}`, { action: 'set_route_account', routeAccountId: 'not-an-account' })).status, 422)
    const beforeRoute = ((await (await api(adminUser.token, `/api/v1/admin/providers/${provCId}`, undefined, 'GET')).json()) as { bank?: { readiness?: string } }).bank?.readiness
    eq('readiness before: missing_route (bank verified by override above)', beforeRoute, 'missing_route')
    // Phase 3b (ii): approval proceeds AND surfaces unreadiness — to the approver
    // (response + toast), the dashboard tile, and the provider (/profile/me).
    // The verifications route is cookie-session only (getSessionUser), like the
    // admin pages that call it — mint the admin's cookie jar for this call.
    const adminJar: Record<string, string> = {}
    const adminSsr = createServerClient(URL_, ANON, {
      cookies: {
        getAll() { return Object.entries(adminJar).map(([name, value]) => ({ name, value })) },
        setAll(list) { for (const { name, value } of list) adminJar[name] = value },
      },
    })
    await adminSsr.auth.signInWithPassword({ email: `${tag}_admin@killtest.amclub`, password: 'Test1234!' })
    const adminCookie = Object.entries(adminJar).map(([n, v]) => `${n}=${v}`).join('; ')
    const kpiBefore = (await (await api(adminUser.token, '/api/v1/admin/kpi', undefined, 'GET')).json()) as { health?: { providersNotReady?: number } }
    const approveRes = await fetch(`${BASE}/api/v1/admin/verifications/${provCId}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: adminCookie }, body: JSON.stringify({ action: 'approve' }) })
    const approveJson = (await approveRes.json().catch(() => ({}))) as { status?: string; readiness?: string }
    eq('approve provC → 200 active, response carries readiness=missing_route', approveRes.status === 200 && approveJson.status === 'active' && approveJson.readiness === 'missing_route', true)
    const kpi = (await (await api(adminUser.token, '/api/v1/admin/kpi', undefined, 'GET')).json()) as { health?: { providersNotReady?: number; providersReady?: number } }
    eq('dashboard tile grows by exactly the newly approved unready provider', (kpi.health?.providersNotReady ?? 0) - (kpiBefore.health?.providersNotReady ?? 0), 1)
    const meC = (await (await api(provC.token, '/api/v1/profile/me', undefined, 'GET')).json()) as { payoutReadiness?: string }
    eq('provider /profile/me reports payoutReadiness=missing_route (banner source)', meC.payoutReadiness, 'missing_route')
    // Phase 4d — the banner itself, in the provider's dashboard response (cookie session).
    const BANNER = 'Your payouts will be held until your bank account is verified and your Razorpay payout account is linked.'
    // next-intl inlines the whole message bundle in a <script>; only VISIBLE
    // markup counts, or every banner string would be "present" on every page.
    const visible = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '')
    const dashUnready = visible(await (await fetch(`${BASE}/partner`, { headers: { cookie } })).text())
    eq('unready ACTIVE provider: payout-hold banner present on /partner', dashUnready.includes(BANNER), true)
    const dashHi = visible(await (await fetch(`${BASE}/hi/partner`, { headers: { cookie } })).text())
    eq('…and in Hindi on /hi/partner', dashHi.includes('हमारी टीम यह आपके साथ मिलकर पूरा कर रही है'), true)
    eq('admin: valid acc_ with note → 200', (await api(adminUser.token, `/api/v1/admin/providers/${provCId}`, { action: 'set_route_account', routeAccountId: 'acc_KILLTEST00001', reason: 'killtest link' })).status, 200)
    const detailAfter = (await (await api(adminUser.token, `/api/v1/admin/providers/${provCId}`, undefined, 'GET')).json()) as { bank?: { readiness?: string; routeAccountId?: string } }
    eq('readiness after: ready', detailAfter.bank?.readiness, 'ready')
    eq('detail exposes the Route id, not the account number', detailAfter.bank?.routeAccountId, 'acc_KILLTEST00001')
    const meCAfter = (await (await api(provC.token, '/api/v1/profile/me', undefined, 'GET')).json()) as { payoutReadiness?: string }
    eq('provider /profile/me flips to ready once linked (banner clears)', meCAfter.payoutReadiness, 'ready')
    const dashReady = visible(await (await fetch(`${BASE}/partner`, { headers: { cookie } })).text())
    eq('ready provider: banner ABSENT on /partner (no manual dismissal)', dashReady.includes('Your payouts will be held until your bank account is verified'), false)
    const kpiAfter = (await (await api(adminUser.token, '/api/v1/admin/kpi', undefined, 'GET')).json()) as { health?: { providersNotReady?: number } }
    eq('dashboard tile shrinks back once the Route account is linked', (kpiAfter.health?.providersNotReady ?? 0) - (kpiBefore.health?.providersNotReady ?? 0), 0)
    const { data: routeAudit } = await admin.from('audit_logs').select('after').eq('actor_id', adminUser.uid).eq('entity_id', provCId ?? '').eq('action', 'provider_set_route_account')
    eq('audit_logs has provider_set_route_account with the note', routeAudit?.length === 1 && (routeAudit[0]!.after as { reason?: string }).reason === 'killtest link', true)
    const listReady = (await (await api(adminUser.token, '/api/v1/admin/providers?readiness=ready', undefined, 'GET')).json()) as { providers?: { id: string }[] }
    eq('providers list readiness=ready filter includes provC', (listReady.providers ?? []).some((p) => p.id === provCId), true)
    const listUnready = (await (await api(adminUser.token, '/api/v1/admin/providers?readiness=unready', undefined, 'GET')).json()) as { providers?: { id: string }[] }
    eq('providers list readiness=unready filter excludes provC', (listUnready.providers ?? []).some((p) => p.id === provCId), false)
    const payoutsView = await api(adminUser.token, '/api/v1/admin/payouts?status=held', undefined, 'GET')
    eq('admin payouts view (held) renders with readiness/aging fields → 200', payoutsView.status, 200)

    // ── 4c. S1 spine hygiene — order_events append-only + document kind gate +
    //        verifications route auth/limiter consistency ─────────────────────
    console.log('S1.1 order_events append-only (0019):')
    {
      const { data: evRows } = await admin.from('order_events').select('id, event').eq('order_id', orderA).limit(1)
      const ev = evRows?.[0]
      eq('order_events INSERT path produced rows (addEvent unaffected)', Boolean(ev), true)
      if (ev) {
        const asBuyerA = createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${buyerA.token}` } }, auth: { persistSession: false } })
        const upd = await asBuyerA.from('order_events').update({ event: 'forged' }).eq('id', ev.id).select('id')
        const updDenied = Boolean(upd.error) || (upd.data ?? []).length === 0
        console.log(`  ${updDenied ? '✓' : '✗ LEAK'} party UPDATE on order_events denied → ${upd.error ? upd.error.message.slice(0, 60) : (upd.data ?? []).length + ' rows'}`)
        updDenied ? pass++ : fail++
        const del = await asBuyerA.from('order_events').delete().eq('id', ev.id).select('id')
        const delDenied = Boolean(del.error) || (del.data ?? []).length === 0
        console.log(`  ${delDenied ? '✓' : '✗ LEAK'} party DELETE on order_events denied → ${del.error ? del.error.message.slice(0, 60) : (del.data ?? []).length + ' rows'}`)
        delDenied ? pass++ : fail++
        const { data: still } = await admin.from('order_events').select('event').eq('id', ev.id).maybeSingle()
        eq('row unchanged after forgery attempts', still?.event, ev.event)
      }
    }

    console.log('S1.2 order_documents kind allowlist:')
    {
      const png = new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')], { type: 'image/png' })
      const evil = new FormData()
      evil.append('file', png, 'x.png')
      evil.append('kind', '../../evil')
      const evilRes = await fetch(`${BASE}/api/v1/orders/${orderA}/documents`, {
        method: 'POST', headers: { Authorization: `Bearer ${buyerA.token}` }, body: evil,
      })
      eq("kind='../../evil' → 422", evilRes.status, 422)
      const { data: evilObjs } = await admin.storage.from('order-documents').list(orderA)
      eq('no storage object created for rejected kind', (evilObjs ?? []).some((o) => o.name.includes('evil')), false)
      const good = new FormData()
      good.append('file', png, 'x.png')
      good.append('kind', 'deliverable')
      const goodRes = await fetch(`${BASE}/api/v1/orders/${orderA}/documents`, {
        method: 'POST', headers: { Authorization: `Bearer ${buyerA.token}` }, body: good,
      })
      eq("kind='deliverable' → 200", goodRes.status, 200)
      // Zero residue: remove the uploaded doc row + storage object now.
      const { data: docRows } = await admin.from('order_documents').select('id, file_url').eq('order_id', orderA)
      for (const d of docRows ?? []) {
        if (d.file_url) await admin.storage.from('order-documents').remove([d.file_url])
      }
      await admin.from('order_documents').delete().eq('order_id', orderA)
    }

    console.log('S1.5 verifications route — one admin gate + limiter:')
    {
      denied('provider Bearer POST /admin/verifications/{provB}', (await api(provA.token, `/api/v1/admin/verifications/${provBId}`, { action: 'reject', reason: 'killtest' })).status)
      const okBearer = await api(adminUser.token, `/api/v1/admin/verifications/${provBId}`, { action: 'reject', reason: 'killtest' })
      eq('admin Bearer POST → 200', okBearer.status, 200)
      // Cookie session (the admin browser path) must also pass — requireAdmin
      // accepts both. Mint a cookie jar for the admin fixture.
      const ajar: Record<string, string> = {}
      const assr = createServerClient(URL_, ANON, {
        cookies: {
          getAll() { return Object.entries(ajar).map(([name, value]) => ({ name, value })) },
          setAll(list) { for (const { name, value } of list) ajar[name] = value },
        },
      })
      await assr.auth.signInWithPassword({ email: `${tag}_admin@killtest.amclub`, password: 'Test1234!' })
      const acookie = Object.entries(ajar).map(([n, v]) => `${n}=${v}`).join('; ')
      const okCookie = await fetch(`${BASE}/api/v1/admin/verifications/${provBId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie: acookie },
        body: JSON.stringify({ action: 'reject', reason: 'killtest-cookie' }),
      })
      eq('admin cookie POST → 200', okCookie.status, 200)
      // adminMutation limiter (60/min per user): hammer until a 429 appears.
      let saw429 = false
      for (let i = 0; i < 65 && !saw429; i++) {
        const r = await api(adminUser.token, `/api/v1/admin/verifications/${provBId}`, { action: 'reject', reason: 'rl-probe' })
        if (r.status === 429) saw429 = true
      }
      eq('adminMutation limiter engages (429 under hammer)', saw429, true)
    }

    // ── 4d. S2.2 gstin_verifications — server-set record + RLS + attest ───────
    // Fresh fixtures: earlier sections hammered adminUser (S1.5 limiter probe)
    // and provC (bank onboarding), so this section mints its own to avoid
    // inheriting a spent rate-limit budget.
    console.log('S2.2 gstin_verifications:')
    {
      const provD = await mkUser('provD', ['provider'])
      const { data: ppD } = await admin.from('provider_profiles').insert({
        user_id: provD.uid, legal_name: 'D Co', display_name: 'D Co', slug: `${tag}-provD`.replace(/_/g, '-'),
        state: 'KA', status: 'active', languages: ['en'], gstin: '29AAAAA0000A1Z5',
      }).select('id').single()
      created.providerIds.push(ppD!.id)
      const adminUser2 = await mkUser('admin2', ['msme', 'admin'])

      // verify-gstin is cookie-session auth (getSessionUser), like the wizard —
      // drive it with a cookie jar, not the Bearer token (which would 401).
      const djar: Record<string, string> = {}
      const dssr = createServerClient(URL_, ANON, {
        cookies: {
          getAll() { return Object.entries(djar).map(([name, value]) => ({ name, value })) },
          setAll(list) { for (const { name, value } of list) djar[name] = value },
        },
      })
      await dssr.auth.signInWithPassword({ email: `${tag}_provD@killtest.amclub`, password: 'Test1234!' })
      const dcookie = Object.entries(djar).map(([n, v]) => `${n}=${v}`).join('; ')
      const gv = await fetch(`${BASE}/api/v1/profile/provider/kyc/verify-gstin`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', cookie: dcookie },
        body: JSON.stringify({ gstin: '29ABCDE1234F1Z5' }),
      })
      eq('verify-gstin call → 200 (stub mode verifies)', gv.status, 200)
      const { data: rec } = await admin
        .from('gstin_verifications')
        .select('provider, verified, stub')
        .eq('user_id', provD.uid)
        .order('created_at', { ascending: false })
        .limit(1)
      eq('attempt recorded server-side', Boolean(rec?.[0]), true)
      eq("recorded provider is 'stub' or 'surepass' (never client-set)", rec?.[0] && ['stub', 'surepass'].includes(rec[0].provider), true)

      const asProvD = createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${provD.token}` } }, auth: { persistSession: false } })
      const { data: own } = await asProvD.from('gstin_verifications').select('id')
      eq('provider self-reads own rows (≥1)', (own ?? []).length >= 1, true)
      const asBuyerB = createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${buyerB.token}` } }, auth: { persistSession: false } })
      const { data: cross, error: crossErr } = await asBuyerB.from('gstin_verifications').select('id')
      const crossDenied = Boolean(crossErr) || (cross ?? []).length === 0
      console.log(`  ${crossDenied ? '✓' : '✗ LEAK'} cross-tenant read → ${crossErr ? 'error' : (cross ?? []).length + ' rows'}`)
      crossDenied ? pass++ : fail++
      const forged = await asProvD.from('gstin_verifications').insert({ user_id: provD.uid, gstin: '29ABCDE1234F1Z5', verified: true, provider: 'surepass' })
      const forgeDenied = Boolean(forged.error)
      console.log(`  ${forgeDenied ? '✓' : '✗ LEAK'} client INSERT denied → ${forged.error ? forged.error.message.slice(0, 60) : 'INSERTED'}`)
      forgeDenied ? pass++ : fail++

      // Admin attest on provD (GSTIN already on file), fresh admin fixture.
      denied('non-admin attest_gstin', (await api(provD.token, `/api/v1/admin/providers/${ppD!.id}`, { action: 'attest_gstin', reason: 'self attest' })).status)
      const attest = await api(adminUser2.token, `/api/v1/admin/providers/${ppD!.id}`, { action: 'attest_gstin', reason: 'verified on gst.gov.in pre-table' })
      eq('admin attest_gstin → 200', attest.status, 200)
      const { data: att } = await admin
        .from('gstin_verifications')
        .select('provider, verified, gstin')
        .eq('user_id', provD.uid)
        .eq('provider', 'admin_attest')
        .limit(1)
      eq("attest row written with provider='admin_attest'", att?.[0]?.verified === true && att?.[0]?.gstin === '29AAAAA0000A1Z5', true)
      const { data: aud } = await admin
        .from('audit_logs')
        .select('id')
        .eq('action', 'provider_attest_gstin')
        .eq('entity_id', ppD!.id)
        .limit(1)
      eq('attest audit-logged', Boolean(aud?.[0]), true)
      // Residue: gstin_verifications user_id has no FK — delete explicitly.
      await admin.from('gstin_verifications').delete().in('user_id', [provD.uid])
    }

    // ── 4e. H0 agent groundwork (0026, ADR-008) — RLS + append-only + ledger ──
    // Fresh fixtures (own limiter budget). Tables are service-role-write only;
    // self + admin read. agent_events rejects UPDATE for everyone (trigger).
    console.log('H0 agent_runs / agent_events / ai_invocations attribution:')
    {
      const agentU = await mkUser('agentU', ['msme'])
      const agentX = await mkUser('agentX', ['msme'])
      const adminUser3 = await mkUser('admin3', ['msme', 'admin'])

      const { data: run, error: runErr } = await admin
        .from('agent_runs')
        .insert({ user_id: agentU.uid, persona: 'buyer', surface: 'web', meta: { tag } })
        .select('id, status')
        .single()
      eq('service-role opens a run (status running)', run?.status ?? runErr?.message, 'running')
      const runId = run!.id
      const { error: evErr } = await admin
        .from('agent_events')
        .insert({ run_id: runId, kind: 'started', actor: 'system', payload: { tag } })
      eq('service-role appends an event', evErr?.message ?? null, null)
      const upd = await admin.from('agent_events').update({ kind: 'completed' }).eq('run_id', runId)
      eq('append-only: UPDATE agent_events raises even for service role', Boolean(upd.error), true)
      const badPersona = await admin.from('agent_runs').insert({ user_id: agentU.uid, persona: 'admin', surface: 'web' })
      eq("CHECK rejects persona outside AGENT_PERSONAS", Boolean(badPersona.error), true)

      const asU = createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${agentU.token}` } }, auth: { persistSession: false } })
      const asX = createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${agentX.token}` } }, auth: { persistSession: false } })
      const asA = createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${adminUser3.token}` } }, auth: { persistSession: false } })
      eq('owner self-reads own run', ((await asU.from('agent_runs').select('id').eq('id', runId)).data ?? []).length, 1)
      eq('owner self-reads own events', ((await asU.from('agent_events').select('id').eq('run_id', runId)).data ?? []).length, 1)
      eq('admin reads the run', ((await asA.from('agent_runs').select('id').eq('id', runId)).data ?? []).length, 1)
      const xr = await asX.from('agent_runs').select('id').eq('id', runId)
      const xDenied = Boolean(xr.error) || (xr.data ?? []).length === 0
      console.log(`  ${xDenied ? '✓' : '✗ LEAK'} cross-tenant run read → ${xr.error ? 'error' : (xr.data ?? []).length + ' rows'}`)
      xDenied ? pass++ : fail++
      const xe = await asX.from('agent_events').select('id').eq('run_id', runId)
      const xeDenied = Boolean(xe.error) || (xe.data ?? []).length === 0
      console.log(`  ${xeDenied ? '✓' : '✗ LEAK'} cross-tenant event read → ${xe.error ? 'error' : (xe.data ?? []).length + ' rows'}`)
      xeDenied ? pass++ : fail++
      const forgeRun = await asU.from('agent_runs').insert({ user_id: agentU.uid, persona: 'buyer', surface: 'web' })
      eq('client INSERT agent_runs denied', Boolean(forgeRun.error), true)
      const forgeEv = await asU.from('agent_events').insert({ run_id: runId, kind: 'confirmed', actor: 'user' })
      eq('client INSERT agent_events denied (confirmation cannot be forged)', Boolean(forgeEv.error), true)
      const clientUpd = await asU.from('agent_runs').update({ status: 'completed' }).eq('id', runId).select('id')
      const updDenied = Boolean(clientUpd.error) || (clientUpd.data ?? []).length === 0
      eq('client UPDATE agent_runs denied', updDenied, true)

      // Ledger attribution through the DEPLOYED writer: the admin text-parse
      // diagnostic writes an ai_invocations row via logAiInvocation.
      const ev = await api(adminUser3.token, '/api/v1/admin/voice-parse-text', { text: 'need GST returns filed for my textile unit in Guntur' })
      eq('admin voice-parse-text → 200', ev.status, 200)
      const { data: inv } = await admin
        .from('ai_invocations')
        .select('task_class, tier, run_id')
        .eq('user_id', adminUser3.uid)
        .order('created_at', { ascending: false })
        .limit(1)
      eq("deployed ledger writer sets task_class='rfq_parse'", inv?.[0]?.task_class, 'rfq_parse')
      eq("deployed ledger writer sets tier='routine'", inv?.[0]?.tier, 'routine')
      eq('standalone call has run_id null', inv?.[0]?.run_id ?? null, null)

      // Residue: ai_invocations.user_id is ON DELETE SET NULL — delete explicitly.
      await admin.from('ai_invocations').delete().in('user_id', [adminUser3.uid, agentU.uid, agentX.uid])
      await admin.from('agent_runs').delete().eq('id', runId) // cascades agent_events
    }

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

    // ── 7b. users privilege guard (0042) — no self-promotion, no self-delete ──
    console.log('users privilege guard (0042, direct PostgREST):')
    eq('buyerB direct-reads OWN users row → 1 row', ((await bClient.from('users').select('id').eq('id', buyerB.uid)).data ?? []).length, 1)
    deniedRows('buyerB sets OWN roles to admin', await bClient.from('users').update({ roles: ['admin'] }).eq('id', buyerB.uid).select('id'))
    deniedRows('buyerB DELETEs OWN users row', await bClient.from('users').delete().eq('id', buyerB.uid).select('id'))
    deniedRows('buyerB INSERTs a users row', await bClient.from('users').insert({ id: crypto.randomUUID(), email: `${tag}_forged@killtest.amclub`, roles: ['admin'] }).select('id'))
    const { data: bRow } = await admin.from('users').select('roles').eq('id', buyerB.uid).single()
    eq('after escalation attempts: buyerB roles unchanged', JSON.stringify((bRow as { roles: string[] } | null)?.roles ?? null), JSON.stringify(['msme']))
    denied('buyerB GET admin API after attempts', (await api(buyerB.token, '/api/v1/admin/kpi', undefined, 'GET')).status)

    // ── 7c. RLS hardening (0043) — messages / order_events / audit_logs ──────
    console.log('RLS hardening (0043, direct PostgREST):')
    {
      const aBuyer = asUser(buyerA.token)
      const aProv = asUser(provA.token)
      // messages: parties are read-only — no edit / un-redact / delete of the
      // other side's message, and no insert that skips the masking route.
      const { data: cv } = quoteId
        ? await admin.from('conversations').select('id').eq('context_type', 'quote').eq('context_id', quoteId).maybeSingle()
        : { data: null }
      if (cv) {
        const { data: mRows } = await admin.from('messages').select('id, body, sender_id').eq('conversation_id', cv.id).limit(1)
        const m = mRows?.[0]
        eq('buyerA direct-reads OWN thread messages → ≥1 row (control)', ((await aBuyer.from('messages').select('id').eq('conversation_id', cv.id)).data ?? []).length > 0, true)
        if (m) {
          deniedRows('provA UPDATEs buyerA’s message (un-redact)', await aProv.from('messages').update({ body: 'call me on 9876543210', redacted: false }).eq('id', m.id).select('id'))
          deniedRows('buyerA UPDATEs OWN message', await aBuyer.from('messages').update({ body: 'edited' }).eq('id', m.id).select('id'))
          deniedRows('provA DELETEs buyerA’s message', await aProv.from('messages').delete().eq('id', m.id).select('id'))
          const { data: mAfter } = await admin.from('messages').select('body').eq('id', m.id).maybeSingle()
          eq('message unchanged after tamper attempts', mAfter?.body, m.body)
        }
        deniedRows('provA INSERTs a message directly (skips masking)', await aProv.from('messages').insert({ conversation_id: cv.id, sender_id: provA.uid, body: 'call 9876543210', redacted: false }).select('id'))
      } else {
        console.log('  (skipped messages checks — no quote thread)')
      }
      // order_events: no client insert at all — a party cannot forge a
      // payout/refund row or someone else's actor_id in its own timeline.
      const evBefore = ((await admin.from('order_events').select('id').eq('order_id', orderA)).data ?? []).length
      deniedRows('buyerA INSERTs forged payout_paid on OWN order', await aBuyer.from('order_events').insert({ order_id: orderA, actor_id: provA.uid, event: 'payout_paid', payload: { forged: true } }).select('id'))
      deniedRows('provA INSERTs forged manual_refund on OWN order', await aProv.from('order_events').insert({ order_id: orderA, actor_id: adminUser.uid, event: 'manual_refund', payload: { forged: true } }).select('id'))
      eq('order_events count unchanged after forgery attempts', ((await admin.from('order_events').select('id').eq('order_id', orderA)).data ?? []).length, evBefore)
      // audit_logs: client roles cannot write; even the service role cannot UPDATE.
      deniedRows('buyerB INSERTs an audit_logs row', await bClient.from('audit_logs').insert({ actor_id: buyerB.uid, action: 'forged', entity: 'users', entity_id: buyerB.uid }).select('id'))
      const { data: aRows } = await admin.from('audit_logs').select('id, action').eq('actor_id', adminUser.uid).limit(1)
      const a = aRows?.[0]
      if (a) {
        const asAdmin = asUser(adminUser.token)
        deniedRows('admin (client JWT) UPDATEs an audit_logs row', await asAdmin.from('audit_logs').update({ action: 'tampered' }).eq('id', a.id).select('id'))
        deniedRows('admin (client JWT) DELETEs an audit_logs row', await asAdmin.from('audit_logs').delete().eq('id', a.id).select('id'))
        const svcUpd = await admin.from('audit_logs').update({ action: 'tampered' }).eq('id', a.id).select('id')
        eq('service-role UPDATE on audit_logs raises (append-only trigger)', Boolean(svcUpd.error), true)
        const { data: aAfter } = await admin.from('audit_logs').select('action').eq('id', a.id).maybeSingle()
        eq('audit row unchanged after tamper attempts', aAfter?.action, a.action)
      } else {
        console.log('  (skipped audit_logs update checks — no admin audit row)')
      }

      // msme_profiles: owner read-only — no self-verification, no self-unsuspend.
      eq('buyerA direct-reads OWN msme_profile → 1 row (control)', ((await aBuyer.from('msme_profiles').select('id').eq('id', msmeA!.id)).data ?? []).length, 1)
      deniedRows('buyerA self-sets udyam_verified/gstin_verified', await aBuyer.from('msme_profiles').update({ udyam_verified: true, gstin_verified: true }).eq('id', msmeA!.id).select('id'))
      deniedRows('buyerA DELETEs OWN msme_profile', await aBuyer.from('msme_profiles').delete().eq('id', msmeA!.id).select('id'))

      // P0-8 — suspension is enforced on act paths, and cannot be self-reversed.
      // Its own admin fixture: the S1.5 limiter probe spent adminUser's
      // adminMutation budget, and on a fast local stack this runs inside the
      // same 1-minute window (see 4d).
      const suspAdmin = await mkUser('adminSusp', ['msme', 'admin'])
      const susp = await api(suspAdmin.token, `/api/v1/admin/msmes/${msmeA!.id}`, { action: 'suspend', reason: 'killtest suspension' })
      eq('admin suspends buyerA → 200', susp.status, 200)
      if (susp.status === 200) {
        denied('suspended buyerA creates an RFQ', (await api(buyerA.token, '/api/v1/rfq', { category_slug: 'tax-accounting', title: 'GST filing while suspended please', details: { work: 'gst' } })).status)
        denied('suspended buyerA cancels OWN order', (await api(buyerA.token, `/api/v1/orders/${orderA}/transition`, { action: 'cancel' })).status)
        deniedRows('suspended buyerA clears OWN deleted_at', await aBuyer.from('msme_profiles').update({ deleted_at: null }).eq('id', msmeA!.id).select('id'))
        const { data: stillSusp } = await admin.from('msme_profiles').select('deleted_at').eq('id', msmeA!.id).maybeSingle()
        eq('buyerA still suspended after self-unsuspend attempt', Boolean(stillSusp?.deleted_at), true)
        eq('admin MSME detail still readable while suspended → 200', (await api(suspAdmin.token, `/api/v1/admin/msmes/${msmeA!.id}`, undefined, 'GET')).status, 200)
        eq('admin reactivates buyerA → 200', (await api(suspAdmin.token, `/api/v1/admin/msmes/${msmeA!.id}`, { action: 'reactivate' })).status, 200)
        eq('reactivated buyerA GET own order → 200 (control)', (await api(buyerA.token, `/api/v1/orders/${orderA}`, undefined, 'GET')).status, 200)
      }
    }

    // ── 8. Phase 2: terms_acceptances (append-only, self-read) + signup gate ──
    console.log('Phase 2 — terms_acceptances + signup gate:')
    const buyerC = await mkUser('buyerC', ['msme'])
    const noLegal = await api(buyerC.token, '/api/v1/profile/msme', { fullName: 'C Buyer', businessName: 'C Buyer Co' })
    eq('MSME signup WITHOUT acceptance → 403 legal_acceptance_required (API-level)', noLegal.status === 403 && ((await noLegal.json().catch(() => ({}))) as { error?: string }).error === 'legal_acceptance_required', true)
    eq('legal/status lists terms+privacy as required', JSON.stringify((((await (await api(buyerC.token, '/api/v1/legal/status', undefined, 'GET')).json()) as { required?: string[] }).required ?? []).sort()), JSON.stringify(['privacy', 'terms']))
    eq('accept terms+privacy → 200', (await api(buyerC.token, '/api/v1/legal/accept', { docs: ['terms', 'privacy'], surface: 'web', locale: 'en' })).status, 200)
    const withLegal = await api(buyerC.token, '/api/v1/profile/msme', { fullName: 'C Buyer', businessName: 'C Buyer Co' })
    eq('MSME signup AFTER acceptance → 200', withLegal.status, 200)
    const { data: msmeC } = await admin.from('msme_profiles').select('id').eq('user_id', buyerC.uid).maybeSingle()
    if (msmeC) created.msmeIds.push(msmeC.id)
    const cClient = asUser(buyerC.token)
    eq('buyerC direct-reads OWN terms_acceptances → 2 rows', ((await cClient.from('terms_acceptances').select('id').eq('user_id', buyerC.uid)).data ?? []).length, 2)
    deniedRows('buyerB direct-reads C’s terms_acceptances', await bClient.from('terms_acceptances').select('id').eq('user_id', buyerC.uid))
    deniedRows('buyerC UPDATEs own terms_acceptances (append-only)', await cClient.from('terms_acceptances').update({ version: '1999-01-01' }).eq('user_id', buyerC.uid).select('id'))
    deniedRows('buyerC DELETEs own terms_acceptances (append-only)', await cClient.from('terms_acceptances').delete().eq('user_id', buyerC.uid).select('id'))
    deniedRows('buyerC INSERTs a forged acceptance', await cClient.from('terms_acceptances').insert({ user_id: buyerC.uid, doc: 'provider_addendum', version: '2026-08-28' }).select('id'))
    eq('after tamper attempts: still exactly 2 rows', ((await admin.from('terms_acceptances').select('id').eq('user_id', buyerC.uid)).data ?? []).length, 2)
    eq('re-accepting is idempotent (written=[])', JSON.stringify((((await (await api(buyerC.token, '/api/v1/legal/accept', { docs: ['terms', 'privacy'] })).json()) as { written?: string[] }).written) ?? null), '[]')
    // ── Experience v3 E11 (N29): view counts are readable only by their provider ──
    console.log('\nview_counts_daily (E11 N29):')
    const today = new Date().toISOString().slice(0, 10)
    await admin.from('view_counts_daily').insert([
      { subject_kind: 'provider', subject_id: provAId, provider_id: provAId, day: today, views: 7 },
      { subject_kind: 'provider', subject_id: provBId, provider_id: provBId, day: today, views: 3 },
    ])
    try {
      const asUser = (token: string | null) => createClient(URL_, ANON, { auth: { persistSession: false }, ...(token ? { global: { headers: { Authorization: `Bearer ${token}` } } } : {}) })
      const { data: seenByB } = await asUser(provB.token).from('view_counts_daily').select('provider_id').in('provider_id', [provAId, provBId])
      eq('provB reads only its own view counts', (seenByB ?? []).map((r) => r.provider_id).join(), provBId)
      const { data: seenByBuyer } = await asUser(buyerA.token).from('view_counts_daily').select('provider_id').in('provider_id', [provAId, provBId])
      eq('a buyer reads no view counts', (seenByBuyer ?? []).length, 0)
      const { data: seenByAnon } = await asUser(null).from('view_counts_daily').select('provider_id').in('provider_id', [provAId, provBId])
      eq('anon reads no view counts', (seenByAnon ?? []).length, 0)
      const ins = await asUser(provB.token).from('view_counts_daily').insert({ subject_kind: 'provider', subject_id: provBId, provider_id: provBId, day: today, views: 999 })
      eq('a provider cannot write view counts directly', !!ins.error, true)
    } finally {
      await admin.from('view_counts_daily').delete().in('provider_id', [provAId, provBId])
    }
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
