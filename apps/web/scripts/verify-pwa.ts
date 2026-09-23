/**
 * Phase 8 §5 — PWA verification: manifest + icons reachable, service worker
 * registers and controls the page, offline banner shows, offline shell for
 * every page. P0-6 (USER_EXPECTATIONS_AUDIT): nothing user-specific is cached
 * (a visited authed page comes back as the offline shell, never a cached
 * copy), and sign-out purges Cache Storage (the worker re-caches the shell).
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

    // Everything in Cache Storage, by cache name + path (P0-6 audit).
    const cacheAudit = () =>
      page.evaluate(async () => {
        const out: { cache: string; path: string }[] = []
        for (const name of await caches.keys()) {
          const c = await caches.open(name)
          for (const req of await c.keys()) out.push({ cache: name, path: new URL(req.url).pathname })
        }
        return out
      })
    const isStatic = (p: string) =>
      p === '/offline.html' || p.startsWith('/_next/static/') || p.startsWith('/icons/') || /.(?:png|jpg|jpeg|svg|webp|woff2?)$/.test(p)

    check('SW cache is the P0-6 version (amclub-sw-v2)', (await cacheAudit()).some((e) => e.cache === 'amclub-sw-v2'))

    // 3. Visit orders (authed) + hit the orders/notifications APIs v1 used to cache.
    await page.goto(`${BASE}/app/orders`, { waitUntil: 'networkidle' })
    const ordersVisible = page.url().includes('/app/orders')
    check('orders list loads (authed)', ordersVisible, page.url())
    await page.evaluate(async () => {
      await Promise.all(['/api/v1/orders', '/api/v1/notifications'].map((u) => fetch(u).catch(() => null)))
    })
    const leaked = (await cacheAudit()).filter((e) => !isStatic(e.path))
    check('nothing user-specific cached (no page / API entries)', leaked.length === 0, leaked.map((e) => e.path).join(', '))

    // 4. Connectivity drops on a loaded page → banner.
    await ctx.setOffline(true)
    const bannerVisible = await page.locator('[role="status"]').isVisible().catch(() => false)
    check('offline banner shows', bannerVisible)

    // 5. Airplane mode: a VISITED authed page must NOT come back from cache —
    //    the next person on a shared device would read it (P0-6).
    await page.goto(`${BASE}/app/orders`, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
    const offlineTitle = await page.title().catch(() => '')
    check('visited authed page OFFLINE → offline shell, not a cached copy', /^Offline/.test(offlineTitle), offlineTitle)

    // 6. Unvisited page while offline → offline shell.
    await page.goto(`${BASE}/help?nocache=${Date.now()}`, { waitUntil: 'load', timeout: 20_000 }).catch(() => {})
    const shellHtml = await page.content()
    check('offline shell for unvisited page', /You.?re offline/i.test(shellHtml))

    // 7. Sign-out purges Cache Storage. Seed what a v1 worker would have left
    //    (a cached authed page + API body), then sign out through the real menu.
    await ctx.setOffline(false)
    // Accept terms + privacy first, or the LegalGate modal covers the account menu.
    const accepted = await page.request.post(`${BASE}/api/v1/legal/accept`, { data: { docs: ['terms', 'privacy'], surface: 'web', locale: 'en' } })
    check('legal accept for the fixture user → 200', accepted.ok(), `status ${accepted.status()}`)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`${BASE}/app/orders`, { waitUntil: 'networkidle' })
    await page.evaluate(async () => {
      await (await caches.open('amclub-sw-v1')).put('/app/orders', new Response('<p>previous user orders</p>', { headers: { 'Content-Type': 'text/html' } }))
      await (await caches.open('amclub-sw-v2')).put('/api/v1/orders', new Response('{"orders":[]}', { headers: { 'Content-Type': 'application/json' } }))
    })
    check('legacy user entries seeded', (await cacheAudit()).filter((e) => !isStatic(e.path)).length === 2)
    let signedOut = true
    try {
      await page.locator('button[aria-haspopup="menu"]').first().click({ timeout: 10_000 })
      await Promise.all([
        page.waitForURL((u) => new URL(u).pathname === '/', { timeout: 20_000 }),
        page.getByRole('menuitem', { name: /sign out|साइन आउट/i }).click({ timeout: 10_000 }),
      ])
    } catch (e) {
      signedOut = false
      console.log(`    sign-out click failed: ${(e as Error).message.split('\n')[0]}`)
    }
    check('signed out through the account menu (landed on /)', signedOut)
    const afterSignOut = await cacheAudit()
    check('sign-out: no cache from the old worker survives', !afterSignOut.some((e) => e.cache === 'amclub-sw-v1'))
    check(
      'sign-out: no page / API entries survive',
      afterSignOut.filter((e) => !isStatic(e.path)).length === 0,
      afterSignOut.filter((e) => !isStatic(e.path)).map((e) => e.path).join(', '),
    )
    // The worker re-precaches the offline shell after its purge (async; poll briefly).
    let shellBack = false
    for (let i = 0; i < 20 && !shellBack; i++) {
      shellBack = (await cacheAudit()).some((e) => e.path === '/offline.html')
      if (!shellBack) await page.waitForTimeout(250)
    }
    check('sign-out: offline shell re-cached by the worker', shellBack)
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
