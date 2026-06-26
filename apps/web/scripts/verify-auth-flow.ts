/**
 * Proves the two auth bugs are fixed, over the REAL API (Bearer).
 *
 * BUG 1 — a brand-new user with NO public.users row (email/Google) can save
 *   their MSME profile (was 401 "Unauthorized"). Asserts the users row gets
 *   created (phone NULL ok) and the profile saves → 200.
 * BUG 2 — new-vs-returning is decided by PROFILE EXISTENCE: /profile/me reports
 *   hasMsmeProfile false before and true after; existing roles are NOT clobbered.
 *
 * Run against a server: BASE_URL=http://localhost:3000 (or the prod URL).
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

const URL = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { console.log(`  ✓ ${n}`); pass++ } else { console.log(`  ✗ ${n}`); fail++ } }
const userIds: string[] = []

async function newUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error('createUser: ' + error.message)
  userIds.push(data.user.id)
  return data.user.id
}
async function token(email: string): Promise<string> {
  const anon = createClient(URL, ANON, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
  if (error || !data.session) throw new Error('signIn: ' + error?.message)
  return data.session.access_token
}
const me = (t: string) => fetch(`${BASE}/api/v1/profile/me`, { headers: { authorization: `Bearer ${t}` } })
const saveMsme = (t: string, body: object) =>
  fetch(`${BASE}/api/v1/profile/msme`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify(body) })

async function main() {
  console.log(`\nAuth-flow verification → ${BASE}\n`)
  const stamp = Date.now()

  // ── BUG 1: new user (no public.users row) saves profile ──
  console.log('BUG 1 — new user with no users row can save profile:')
  const emailA = `authtest_${stamp}@killtest.amclub`
  const a = await newUser(emailA)
  const tA = await token(emailA)

  const { count: rowsBefore } = await admin.from('users').select('id', { count: 'exact', head: true }).eq('id', a)
  check('no public.users row before save', rowsBefore === 0)

  const meBefore = await me(tA)
  const meBeforeJson = await meBefore.json().catch(() => ({}))
  check('/profile/me authenticates the new user (Bearer)', meBefore.status === 200 && meBeforeJson.authenticated === true)
  check('new user reads as isNew (hasMsmeProfile=false)', meBeforeJson.hasMsmeProfile === false)

  const save = await saveMsme(tA, { fullName: 'Auth Test', businessName: 'Auth Biz', preferredLocale: 'en' })
  check('save MSME profile → 200 (was 401)', save.status === 200)

  const { data: userRow } = await admin.from('users').select('phone, email').eq('id', a).maybeSingle()
  check('public.users row created (phone NULL, email set)', userRow != null && userRow.phone === null && userRow.email === emailA)
  const { count: profCount } = await admin.from('msme_profiles').select('id', { count: 'exact', head: true }).eq('user_id', a)
  check('msme_profiles row created', profCount === 1)

  const meAfter = await (await me(tA)).json()
  check('returning signal after save (hasMsmeProfile=true)', meAfter.hasMsmeProfile === true)

  // ── BUG 2: roles preserved (saving msme profile must not wipe provider role) ──
  console.log('\nBUG 2 — existing roles are not clobbered:')
  const emailB = `authtest_prov_${stamp}@killtest.amclub`
  const b = await newUser(emailB)
  await admin.from('users').insert({ id: b, email: emailB, roles: ['provider', 'msme'] })
  const tB = await token(emailB)
  await saveMsme(tB, { fullName: 'Prov Test', businessName: 'Prov Biz', preferredLocale: 'en' })
  const { data: bRow } = await admin.from('users').select('roles').eq('id', b).single()
  check('provider role preserved after msme profile save', ((bRow?.roles as string[] | undefined) ?? []).includes('provider'))

  await cleanup()
  console.log(`\n${fail === 0 ? '✅ AUTH-FLOW VERIFICATION PASSED' : '❌ FAILED'} — ${pass} passed, ${fail} failed\n`)
  process.exit(fail === 0 ? 0 : 1)
}

async function cleanup() {
  for (const id of userIds) {
    await admin.from('msme_profiles').delete().eq('user_id', id)
    await admin.from('users').delete().eq('id', id)
    await admin.auth.admin.deleteUser(id).catch(() => {})
  }
}

main().catch(async (e) => { console.error(e); await cleanup().catch(() => {}); process.exit(1) })
