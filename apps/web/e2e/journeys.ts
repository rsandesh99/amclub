/**
 * Browser journeys — a real Chromium clicks through the product the way a
 * person does, against the disposable CI stack (money-rigs.yml), with every
 * Experience v3 switch on and payments simulated. The rigs prove the server;
 * this proves the screens: buttons exist, are enabled, lead to the right next
 * screen, and the database ends in the state the screen promised.
 *
 *   A  Package → checkout → paid order → provider accepts → buyer shares
 *      requirements → provider starts, attaches a deliverable, delivers →
 *      buyer accepts delivery → admin releases the payout.
 *   B  Requirement (RFQ) form → fan-out → provider quotes → buyer compares,
 *      accepts & pays → paid order from the quote.
 *   C  The top-bar search is typed into in place (signed in and public), its
 *      results open right under it, and a sheet on a wide screen is centred.
 *   D  (AGENT_BASE_URL, the agent-on server) The corner assistant opens, leads
 *      to its home, hides and comes back from the setting, and on a phone it
 *      sits above the tab bar.
 *
 * Sessions are Supabase SSR cookies minted server-side (the login UI is phone
 * OTP only), exactly as scripts/a11y-scan.ts does. Every fixture is created
 * here and removed in `finally` (zero residue). Fixtures live in Sikkim (SK),
 * a state no other rig uses, so fan-out counts elsewhere are untouched.
 *
 * On a failed step: a full-page screenshot lands in e2e-artifacts/ (uploaded by
 * CI) and the rest of that journey is skipped (later steps depend on it).
 *
 * Run: BASE_URL=http://localhost:3000 pnpm --filter @amclub/web exec tsx e2e/journeys.ts
 * Needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
 */
import { config } from 'dotenv'
import path from 'path'
import { mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
config({ path: path.resolve(__dirname, '../.env.local') })

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { computeOrderAmounts } from '@amclub/shared'

const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'
const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
if (!URL_ || !ANON || !SERVICE) { console.error('NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are required'); process.exit(2) }
if (/supabase\.co/.test(URL_) && process.env['E2E_ALLOW_HOSTED'] !== '1') { console.error('Refusing to run browser journeys against a hosted Supabase (set E2E_ALLOW_HOSTED=1 to override).'); process.exit(2) }

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })
const ART = path.resolve(__dirname, '../e2e-artifacts')
mkdirSync(ART, { recursive: true })
const tag = `e2e${Date.now()}`
const STATE = 'SK'
const STEP_TIMEOUT = 30_000

let pass = 0
let fail = 0
const created = { users: [] as string[], providerIds: [] as string[], msmeIds: [] as string[], packageIds: [] as string[], rfqIds: [] as string[] }

// ── fixtures ───────────────────────────────────────────────────────────────────
interface Actor { uid: string; token: string; cookies: { name: string; value: string }[] }

async function mkUser(label: string, roles: string[]): Promise<Actor> {
  const email = `${tag}_${label}@killtest.amclub`
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error || !data.user) throw new Error(`createUser ${label}: ${error?.message}`)
  created.users.push(data.user.id)
  const phone = '+919' + Math.floor(100000000 + Math.random() * 899999999)
  const { error: uErr } = await admin.from('users').insert({ id: data.user.id, email, phone, roles })
  if (uErr) throw new Error(`users ${label}: ${uErr.message}`)
  const jar: Record<string, string> = {}
  const ssr = createServerClient(URL_, ANON, {
    cookies: {
      getAll() { return Object.entries(jar).map(([name, value]) => ({ name, value })) },
      setAll(list) { for (const { name, value } of list) jar[name] = value },
    },
  })
  const { data: s, error: sErr } = await ssr.auth.signInWithPassword({ email, password: 'Test1234!' })
  if (sErr || !s.session) throw new Error(`signIn ${label}: ${sErr?.message}`)
  return { uid: data.user.id, token: s.session.access_token, cookies: Object.entries(jar).map(([name, value]) => ({ name, value })) }
}

async function api(token: string, p: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<Response> {
  return fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}

/** Accept whatever documents the legal gate still wants, as signup would, so no blocking modal covers the page. */
async function acceptLegal(a: Actor): Promise<void> {
  const st = await api(a.token, '/api/v1/legal/status')
  const d = (await st.json().catch(() => ({}))) as { required?: string[] }
  if (d.required?.length) {
    const r = await api(a.token, '/api/v1/legal/accept', { docs: d.required, surface: 'web', locale: 'en' })
    if (!r.ok) throw new Error(`legal accept ${r.status}`)
  }
}

async function mkProvider(label: string, display: string): Promise<Actor & { providerId: string; slug: string }> {
  const u = await mkUser(label, ['provider'])
  const slug = `${tag}-${label}`
  const { data: p, error } = await admin.from('provider_profiles').insert({
    user_id: u.uid, legal_name: display, display_name: display, slug, state: STATE, status: 'active', languages: ['en'],
  }).select('id').single()
  if (error || !p) throw new Error(`provider_profiles ${label}: ${error?.message}`)
  created.providerIds.push(p.id)
  // Payout-ready: a penny-drop-verified bank row with a Route account (as the money loop's fixture).
  await admin.from('provider_bank_accounts').insert({
    provider_id: p.id, account_number_enc: 'enc', ifsc: 'HDFC0000001', account_holder: display, penny_drop_verified: true, razorpay_route_account_id: `acc_${tag}_${label}`,
  })
  await acceptLegal(u)
  return { ...u, providerId: p.id, slug }
}

async function mkBuyer(label: string): Promise<Actor & { msmeId: string }> {
  const u = await mkUser(label, ['msme'])
  const { data: m, error } = await admin.from('msme_profiles').insert({ user_id: u.uid, business_name: `${label} Traders`, state: STATE, sector: 'services' }).select('id').single()
  if (error || !m) throw new Error(`msme_profiles ${label}: ${error?.message}`)
  created.msmeIds.push(m.id)
  await acceptLegal(u)
  return { ...u, msmeId: m.id }
}

// ── browser helpers ────────────────────────────────────────────────────────────
let browser: Browser | null = null

/** Every error the browser itself raised during the journeys (uncaught exceptions + console.error), deduplicated. */
const browserErrors = new Map<string, number>()
function recordBrowserError(kind: string, page: Page, text: string): void {
  let where = ''
  try { where = new URL(page.url()).pathname.replace(/[0-9a-f-]{36}/g, ':id') } catch { /* about:blank */ }
  const key = `${kind} ${where} ${text.split('\n')[0]!.slice(0, 400)}`
  browserErrors.set(key, (browserErrors.get(key) ?? 0) + 1)
}

async function pageFor(a: Actor, viewport = { width: 1280, height: 900 }): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser!.newContext({ viewport, reducedMotion: 'reduce', locale: 'en-IN' })
  await ctx.addCookies(a.cookies.map((c) => ({ ...c, url: BASE })))
  const page = await ctx.newPage()
  page.setDefaultTimeout(STEP_TIMEOUT)
  page.on('pageerror', (e) => recordBrowserError('pageerror', page, e.message))
  page.on('console', (m) => { if (m.type() === 'error') recordBrowserError('console', page, m.text()) })
  return { ctx, page }
}

class JourneyStop extends Error {}

/** One step: pass/fail line, a screenshot on failure, and stop the journey (later steps depend on it). */
async function step(journey: string, name: string, pages: Page[], fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    pass++
  } catch (e) {
    fail++
    const msg = (e as Error).message.split('\n').slice(0, 4).join(' | ')
    console.log(`  ✗ ${name} — ${msg}`)
    for (const [i, p] of pages.entries()) {
      await p.screenshot({ path: path.join(ART, `${journey}-${name.replace(/[^a-z0-9]+/gi, '_').slice(0, 60)}-${i}.png`), fullPage: true }).catch(() => {})
    }
    throw new JourneyStop(name)
  }
}

/** Poll the database until `pred` holds (the UI said it happened — prove it). */
async function until<T>(what: string, read: () => Promise<T>, pred: (v: T) => boolean, ms = STEP_TIMEOUT): Promise<T> {
  const end = Date.now() + ms
  let last: T = await read()
  while (!pred(last)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`)
    await new Promise((r) => setTimeout(r, 500))
    last = await read()
  }
  return last
}

const orderStatus = (id: string) => async () => ((await admin.from('orders').select('status').eq('id', id).single()).data?.status as string | undefined) ?? null

/** Click the confirm button if the action opened a confirm sheet (actions differ; the sheet's CTA starts with "Yes"). */
async function confirmIfAsked(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog')
  if (await dialog.isVisible({ timeout: 3000 }).catch(() => false)) {
    await dialog.getByRole('button', { name: /^Yes/ }).click()
  }
}

/** The order workspace's NextStepBar primary action (its label is the action's name). */
async function nextStep(page: Page, label: string | RegExp): Promise<void> {
  // Act on the bar on screen. More than one in the DOM is worth knowing about (it has happened once, after a
  // redirect into the order), so say so without failing the step.
  const bar = page.getByTestId('order-next-step-bar').filter({ visible: true }).first()
  await bar.waitFor()
  const n = await page.getByTestId('order-next-step-bar').count()
  if (n > 1) {
    // Where each copy lives: visible or not, and its nearest identifiable ancestors.
    const where = await page.getByTestId('order-next-step-bar').evaluateAll((els) => els.map((el) => {
      const chain: string[] = []
      for (let p = el.parentElement; p && chain.length < 6; p = p.parentElement) {
        const id = p.id ? `#${p.id}` : ''
        const tid = p.getAttribute('data-testid') ? `[${p.getAttribute('data-testid')}]` : ''
        const hid = p.hidden || p.getAttribute('aria-hidden') === 'true' ? '(hidden)' : ''
        if (id || tid || hid) chain.push(`${p.tagName.toLowerCase()}${id}${tid}${hid}`)
      }
      const r = el.getBoundingClientRect()
      return `${r.width > 0 && r.height > 0 ? 'visible' : 'not visible'} next=${el.getAttribute('data-next')} in ${chain.join(' < ') || '(no marked ancestor)'}`
    }))
    console.log(`    ! ${n} next-step bars in the DOM on ${new URL(page.url()).pathname}: ${where.join(' | ')}`)
  }
  await bar.getByRole('button', { name: label }).click()
}

// ── Journey A: package → order → delivery → payout ─────────────────────────────
async function journeyA(): Promise<void> {
  console.log('\nA — buy a package, deliver it, release the payout (browser)')
  const { data: cat } = await admin.from('categories').select('id, commission_bps').eq('slug', 'tax-accounting').single()
  const prov = await mkProvider('provA', `E2E Studio ${tag}`)
  const buyer = await mkBuyer('buyerA')
  const adm = await mkUser('adminA', ['msme', 'admin'])
  await acceptLegal(adm)
  const pkgSlug = `${tag}-gst-registration`
  const { data: pkg, error: pkgErr } = await admin.from('packages').insert({
    provider_id: prov.providerId, category_id: cat!.id, slug: pkgSlug, title_i18n: { en: 'E2E GST registration' },
    scope_included: ['GSTIN application', 'ARN tracking'], deliverables: ['GST certificate'], price_paise: 4999_00, discount_bps: 0,
    delivery_days: 3, revision_count: 1, status: 'active',
  }).select('id').single()
  if (pkgErr || !pkg) throw new Error(`package: ${pkgErr?.message}`)
  created.packageIds.push(pkg.id)
  const expected = computeOrderAmounts({ pricePaise: 4999_00, discountBps: 0, commissionBps: cat!.commission_bps ?? 1000 })

  const b = await pageFor(buyer)
  const p = await pageFor(prov)
  const a = await pageFor(adm)
  const all = [b.page, p.page, a.page]
  let orderId = ''
  try {
    await step('A', 'package page shows the full price and a Buy now button', all, async () => {
      await b.page.goto(`${BASE}/p/${prov.slug}/${pkgSlug}`)
      await b.page.getByTestId('price-equation').first().waitFor()
      await b.page.getByTestId('buy-now').waitFor()
    })
    await step('A', 'Buy now opens checkout ready to pay', all, async () => {
      await b.page.getByTestId('buy-now').click()
      await b.page.waitForURL(new RegExp(`/app/checkout/${pkg.id}`))
      await b.page.locator('[data-testid="checkout-v3"][data-mode="pay"]').waitFor()
    })
    await step('A', 'Pay (simulated) lands on the new order', all, async () => {
      await b.page.getByTestId('checkout-pay').click()
      await b.page.waitForURL(/\/app\/orders\/[0-9a-f-]{36}/)
      orderId = b.page.url().match(/\/app\/orders\/([0-9a-f-]{36})/)![1]!
      const { data: o } = await admin.from('orders').select('status, total_paise, package_id, msme_id').eq('id', orderId).single()
      if (o?.status !== 'placed' || o.package_id !== pkg.id || o.msme_id !== buyer.msmeId) throw new Error(`order row ${JSON.stringify(o)}`)
      if (Number(o.total_paise) !== expected.totalPaise) throw new Error(`charged ${o.total_paise}, page promised ${expected.totalPaise}`)
    })
    await step('A', 'provider accepts the order from the next-step bar', all, async () => {
      await p.page.goto(`${BASE}/partner/orders/${orderId}`)
      await nextStep(p.page, 'Accept order')
      await confirmIfAsked(p.page)
      await until('accepted', orderStatus(orderId), (s) => s === 'accepted')
    })
    await step('A', 'buyer shares requirements', all, async () => {
      await b.page.goto(`${BASE}/app/orders/${orderId}`)
      await nextStep(b.page, 'Share requirements')
      const box = b.page.locator('textarea').first()
      await box.waitFor()
      await box.fill('PAN, Aadhaar and the rent agreement for the Gangtok office are ready to share.')
      await b.page.getByRole('button', { name: 'Submit requirements' }).click()
      await until('requirements_submitted', orderStatus(orderId), (s) => s === 'requirements_submitted')
    })
    await step('A', 'provider starts work', all, async () => {
      await p.page.goto(`${BASE}/partner/orders/${orderId}`)
      await nextStep(p.page, 'Start work')
      await confirmIfAsked(p.page)
      await until('in_progress', orderStatus(orderId), (s) => s === 'in_progress')
    })
    await step('A', 'provider attaches a deliverable and marks delivered', all, async () => {
      await p.page.goto(`${BASE}/partner/orders/${orderId}`)
      await nextStep(p.page, 'Upload & deliver')
      await p.page.locator('input[type="file"]').first().setInputFiles({ name: 'gst-certificate.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% e2e deliverable\n') })
      await until('deliverable uploaded', async () => (await admin.from('order_documents').select('id').eq('order_id', orderId).eq('kind', 'deliverable')).data?.length ?? 0, (n) => n > 0)
      await p.page.getByRole('button', { name: 'Mark delivered' }).first().click()
      await confirmIfAsked(p.page)
      await until('delivered', orderStatus(orderId), (s) => s === 'delivered')
    })
    await step('A', 'buyer accepts delivery → order completed, payout held', all, async () => {
      await b.page.goto(`${BASE}/app/orders/${orderId}`)
      await nextStep(b.page, 'Accept delivery')
      await confirmIfAsked(b.page)
      await until('completed', orderStatus(orderId), (s) => s === 'completed')
      await until('held payout', async () => (await admin.from('payouts').select('status').eq('order_id', orderId).maybeSingle()).data?.status ?? null, (s) => s === 'held')
    })
    await step('A', 'admin releases the payout from /admin/payouts', all, async () => {
      const { data: o } = await admin.from('orders').select('order_number').eq('id', orderId).single()
      await a.page.goto(`${BASE}/admin/payouts`)
      const row = a.page.locator('tr', { hasText: String(o!.order_number) })
      await row.getByRole('button', { name: 'Retry payout' }).click()
      await until('payout released', async () => (await admin.from('payouts').select('status').eq('order_id', orderId).maybeSingle()).data?.status ?? null, (s) => s === 'paid' || s === 'processing')
    })
  } catch (e) {
    if (!(e instanceof JourneyStop)) throw e
    console.log('  … journey A stopped (later steps depend on the failed one)')
  } finally {
    await b.ctx.close(); await p.ctx.close(); await a.ctx.close()
  }
}

// ── Journey B: requirement → quote → pay ───────────────────────────────────────
async function journeyB(): Promise<void> {
  console.log('\nB — post a requirement, get a quote, accept and pay (browser)')
  const { data: cat } = await admin.from('categories').select('id').eq('slug', 'tax-accounting').single()
  const prov = await mkProvider('provB', `E2E Tax Desk ${tag}`)
  await admin.from('provider_categories').insert({ provider_id: prov.providerId, category_id: cat!.id })
  const buyer = await mkBuyer('buyerB')

  const b = await pageFor(buyer)
  const p = await pageFor(prov)
  const all = [b.page, p.page]
  let rfqId = ''
  try {
    await step('B', 'requirement form (prefilled category) sends to providers', all, async () => {
      await b.page.goto(`${BASE}/app/rfq/new?category=tax-accounting`)
      await b.page.locator('#rfq-title').fill('ITR filing for FY 2025-26, small trading firm')
      await b.page.locator('#f-filing_type').click()
      await b.page.getByRole('option', { name: 'ITR Filing' }).click()
      await b.page.locator('#f-financial_year').fill('2025-26')
      await b.page.getByRole('radiogroup', { name: 'Annual Turnover' }).getByRole('radio', { name: '₹1–5 crore' }).click()
      await b.page.locator('#rfq-free').fill('Books are kept in Tally; about 120 invoices a month.')
      await b.page.getByTestId('rfq-submit').click()
      await b.page.waitForURL(/\/app\/rfq\/[0-9a-f-]{36}/)
      rfqId = b.page.url().match(/\/app\/rfq\/([0-9a-f-]{36})/)![1]!
      created.rfqIds.push(rfqId)
    })
    await step('B', 'fan-out reached the matching provider', all, async () => {
      await until('rfq match', async () => (await admin.from('rfq_matches').select('provider_id').eq('rfq_id', rfqId)).data?.map((m) => m.provider_id) ?? [], (ids) => ids.includes(prov.providerId))
    })
    await step('B', 'provider sends a quote from the inbox', all, async () => {
      await p.page.goto(`${BASE}/partner/rfqs/${rfqId}`)
      await p.page.locator('#q-price').fill('7500')
      await p.page.locator('#q-days').fill('5')
      await p.page.locator('#q-scope').fill('ITR-3 preparation and filing, computation, and one revision if the department asks.')
      await p.page.getByRole('radiogroup', { name: 'GST' }).getByRole('radio', { name: 'Extra' }).click()
      await p.page.getByRole('button', { name: '7 d' }).click()
      await p.page.getByRole('button', { name: 'Send quote' }).click()
      await until('quote', async () => (await admin.from('quotes').select('id, status').eq('rfq_id', rfqId).eq('provider_id', prov.providerId)).data ?? [], (qs) => qs.length === 1)
    })
    await step('B', 'buyer accepts the quote and pays (simulated) → paid order', all, async () => {
      await b.page.goto(`${BASE}/app/rfq/${rfqId}`)
      await b.page.getByRole('button', { name: /Accept & pay/ }).filter({ visible: true }).first().click()
      await b.page.getByRole('dialog').getByRole('button', { name: /Continue to payment/ }).click()
      await b.page.waitForURL(/\/app\/orders\/[0-9a-f-]{36}/)
      const orderId = b.page.url().match(/\/app\/orders\/([0-9a-f-]{36})/)![1]!
      const { data: o } = await admin.from('orders').select('status, quote_id, provider_id').eq('id', orderId).single()
      if (o?.status !== 'placed' || o.provider_id !== prov.providerId || !o.quote_id) throw new Error(`order row ${JSON.stringify(o)}`)
      const { data: q } = await admin.from('quotes').select('status').eq('id', o.quote_id).single()
      if (q?.status !== 'accepted') throw new Error(`quote status ${q?.status}`)
    })
  } catch (e) {
    if (!(e instanceof JourneyStop)) throw e
    console.log('  … journey B stopped (later steps depend on the failed one)')
  } finally {
    await b.ctx.close(); await p.ctx.close()
  }
}

// ── Journey C: search from the top bar; sheets sit where they belong ───────────
/** The results panel opens right under the field it belongs to — not as a dialog somewhere else. */
async function expectPanelUnderField(page: Page): Promise<void> {
  const field = page.getByTestId('header-search')
  await field.click()
  await field.fill('gst')
  const panel = page.getByTestId('header-search-panel')
  await panel.waitFor()
  if (await page.getByRole('dialog').isVisible().catch(() => false)) throw new Error('typing in the header opened a dialog')
  const f = (await field.boundingBox())!
  const p = (await panel.boundingBox())!
  const gap = p.y - (f.y + f.height)
  if (gap < 0 || gap > 24 || p.x > f.x || f.x - p.x > 64) throw new Error(`panel not under the field: field ${JSON.stringify(f)} panel ${JSON.stringify(p)}`)
}

async function journeyC(): Promise<void> {
  console.log('\nC — search from the top bar; a sheet on a wide screen is centred (browser)')
  const buyer = await mkBuyer('buyerC')
  const b = await pageFor(buyer)
  const tab = await pageFor(buyer, { width: 900, height: 800 })
  const guestCtx = await browser!.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', locale: 'en-IN' })
  const guest = await guestCtx.newPage()
  guest.setDefaultTimeout(STEP_TIMEOUT)
  const all = [b.page, tab.page, guest]
  try {
    await step('C', 'typing in the signed-in top bar shows results right under the field', all, async () => {
      await b.page.goto(`${BASE}/app`)
      await expectPanelUnderField(b.page)
    })
    await step('C', '"See all results" opens the buyer search for the term', all, async () => {
      await b.page.getByTestId('header-search-panel').getByRole('button', { name: /See all results/ }).click()
      await b.page.waitForURL(/\/app\/search\?query=gst/)
    })
    await step('C', 'the public header searches in place too', all, async () => {
      await guest.goto(`${BASE}/services`)
      await expectPanelUnderField(guest)
    })
    await step('C', 'a sheet on a wide screen sits in the middle of the window', all, async () => {
      await tab.page.goto(`${BASE}/app/search?query=gst`)
      await tab.page.getByTestId('filter-more').click()
      const dialog = tab.page.getByRole('dialog')
      await dialog.waitFor()
      // The sheet animates in; wait for its box to settle on the centre (it sat with its corner there before the fix).
      await until('the sheet centred in a 900×800 window', async () => await dialog.boundingBox(),
        (bx) => !!bx && Math.abs(bx.x + bx.width / 2 - 450) <= 4 && Math.abs(bx.y + bx.height / 2 - 400) <= 4, 5000)
    })
  } catch (e) {
    if (!(e instanceof JourneyStop)) throw e
    console.log('  … journey C stopped (later steps depend on the failed one)')
  } finally {
    await b.ctx.close(); await tab.ctx.close(); await guestCtx.close()
  }
}

// ── Journey D: the assistant, minimised in the corner (agent-on server) ────────
async function journeyD(): Promise<void> {
  const AGENT = process.env['AGENT_BASE_URL']
  if (!AGENT) { console.log('\nD — skipped (AGENT_BASE_URL is not set: the corner assistant needs AGENT_ENABLED)'); return }
  console.log('\nD — the corner assistant opens, explains itself, hides and comes back (browser, agent-on server)')
  const buyer = await mkBuyer('buyerD')
  const b = await pageFor(buyer)
  const phone = await pageFor(buyer, { width: 390, height: 844 })
  const all = [b.page, phone.page]
  try {
    await step('D', 'the assistant sits minimised in the corner of the buyer home', all, async () => {
      await b.page.goto(`${AGENT}/app`)
      await b.page.getByTestId('assistant-launcher-button').waitFor()
    })
    await step('D', 'opening it offers what it can do now, in plain words', all, async () => {
      await b.page.getByTestId('assistant-launcher-button').click()
      const panel = b.page.getByRole('dialog', { name: 'AMClub assistant' })
      await panel.waitFor()
      await panel.getByRole('link', { name: /Speak or type what you need/ }).waitFor()
    })
    await step('D', '"What can the assistant do?" opens the assistant home', all, async () => {
      await b.page.getByRole('link', { name: /What can the assistant do/ }).click()
      await b.page.waitForURL(/\/app\/ai$/)
      await b.page.getByTestId('assistant-home').waitFor()
    })
    await step('D', 'its setting hides the corner button, and brings it back', all, async () => {
      const sw = b.page.getByTestId('launcher-pref')
      await sw.click()
      await until('the corner button hidden', async () => await b.page.getByTestId('assistant-launcher-button').count(), (n) => n === 0, 5000)
      await sw.click()
      await b.page.getByTestId('assistant-launcher-button').waitFor()
    })
    await step('D', 'on a phone it sits above the tab bar', all, async () => {
      await phone.page.goto(`${AGENT}/app`)
      const btn = phone.page.getByTestId('assistant-launcher-button')
      await btn.waitFor()
      await until('the corner button above the tab bar', async () => ({ bb: await btn.boundingBox(), tb: await phone.page.locator('nav[data-bottom-bar]').boundingBox() }),
        ({ bb, tb }) => !!bb && !!tb && bb.y + bb.height <= tb.y, 5000)
    })
  } catch (e) {
    if (!(e instanceof JourneyStop)) throw e
    console.log('  … journey D stopped (later steps depend on the failed one)')
  } finally {
    await b.ctx.close(); await phone.ctx.close()
  }
}

// ── cleanup (always) ───────────────────────────────────────────────────────────
async function cleanup(): Promise<void> {
  console.log('\n🧹 cleanup…')
  const t = async (q: PromiseLike<unknown>) => { try { const r = (await q) as { error?: { message: string } | null } | null; if (r?.error) console.error('  ! delete error', r.error.message) } catch (e) { console.error('  ! delete error', (e as Error)?.message ?? e) } }
  for (const mid of created.msmeIds) {
    await t(admin.from('checkout_sessions').delete().eq('msme_id', mid))
    const { data: orders } = await admin.from('orders').select('id').eq('msme_id', mid)
    for (const o of orders ?? []) {
      await t(admin.from('payouts').delete().eq('order_id', o.id))
      const { data: pays } = await admin.from('payments').select('id').eq('order_id', o.id)
      for (const pay of pays ?? []) await t(admin.from('refunds').delete().eq('payment_id', pay.id))
      await t(admin.from('payments').delete().eq('order_id', o.id))
      await t(admin.from('invoices').delete().eq('order_id', o.id))
      await t(admin.from('reviews').delete().eq('order_id', o.id))
      await t(admin.from('order_events').delete().eq('order_id', o.id))
      await t(admin.from('order_documents').delete().eq('order_id', o.id))
      await t(admin.from('orders').delete().eq('id', o.id))
    }
    await t(admin.from('checkout_sessions').delete().eq('msme_id', mid))
    await t(admin.from('conversations').delete().eq('msme_id', mid))
  }
  if (created.rfqIds.length) {
    const { data: qs } = await admin.from('quotes').select('id').in('rfq_id', created.rfqIds)
    const qids = (qs ?? []).map((q) => q.id as string)
    if (qids.length) await t(admin.from('provider_price_book').delete().in('source_quote_id', qids))
    for (const id of created.rfqIds) await t(admin.from('rfqs').delete().eq('id', id))
  }
  for (const id of created.packageIds) await t(admin.from('packages').delete().eq('id', id))
  for (const id of created.providerIds) {
    await t(admin.from('provider_categories').delete().eq('provider_id', id))
    await t(admin.from('provider_bank_accounts').delete().eq('provider_id', id))
    await t(admin.from('provider_profiles').delete().eq('id', id))
  }
  for (const id of created.msmeIds) await t(admin.from('msme_profiles').delete().eq('id', id))
  for (const uid of created.users) {
    await t(admin.from('notifications').delete().eq('user_id', uid))
    await t(admin.from('terms_acceptances').delete().eq('user_id', uid))
    await t(admin.from('audit_logs').delete().eq('actor_id', uid))
    await t(admin.from('users').delete().eq('id', uid))
    await admin.auth.admin.deleteUser(uid).catch(() => {})
  }
}

async function main(): Promise<void> {
  console.log(`\nBrowser journeys → ${BASE}`)
  browser = await chromium.launch()
  try {
    await journeyA()
    await journeyB()
    await journeyC()
    await journeyD()
  } finally {
    await browser.close().catch(() => {})
    await cleanup()
  }
  if (browserErrors.size) {
    console.log(`\nBrowser errors seen during the journeys (${browserErrors.size} distinct):`)
    for (const [k, n] of browserErrors) console.log(`  ! ${k}${n > 1 ? ` (×${n})` : ''}`)
  }
  console.log(`\n${fail === 0 ? '✅ BROWSER JOURNEYS PASSED' : '❌ BROWSER JOURNEYS FAILED'} — ${pass} passed, ${fail} failed (screenshots of failures: e2e-artifacts/)\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error(e)
  await browser?.close().catch(() => {})
  await cleanup().catch(() => {})
  process.exit(1)
})
