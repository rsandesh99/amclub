/** S2 byte-identity fixtures: capture BEFORE-state of the two views (REST,
 *  service role) and a killtest user's /profile/me snapshot from the LIVE
 *  (pre-S2) build. Mode: --before or --after (fixture file suffix). */
import { config } from 'dotenv'
import path from 'path'
import { writeFileSync } from 'fs'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const BASE = process.env['BASE_URL'] ?? 'https://amclub.in'
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })
const suffix = process.argv.includes('--after') ? 'after' : 'before'
const OUT = (n: string) => path.resolve(__dirname, `../.s2-fixtures/${n}.${suffix}.json`)

async function main() {
  const { mkdirSync } = await import('fs')
  mkdirSync(path.resolve(__dirname, '../.s2-fixtures'), { recursive: true })

  const { data: score, error: sErr } = await admin
    .from('provider_score_inputs_v1')
    .select('*')
    .order('provider_id')
  if (sErr) throw sErr
  writeFileSync(OUT('score-view'), JSON.stringify(score, null, 1))
  console.log(`score-view ${suffix}: ${score?.length ?? 0} rows`)

  const { data: safe, error: oErr } = await admin
    .from('order_safe_view')
    .select('*')
    .order('id')
    .limit(50)
  if (oErr) throw oErr
  writeFileSync(OUT('order-safe-view'), JSON.stringify(safe, null, 1))
  console.log(`order_safe_view ${suffix}: ${safe?.length ?? 0} rows`)

  // profile/me snapshot for a fresh killtest user against the deployed build.
  const email = `s2snap_${Date.now()}@killtest.amclub`
  const { data: u, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw error
  try {
    const anon = createClient(URL_, ANON, { auth: { persistSession: false } })
    const { data: s } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
    const res = await fetch(`${BASE}/api/v1/profile/me`, { headers: { Authorization: `Bearer ${s!.session!.access_token}` } })
    const me = await res.json()
    // Normalize the per-run fields so before/after diff shows only shape changes.
    me.id = '<uid>'
    writeFileSync(OUT('profile-me'), JSON.stringify(me, null, 1))
    console.log(`profile/me ${suffix} keys: ${Object.keys(me).sort().join(', ')}`)
  } finally {
    await admin.auth.admin.deleteUser(u.user.id)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
