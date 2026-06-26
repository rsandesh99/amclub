/**
 * Proves the /signup?complete=1 ↔ /app redirect loop is gone for an AUTHENTICATED
 * user with NO profile (the new Google/email case). Uses @supabase/ssr to mint
 * the exact session cookie the app reads (so no false positives), then hits the
 * deployed app with redirect:'manual' and asserts:
 *   - GET /signup?complete=1  → 200 (renders the wizard, does NOT bounce to /app)
 *   - GET /app                → redirects ONCE to /signup?complete=1 (not a loop)
 *
 * Run: BASE_URL=https://amclub-web.vercel.app tsx scripts/verify-signup-loop.ts
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'

const URL = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })

let pass = 0, fail = 0
const check = (n: string, c: boolean, extra = '') => { if (c) { console.log(`  ✓ ${n} ${extra}`); pass++ } else { console.log(`  ✗ ${n} ${extra}`); fail++ } }

async function main() {
  console.log(`\nSignup-loop verification → ${BASE}\n`)
  const email = `looptest_${Date.now()}@killtest.amclub`
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error(error.message)
  const uid = data.user.id

  // Mint the app's session cookies via @supabase/ssr (exact encoding match).
  const jar: Record<string, string> = {}
  const ssr = createServerClient(URL, ANON, {
    cookies: {
      getAll() { return Object.entries(jar).map(([name, value]) => ({ name, value })) },
      setAll(list) { for (const { name, value } of list) jar[name] = value },
    },
  })
  const { error: signErr } = await ssr.auth.signInWithPassword({ email, password: 'Test1234!' })
  if (signErr) throw new Error('signIn: ' + signErr.message)
  const cookie = Object.entries(jar).map(([n, v]) => `${n}=${v}`).join('; ')
  check('session cookie minted', cookie.length > 0)

  // Canonical (unprefixed) paths — en is the default locale (as-needed prefix).
  const signup = await fetch(`${BASE}/signup?complete=1`, { headers: { cookie }, redirect: 'manual' })
  check('GET /signup?complete=1 renders (200), no bounce', signup.status === 200, `[status ${signup.status}${signup.headers.get('location') ? ' → ' + signup.headers.get('location') : ''}]`)

  const app = await fetch(`${BASE}/app`, { headers: { cookie }, redirect: 'manual' })
  const loc = app.headers.get('location') ?? ''
  check('GET /app redirects once to signup (profile-less)', [302, 303, 307].includes(app.status) && loc.includes('/signup'), `[status ${app.status} → ${loc}]`)

  // Follow from /signup with a hop cap to prove it terminates (no ping-pong).
  let url = `${BASE}/signup?complete=1`
  let hops = 0
  while (hops < 8) {
    const r = await fetch(url, { headers: { cookie }, redirect: 'manual' })
    if (r.status === 200) break
    const next = r.headers.get('location')
    if (!next) break
    url = next.startsWith('http') ? next : `${BASE}${next}`
    hops++
  }
  check('redirect chain terminates (no infinite loop)', hops < 8, `[${hops} hops]`)

  await admin.from('users').delete().eq('id', uid)
  await admin.auth.admin.deleteUser(uid).catch(() => {})

  console.log(`\n${fail === 0 ? '✅ SIGNUP-LOOP FIXED' : '❌ STILL LOOPING'} — ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
