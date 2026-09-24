/**
 * Phase 8 §1 — full-app axe accessibility scan (Playwright + axe-core).
 *
 * Scans every major surface: gateway, auth, public catalog, RFQ (incl. voice UI),
 * checkout, order workspace, MSME/provider/admin dashboards.
 *
 * Modes:
 *  - Public-only (no SUPABASE_SERVICE_ROLE_KEY): gateway + catalog + auth + legal.
 *    This is what CI runs.
 *  - Full (service key present): also mints kill-test buyer/provider/admin users,
 *    injects their @supabase/ssr cookies into the browser, creates one simulated
 *    order, and scans the authenticated surfaces. All rows cleaned in `finally`.
 *
 * Exit code: 1 when any critical/serious violation is found and A11Y_ENFORCE=1
 * (report-only otherwise). Full JSON report → A11Y_REPORT path or ./a11y-report.json.
 *
 * Run: BASE_URL=http://localhost:3000 tsx scripts/a11y-scan.ts
 */
import { config } from 'dotenv'
import path from 'path'
import fs from 'fs'
config({ path: path.resolve(__dirname, '../.env.local') })
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'

const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? ''
const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'
const ENFORCE = process.env['A11Y_ENFORCE'] === '1'
// E18: the agent-on server (money-rigs :3001) for the assistant surfaces; unset → they are not scanned.
const AGENT_BASE = process.env['A11Y_AGENT_BASE_URL'] || ''
const REPORT_PATH = process.env['A11Y_REPORT'] ?? path.resolve(__dirname, '../a11y-report.json')

interface Surface {
  name: string
  path: string
  as?: 'buyer' | 'provider' | 'admin'
  /** Extra settle time (ms) after networkidle, e.g. for choreographed reveals. */
  settle?: number
  /** Another server of the same stack (the agent-on one); default BASE. Cookies are per host, so sessions carry over. */
  base?: string
}

interface Violation {
  surface: string
  id: string
  impact: string
  description: string
  helpUrl: string
  nodes: { target: string; html: string }[]
}

const admin: SupabaseClient | null = SERVICE
  ? createClient(URL_, SERVICE, { auth: { persistSession: false } })
  : null
const anonClient = createClient(URL_, ANON, { auth: { persistSession: false } })

const tag = `a11y_${Date.now()}`
const created = {
  users: [] as string[],
  providerIds: [] as string[],
  msmeIds: [] as string[],
  packageIds: [] as string[],
  orderIds: [] as string[],
  categoryIds: [] as string[],
}

/** Mint a session and return the @supabase/ssr cookie jar (what the browser would hold). */
async function mkUserWithCookies(label: string, roles: string[]): Promise<{ uid: string; token: string; cookies: { name: string; value: string }[] }> {
  const email = `${tag}_${label}@killtest.amclub`
  const { data, error } = await admin!.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error(`${label}: ${error.message}`)
  created.users.push(data.user.id)
  await admin!.from('users').insert({ id: data.user.id, email, roles })
  const jar: Record<string, string> = {}
  const ssr = createServerClient(URL_, ANON, {
    cookies: {
      getAll() { return Object.entries(jar).map(([name, value]) => ({ name, value })) },
      setAll(list) { for (const { name, value } of list) jar[name] = value },
    },
  })
  const { data: s, error: signErr } = await ssr.auth.signInWithPassword({ email, password: 'Test1234!' })
  if (signErr) throw new Error(`signIn ${label}: ${signErr.message}`)
  return {
    uid: data.user.id,
    token: s.session!.access_token,
    cookies: Object.entries(jar).map(([name, value]) => ({ name, value })),
  }
}

const api = (token: string, p: string, body?: unknown, method = 'POST') =>
  fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

async function main() {
  console.log(`\nA11y scan → ${BASE} ${admin ? '(full: public + authenticated)' : '(public surfaces only)'}\n`)

  // ── Public slugs from live catalog (anon-readable by design) ────────────────
  const { data: cat } = await anonClient.from('categories').select('slug').eq('is_active', true).limit(1).maybeSingle()
  const { data: pkgRow } = await anonClient
    .from('packages')
    .select('slug, provider:provider_profiles!inner(slug, status)')
    .eq('status', 'active')
    .eq('provider_profiles.status', 'active')
    .limit(1)
    .maybeSingle()
  const catSlug = cat?.slug
  const provSlug = (pkgRow?.provider as { slug?: string } | null)?.slug
  const pkgSlug = pkgRow?.slug

  const surfaces: Surface[] = [
    { name: 'gateway', path: '/', settle: 1500 },
    { name: 'services index', path: '/services' },
    ...(catSlug ? [{ name: 'category listing', path: `/services/${catSlug}` }] : []),
    ...(provSlug ? [{ name: 'provider profile', path: `/p/${provSlug}` }] : []),
    ...(provSlug && pkgSlug ? [{ name: 'package page', path: `/p/${provSlug}/${pkgSlug}` }] : []),
    { name: 'help', path: '/help' },
    { name: 'terms', path: '/terms' },
    { name: 'privacy', path: '/privacy' },
    { name: 'refund policy', path: '/refund-policy' },
    { name: 'login', path: '/login' },
    { name: 'signup', path: '/signup' },
    { name: 'partner signup', path: '/partner/signup' },
    { name: 'gateway (hi)', path: '/hi', settle: 1500 },
  ]

  let buyer: Awaited<ReturnType<typeof mkUserWithCookies>> | null = null
  let provider: Awaited<ReturnType<typeof mkUserWithCookies>> | null = null
  let adminUser: Awaited<ReturnType<typeof mkUserWithCookies>> | null = null

  if (admin) {
    // ── Kill-test data for authenticated surfaces ──────────────────────────────
    buyer = await mkUserWithCookies('buyer', ['msme'])
    const { data: msme } = await admin.from('msme_profiles').insert({ user_id: buyer.uid, business_name: 'A11y Buyer Co', state: 'KA', sector: 'services' }).select('id').single()
    created.msmeIds.push(msme!.id)

    provider = await mkUserWithCookies('prov', ['provider'])
    const { data: provRow } = await admin.from('provider_profiles').insert({
      user_id: provider.uid, legal_name: 'A11y Prov', display_name: 'A11y Prov', slug: `${tag}-prov`.replace(/_/g, '-'),
      state: 'KA', status: 'active', languages: ['en'],
    }).select('id').single()
    created.providerIds.push(provRow!.id)
    await admin.from('provider_bank_accounts').insert({ provider_id: provRow!.id, account_number_enc: 'enc_test', ifsc: 'HDFC0000001', account_holder: 'A11y Prov', penny_drop_verified: true })

    adminUser = await mkUserWithCookies('admin', ['admin', 'ops'])

    // Package under a real active category (reuse catalog category — no new category rows).
    const { data: realCat } = await admin.from('categories').select('id').eq('is_active', true).limit(1).single()
    await admin.from('provider_categories').insert({ provider_id: provRow!.id, category_id: realCat!.id })
    const { data: pkg } = await admin.from('packages').insert({
      provider_id: provRow!.id, category_id: realCat!.id, slug: `${tag}-pkg`.replace(/_/g, '-'),
      title_i18n: { en: 'A11y scan pkg', hi: 'A11y' }, price_paise: 500_000, discount_bps: 0, delivery_days: 3, revision_count: 1,
      status: 'active', scope_included: ['x'], scope_excluded: [], deliverables: ['y'],
    }).select('id').single()
    created.packageIds.push(pkg!.id)

    // One simulated order so the order workspace renders real content.
    const co = await api(buyer.token, '/api/v1/checkout', { packageId: pkg!.id, idempotencyKey: crypto.randomUUID() })
    const cod = await co.json()
    let orderId = ''
    if (cod.simulated) {
      const sim = await api(buyer.token, '/api/v1/checkout/simulate', { checkoutSessionId: cod.checkoutSessionId })
      orderId = (await sim.json()).orderId
    }
    if (orderId) created.orderIds.push(orderId)

    surfaces.push(
      { name: 'msme home', path: '/app', as: 'buyer' },
      { name: 'msme search', path: '/app/search', as: 'buyer' },
      { name: 'rfq list', path: '/app/rfq', as: 'buyer' },
      { name: 'rfq new (voice)', path: '/app/rfq/new', as: 'buyer', settle: 800 },
      { name: 'orders list', path: '/app/orders', as: 'buyer' },
      ...(orderId ? [{ name: 'order workspace', path: `/app/orders/${orderId}`, as: 'buyer' as const }] : []),
      { name: 'checkout', path: `/app/checkout/${pkg!.id}`, as: 'buyer' },
      { name: 'notifications', path: '/app/notifications', as: 'buyer' },
      { name: 'msme profile', path: '/app/profile', as: 'buyer' },
      { name: 'invoices', path: '/app/invoices', as: 'buyer' },
      { name: 'saved', path: '/app/saved', as: 'buyer' },
      { name: 'provider home', path: '/partner', as: 'provider' },
      { name: 'provider onboarding wizard', path: '/partner/onboarding', as: 'provider', settle: 800 },
      { name: 'provider listings', path: '/partner/listings', as: 'provider' },
      { name: 'provider listing new', path: '/partner/listings/new', as: 'provider' },
      { name: 'provider orders', path: '/partner/orders', as: 'provider' },
      ...(orderId ? [{ name: 'provider order detail', path: `/partner/orders/${orderId}`, as: 'provider' as const }] : []),
      { name: 'provider rfqs', path: '/partner/rfqs', as: 'provider' },
      { name: 'provider earnings', path: '/partner/earnings', as: 'provider' },
      { name: 'provider reviews', path: '/partner/reviews', as: 'provider' },
      { name: 'admin home', path: '/admin', as: 'admin' },
      { name: 'admin verifications', path: '/admin/verifications', as: 'admin' },
      { name: 'admin providers', path: '/admin/providers', as: 'admin' },
      { name: 'admin msmes', path: '/admin/msmes', as: 'admin' },
      { name: 'admin orders', path: '/admin/orders', as: 'admin' },
      { name: 'admin disputes', path: '/admin/disputes', as: 'admin' },
      { name: 'admin coupons', path: '/admin/coupons', as: 'admin' },
      { name: 'admin categories', path: '/admin/categories', as: 'admin' },
      { name: 'admin reviews', path: '/admin/reviews', as: 'admin' },
      { name: 'admin audit', path: '/admin/audit', as: 'admin' },
      { name: 'admin cms', path: '/admin/cms', as: 'admin' },
      { name: 'admin payouts', path: '/admin/payouts', as: 'admin' },
      ...(AGENT_BASE
        ? [
            { name: 'assistant home (buyer)', path: '/app/ai', as: 'buyer' as const, base: AGENT_BASE },
            { name: 'assistant home (provider)', path: '/partner/ai', as: 'provider' as const, base: AGENT_BASE },
            { name: 'msme home + corner assistant', path: '/app', as: 'buyer' as const, base: AGENT_BASE },
          ]
        : []),
    )
  }

  let browser: Browser | null = null
  const violations: Violation[] = []
  const pageErrors: { surface: string; error: string }[] = []

  try {
    browser = await chromium.launch()

    const mkContext = async (cookies?: { name: string; value: string }[]): Promise<BrowserContext> => {
      const ctx = await browser!.newContext({
        viewport: { width: 390, height: 844 }, // mobile-first: primary users are on phones
        reducedMotion: 'reduce',
      })
      if (cookies) {
        await ctx.addCookies(cookies.map((c) => ({ ...c, url: BASE })))
      }
      return ctx
    }

    const contexts: Record<string, BrowserContext> = {
      public: await mkContext(),
      ...(buyer ? { buyer: await mkContext(buyer.cookies) } : {}),
      ...(provider ? { provider: await mkContext(provider.cookies) } : {}),
      ...(adminUser ? { admin: await mkContext(adminUser.cookies) } : {}),
    }

    for (const s of surfaces) {
      const ctx = contexts[s.as ?? 'public']!
      const page = await ctx.newPage()
      try {
        const res = await page.goto(`${s.base ?? BASE}${s.path}`, { waitUntil: 'networkidle', timeout: 45_000 })
        await page.waitForTimeout(s.settle ?? 400)
        const finalUrl = page.url()
        if (res && res.status() >= 400) {
          pageErrors.push({ surface: s.name, error: `HTTP ${res.status()}` })
        }
        if (s.as && /\/(login|signup)(\?|$)/.test(finalUrl)) {
          pageErrors.push({ surface: s.name, error: `auth bounce → ${finalUrl}` })
        }
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
        for (const v of results.violations) {
          violations.push({
            surface: s.name,
            id: v.id,
            impact: v.impact ?? 'minor',
            description: v.description,
            helpUrl: v.helpUrl,
            nodes: v.nodes.slice(0, 5).map((n) => ({ target: n.target.join(' '), html: n.html.slice(0, 200) })),
          })
        }
        const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 } as Record<string, number>
        for (const v of results.violations) counts[v.impact ?? 'minor'] = (counts[v.impact ?? 'minor'] ?? 0) + 1
        const summary = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}:${n}`).join(' ')
        console.log(`  ${results.violations.length === 0 ? '✓' : '✗'} ${s.name.padEnd(28)} ${summary || 'clean'}`)
      } catch (e) {
        pageErrors.push({ surface: s.name, error: e instanceof Error ? e.message.split('\n')[0]! : String(e) })
        console.log(`  ⚠ ${s.name.padEnd(28)} SCAN ERROR: ${e instanceof Error ? e.message.split('\n')[0] : e}`)
      } finally {
        await page.close()
      }
    }
  } finally {
    await browser?.close()
    // ── Cleanup (no test residue) ───────────────────────────────────────────────
    if (admin) {
      for (const id of created.orderIds) {
        const { data: pay } = await admin.from('payments').select('id').eq('order_id', id).maybeSingle()
        if (pay) {
          await admin.from('refunds').delete().eq('payment_id', pay.id)
          await admin.from('payments').delete().eq('order_id', id)
        }
        await admin.from('payouts').delete().eq('order_id', id)
        await admin.from('order_events').delete().eq('order_id', id)
        await admin.from('order_milestones').delete().eq('order_id', id)
        await admin.from('order_documents').delete().eq('order_id', id)
        await admin.from('invoices').delete().eq('order_id', id)
        await admin.from('orders').delete().eq('id', id)
      }
      await admin.from('checkout_sessions').delete().in('package_id', created.packageIds)
      for (const id of created.packageIds) await admin.from('packages').delete().eq('id', id)
      for (const id of created.providerIds) {
        await admin.from('provider_bank_accounts').delete().eq('provider_id', id)
        await admin.from('provider_categories').delete().eq('provider_id', id)
        await admin.from('provider_profiles').delete().eq('id', id)
      }
      for (const id of created.msmeIds) await admin.from('msme_profiles').delete().eq('id', id)
      for (const id of created.users) {
        await admin.from('notifications').delete().eq('user_id', id)
        await admin.from('users').delete().eq('id', id)
        await admin.auth.admin.deleteUser(id).catch(() => {})
      }
      console.log('\ncleaned up kill-test rows.')
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const byImpact = (impact: string) => violations.filter((v) => v.impact === impact)
  const critical = byImpact('critical')
  const serious = byImpact('serious')

  fs.writeFileSync(REPORT_PATH, JSON.stringify({ base: BASE, when: new Date().toISOString(), violations, pageErrors }, null, 2))
  console.log(`\nfull report → ${REPORT_PATH}`)

  console.log(`\n═ RESULT ═ critical:${critical.length} serious:${serious.length} moderate:${byImpact('moderate').length} minor:${byImpact('minor').length} scan-errors:${pageErrors.length}`)
  for (const v of [...critical, ...serious]) {
    console.log(`\n[${v.impact}] ${v.id} @ ${v.surface}\n  ${v.description}\n  ${v.nodes.map((n) => n.target).join('\n  ')}`)
  }
  for (const e of pageErrors) console.log(`\n[scan-error] ${e.surface}: ${e.error}`)

  if (ENFORCE && (critical.length > 0 || serious.length > 0 || pageErrors.length > 0)) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
