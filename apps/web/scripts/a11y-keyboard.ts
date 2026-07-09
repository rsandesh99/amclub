/**
 * Phase 8 §1 — scripted keyboard pass: Tab-walks the signup → RFQ → checkout
 * journey pages, recording every focus stop and whether it shows a visible
 * focus indicator (outline or focus ring box-shadow). Flags stops with none.
 *
 * Needs the same env as a11y-scan.ts (service key for authed pages).
 * Run: BASE_URL=http://localhost:3100 tsx scripts/a11y-keyboard.ts
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
const tag = `a11ykb_${Date.now()}`

async function mkUser(roles: string[]) {
  const email = `${tag}_u@killtest.amclub`
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error(error.message)
  await admin.from('users').insert({ id: data.user.id, email, roles })
  const jar: Record<string, string> = {}
  const ssr = createServerClient(URL_, ANON, {
    cookies: {
      getAll() { return Object.entries(jar).map(([name, value]) => ({ name, value })) },
      setAll(list) { for (const { name, value } of list) jar[name] = value },
    },
  })
  await ssr.auth.signInWithPassword({ email, password: 'Test1234!' })
  return { uid: data.user.id, cookies: Object.entries(jar).map(([name, value]) => ({ name, value })) }
}

async function main() {
  const user = await mkUser(['msme', 'provider'])
  const browser = await chromium.launch()
  let unfocusable = 0

  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
    await ctx.addCookies(user.cookies.map((c) => ({ ...c, url: BASE })))

    const pages = ['/login', '/signup', '/app/rfq/new', '/partner/onboarding', '/services']
    for (const p of pages) {
      const page = await ctx.newPage()
      await page.goto(`${BASE}${p}`, { waitUntil: 'networkidle', timeout: 45_000 })
      await page.waitForTimeout(500)
      console.log(`\n── ${p} — Tab walk`)
      const seen = new Set<string>()
      for (let i = 0; i < 35; i++) {
        await page.keyboard.press('Tab')
        const info = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null
          if (!el || el === document.body) return null
          const cs = getComputedStyle(el)
          const hasOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0
          const hasRing = cs.boxShadow !== 'none' && cs.boxShadow !== ''
          const name =
            el.getAttribute('aria-label') ??
            (el as HTMLInputElement).placeholder ??
            el.textContent?.trim().slice(0, 40) ??
            ''
          return {
            desc: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} "${name}"`,
            visible: hasOutline || hasRing,
            rect: el.getBoundingClientRect().width > 0,
          }
        })
        if (!info) continue
        if (seen.has(info.desc)) break // wrapped around
        seen.add(info.desc)
        if (!info.visible && info.rect) unfocusable++
        console.log(`  ${info.visible ? '✓' : '✗ NO-INDICATOR'} ${info.desc}`)
      }
      await page.close()
    }
  } finally {
    await browser.close()
    await admin.from('users').delete().eq('id', user.uid)
    await admin.auth.admin.deleteUser(user.uid).catch(() => {})
  }

  console.log(`\n═ keyboard pass: ${unfocusable === 0 ? 'all focus stops have visible indicators' : unfocusable + ' stops WITHOUT visible indicator'}`)
  if (unfocusable > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
