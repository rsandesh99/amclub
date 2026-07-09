/**
 * Phase 8 §5 — PWA verification: manifest + icons reachable, service worker
 * registers and controls the page, orders list readable from cache offline
 * (read-only, §3.8), offline shell for unvisited pages, offline banner shows.
 *
 * Run against a production `next start` (SW registers only in production):
 *   BASE_URL=http://localhost:3100 tsx scripts/verify-pwa.ts
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'

const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })
const tag = `pwa_${Date.now()}`
let pass = 0
let fail = 0
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`)
  ok ? pass++ : fail++
}

async function main() {
  console.log(`\nPWA verification → ${BASE}\n`)

  // Buyer session for the authed orders page.
  const email = `${tag}@killtest.amclub`
  const { data: u, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error(error.message)
  await admin.from('users').insert({ id: u.user.id, email, roles: ['msme'] })
  const { data: msme } = await admin.from('msme_profiles').insert({ user_id: u.user.id, business_name: 'PWA Co', state: 'KA', sector: 'services' }).select('id').single()
  const jar: Record<string, string> = {}
  const ssr = createServerClient(URL_, ANON, {
    cookies: {
      getAll() { return Object.entries(jar).map(([name, value]) => ({ name, value })) },
      setAll(list) { for (const { name, value } of list) jar[name] = value },
    },
  })
  await ssr.auth.signInWithPassword({ email, password: 'Test1234!' })

  const browser = await chromium.launch()
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
    await ctx.addCookies(Object.entries(jar).map(([name, value]) => ({ name, value, url: BASE })))
    const page = await ctx.newPage()

    // 1. Manifest + icons
    const mf = await page.request.get(`${BASE}/manifest.webmanifest`)
    const mfJson = mf.ok() ? await mf.json() : null
    check('manifest.webmanifest serves', mf.ok(), `status ${mf.status()}`)
    check(
      'manifest has name/theme/512+192 icons/standalone',
      !!mfJson &&
        mfJson.name?.includes('AMClub') &&
        mfJson.theme_color === '#1B4D3E' &&
        mfJson.display === 'standalone' &&
        mfJson.icons?.some((i: { sizes: string }) => i.sizes === '512x512') &&
        mfJson.icons?.some((i: { sizes: string }) => i.sizes === '192x192'),
    )
    for (const icon of ['icon-192.png', 'icon-512.png', 'icon-512-maskable.png']) {
      const r = await page.request.get(`${BASE}/icons/${icon}`)
      check(`icon ${icon}`, r.ok())
    }

    // 2. SW registers + takes control
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
    const swState = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready
      return { scope: reg.scope, active: !!reg.active }
    })
    check('service worker active', swState.active, swState.scope)
    // First load isn't SW-controlled (clients.claim applies after activation) — reload.
    await page.reload({ waitUntil: 'networkidle' })
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller)
    check('page controlled by SW after reload', controlled)

    // 3. Visit orders (authed) so its HTML lands in the SW cache.
    await page.goto(`${BASE}/app/orders`, { waitUntil: 'networkidle' })
    const ordersVisible = page.url().includes('/app/orders')
    check('orders list loads (authed)', ordersVisible, page.url())

    // 4. Airplane mode: orders page must still render from cache (read-only).
    await ctx.setOffline(true)
    await page.goto(`${BASE}/app/orders`, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
    const offlineOrdersHtml = await page.content()
    check(
      'orders list readable OFFLINE from cache',
      offlineOrdersHtml.includes('orders') || offlineOrdersHtml.includes('Orders') || offlineOrdersHtml.includes('ऑर्डर'),
    )
    const bannerVisible = await page.locator('[role="status"]').isVisible().catch(() => false)
    check('offline banner shows', bannerVisible)

    // 5. Unvisited page while offline → offline shell.
    await page.goto(`${BASE}/help?nocache=${Date.now()}`, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
    const shellHtml = await page.content()
    check('offline shell for unvisited page', /You.?re offline/i.test(shellHtml))

    await ctx.setOffline(false)
  } finally {
    await browser.close()
    await admin.from('msme_profiles').delete().eq('user_id', u.user.id)
    await admin.from('users').delete().eq('id', u.user.id)
    await admin.auth.admin.deleteUser(u.user.id).catch(() => {})
  }

  console.log(`\n═ PWA: ${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
