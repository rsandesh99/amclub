/**
 * S3.6 — Telugu render assertions (verify-* convention).
 *
 * te is a FIRST-CLASS locale with en fallback. Two guarantees this checks
 * against the deployed build, over EN/HI/TE:
 *   1. No page leaks a raw i18n key as visible text (e.g. `gateway.` fragments,
 *      MISSING_MESSAGE) in ANY locale — the deep-merge fallback must always
 *      resolve to a real string.
 *   2. Pages that have REAL te translations today (TE_ASSERTED_PAGES) actually
 *      render Telugu script — they are not silently falling all the way back
 *      to English. Untranslated pages are deliberately NOT asserted for
 *      Telugu presence (en fallback there is correct); they only get the
 *      no-raw-key check.
 *
 * TE_ASSERTED_PAGES grows as translation lands. Adding a page here without its
 * te keys will fail check (2) — the intended forcing function.
 *
 * Run: BASE_URL=https://amclub.in pnpm --filter @amclub/web exec tsx scripts/verify-te-render.ts
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })

const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'

// Pages with real te keys today (gateway + voice namespaces per S3 audit).
// The gateway '/' is the only fully-te public surface right now.
const TE_ASSERTED_PAGES = ['/']

// Every public page gets the no-raw-key check in all three locales.
const ALL_PAGES = ['/', '/services', '/terms', '/privacy', '/refund-policy', '/login', '/signup', '/help']

const TELUGU_RE = /[ఀ-౿]/ // Telugu Unicode block
// Raw-key leak signatures: a namespaced key rendered as visible text, or the
// next-intl missing-message sentinel.
const RAW_KEY_RE = /MISSING_MESSAGE|>\s*(gateway|catalog|auth|common|order|rfq|listings|provider_signup|msme_home|partner_home|shell|legal)\.[a-z_]+\s*</i

let pass = 0
let fail = 0
const ok = (n: string, c: boolean, extra = '') => {
  console.log(`  ${c ? '✓' : '✗'} ${n}${extra ? ' ' + extra : ''}`)
  c ? pass++ : fail++
}

function localePath(locale: string, p: string): string {
  if (locale === 'en') return p === '/' ? '/' : p
  return `/${locale}${p === '/' ? '' : p}`
}

async function main() {
  console.log(`\nTelugu render assertions → ${BASE}\n`)

  console.log('No raw i18n keys leak as visible text (en / hi / te):')
  for (const locale of ['en', 'hi', 'te']) {
    for (const p of ALL_PAGES) {
      const url = `${BASE}${localePath(locale, p)}`
      const res = await fetch(url, { headers: { 'Accept-Language': locale } })
      const html = await res.text()
      const leak = html.match(RAW_KEY_RE)
      ok(`${locale} ${p} → HTTP ${res.status}, no raw key`, res.status === 200 && !leak, leak ? `LEAK: ${leak[0].slice(0, 40)}` : '')
    }
  }

  console.log('\nTE_ASSERTED_PAGES actually render Telugu script:')
  for (const p of TE_ASSERTED_PAGES) {
    const res = await fetch(`${BASE}${localePath('te', p)}`, { headers: { 'Accept-Language': 'te' } })
    const html = await res.text()
    // Count Telugu chars in the body (rough — the whole doc, but chrome + the
    // te.json content both contribute; zero would mean the locale broke).
    const count = (html.match(/[ఀ-౿]/g) ?? []).length
    ok(`te ${p} contains Telugu script`, TELUGU_RE.test(html), `(${count} Telugu chars)`)
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} te-render: ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
