/**
 * Reproduces provider registration against the deployed app, faithfully:
 * mints a real session, UPLOADS a credential (multipart, like the wizard),
 * then submits a registration for a credential-requiring category. Prints the
 * actual status + body the client hides behind the generic message.
 *
 * Run: BASE_URL=https://amclub-web.vercel.app tsx scripts/repro-provider-submit.ts
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

async function main() {
  console.log(`\nProvider-submit repro → ${BASE}\n`)
  const email = `provsubmit_${Date.now()}@killtest.amclub`
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error(error.message)
  const uid = data.user.id

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

  // 1) Upload a credential exactly like the wizard does (multipart PDF).
  const fd = new FormData()
  fd.append('file', new Blob([Buffer.from('%PDF-1.4\n% fake test pdf\n')], { type: 'application/pdf' }), 'cred.pdf')
  fd.append('category', 'tax-accounting')
  const upRes = await fetch(`${BASE}/api/v1/profile/provider/credential-upload`, { method: 'POST', headers: { cookie }, body: fd })
  const upBody = await upRes.json().catch(() => ({}))
  console.log(`[upload] STATUS ${upRes.status} — url=${JSON.stringify(upBody.url)} (type ${typeof upBody.url})`)

  // 2) Submit registration for a credential-requiring category, mirroring the wizard.
  const payload = {
    legalName: 'Repro Test Associates',
    displayName: 'Repro Test',
    about: 'Reproduction test provider',
    gstin: '29ABCDE1234F1Z5',
    pan: 'ABCDE1234F',
    categorySlugs: ['tax-accounting'],
    state: 'KA',
    city: 'Bengaluru',
    languages: ['en'],
    bankIfsc: 'HDFC0001234',
    bankAccount: '123456789012',
    bankHolder: 'Repro Test Associates',
    bankVerified: true,
    credentialUploads: { 'tax-accounting': { url: upBody.url, name: 'cred.pdf' } },
  }
  const res = await fetch(`${BASE}/api/v1/profile/provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  console.log(`[submit] STATUS ${res.status} — ${text.slice(0, 500)}`)
  console.log(res.status === 200 && text.includes('under_review')
    ? '\n✅ submit reached under_review'
    : '\n❌ submit FAILED')

  // Cleanup
  const { data: prof } = await admin.from('provider_profiles').select('id').eq('user_id', uid).maybeSingle()
  if (prof) {
    await admin.from('provider_bank_accounts').delete().eq('provider_id', prof.id)
    await admin.from('provider_verifications').delete().eq('provider_id', prof.id)
    await admin.from('provider_categories').delete().eq('provider_id', prof.id)
    await admin.from('provider_profiles').delete().eq('id', prof.id)
  }
  await admin.from('users').delete().eq('id', uid)
  await admin.auth.admin.deleteUser(uid).catch(() => {})
  console.log('cleaned up.')
}
main().catch((e) => { console.error(e); process.exit(1) })
