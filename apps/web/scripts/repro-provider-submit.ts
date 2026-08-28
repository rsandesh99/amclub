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

  // 1b) Verify the bank exactly like the wizard does (server records the result;
  //     with no KYC_API_KEY this is the stub, which must NOT count as verified).
  const vb = await fetch(`${BASE}/api/v1/profile/provider/kyc/verify-bank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ accountNumber: '123456789012', ifsc: 'HDFC0001234', holderName: 'Repro Test Associates' }),
  })
  const vbBody = await vb.json().catch(() => ({}))
  console.log(`[verify-bank] STATUS ${vb.status} — verified=${vbBody.verified} stub=${vbBody.stub}`)

  // 1c) Accept Terms + Privacy + Provider Addendum (Phase 2 — the endpoint is gated).
  const legal = await fetch(`${BASE}/api/v1/legal/accept`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ docs: ['terms', 'privacy', 'provider_addendum'], surface: 'web', locale: 'en' }),
  })
  console.log(`[legal/accept] STATUS ${legal.status}`)

  // 2) Submit registration for a credential-requiring category, mirroring the wizard
  //    (credential TYPE + NUMBER + document are all required since 5950c74).
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
    bankVerified: true, // client-asserted — the server must IGNORE this (Phase 1g)
    credentialUploads: { 'tax-accounting': { url: upBody.url, name: 'cred.pdf', kind: 'ca', number: '123456' } },
  }
  const res = await fetch(`${BASE}/api/v1/profile/provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  console.log(`[submit] STATUS ${res.status} — ${text.slice(0, 500)}`)
  const submitted = res.status === 200 && text.includes('under_review')
  console.log(submitted ? '\n✅ submit reached under_review' : '\n❌ submit FAILED')

  // 3) Phase 1g — penny_drop_verified is server-set from the recorded verify-bank
  //    result. The client sent bankVerified:true; the stub answered, so the
  //    stored flag must be FALSE, and the attempt must be on record.
  const { data: prof } = await admin.from('provider_profiles').select('id').eq('user_id', uid).maybeSingle()
  const { data: bank } = prof ? await admin.from('provider_bank_accounts').select('penny_drop_verified').eq('provider_id', prof.id).maybeSingle() : { data: null }
  const { data: attempts } = await admin.from('bank_account_verifications').select('verified, stub, provider').eq('user_id', uid)
  const recorded = (attempts ?? []).length === 1
  const flagOk = bank !== null && bank?.penny_drop_verified === (recorded && attempts![0]!.verified && !attempts![0]!.stub)
  console.log(`[1g] verify-bank attempt recorded=${recorded} (stub=${attempts?.[0]?.stub}) · stored penny_drop_verified=${bank?.penny_drop_verified} → ${flagOk ? '✅ server-set (client flag ignored)' : '❌ WRONG'}`)

  // Cleanup
  await admin.from('bank_account_verifications').delete().eq('user_id', uid)
  if (prof) {
    await admin.from('provider_bank_accounts').delete().eq('provider_id', prof.id)
    await admin.from('provider_verifications').delete().eq('provider_id', prof.id)
    await admin.from('provider_categories').delete().eq('provider_id', prof.id)
    await admin.from('provider_profiles').delete().eq('id', prof.id)
  }
  await admin.from('users').delete().eq('id', uid)
  await admin.auth.admin.deleteUser(uid).catch(() => {})
  console.log('cleaned up.')
  process.exit(submitted && flagOk ? 0 : 1)
}
main().catch((e) => { console.error(e); process.exit(1) })
