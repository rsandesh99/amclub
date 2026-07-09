/**
 * Phase 8 §2 — load-test fixture prep. Creates the kill-test population the k6
 * scripts drive: 25 buyers (msme profiles + Bearer tokens), 1 active provider
 * with 1 active package, and a 1s probe WAV for the voice-parse ceiling test.
 *
 * Writes loadtest/.ctx.json + loadtest/.probe.wav (both gitignored).
 * ALWAYS pair with loadtest-cleanup.ts afterwards — the k6 runs create real
 * orders/RFQs in the shared DB and nothing may linger (no-test-residue rule).
 *
 * Run: tsx scripts/loadtest-prep.ts
 */
import { config } from 'dotenv'
import path from 'path'
import fs from 'fs'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ANON = process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })
const OUT_DIR = path.resolve(__dirname, '../../../loadtest')

const BUYERS = 25
const tag = `lt_${Date.now()}`

/** Minimal valid 16kHz mono 16-bit PCM WAV of `seconds` silence. */
function silenceWav(seconds: number): Buffer {
  const rate = 16_000
  const samples = Math.round(rate * seconds)
  const data = Buffer.alloc(samples * 2)
  const buf = Buffer.alloc(44 + data.length)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data.length, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(data.length, 40); data.copy(buf, 44)
  return buf
}

async function mkBuyer(i: number) {
  const email = `${tag}_buyer${i}@killtest.amclub`
  const { data, error } = await admin.auth.admin.createUser({ email, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error(`buyer${i}: ${error.message}`)
  await admin.from('users').insert({ id: data.user.id, email, roles: ['msme'] })
  const { data: msme } = await admin
    .from('msme_profiles')
    .insert({ user_id: data.user.id, business_name: `LT Buyer ${i}`, state: 'KA', sector: 'services' })
    .select('id')
    .single()
  const anon = createClient(URL_, ANON, { auth: { persistSession: false } })
  const { data: s, error: sErr } = await anon.auth.signInWithPassword({ email, password: 'Test1234!' })
  if (sErr) throw new Error(`signIn buyer${i}: ${sErr.message}`)
  return { uid: data.user.id, msmeId: msme!.id, token: s.session!.access_token }
}

async function main() {
  console.log(`loadtest prep (tag ${tag}) — ${BUYERS} buyers + provider + package`)

  const buyers = []
  for (let i = 0; i < BUYERS; i++) buyers.push(await mkBuyer(i))

  // Provider + package under a real category so checkout/RFQ hit real paths.
  const provEmail = `${tag}_prov@killtest.amclub`
  const { data: provUser, error } = await admin.auth.admin.createUser({ email: provEmail, password: 'Test1234!', email_confirm: true })
  if (error) throw new Error(error.message)
  await admin.from('users').insert({ id: provUser.user.id, email: provEmail, roles: ['provider'] })
  const { data: prov } = await admin.from('provider_profiles').insert({
    user_id: provUser.user.id, legal_name: 'LT Provider', display_name: 'LT Provider',
    slug: `${tag}-prov`.replace(/_/g, '-'), state: 'KA', status: 'active', languages: ['en'],
  }).select('id').single()
  await admin.from('provider_bank_accounts').insert({
    provider_id: prov!.id, account_number_enc: 'enc_test', ifsc: 'HDFC0000001',
    account_holder: 'LT Provider', penny_drop_verified: true,
  })
  const { data: cat } = await admin.from('categories').select('id, slug').eq('slug', 'tax-accounting').single()
  await admin.from('provider_categories').insert({ provider_id: prov!.id, category_id: cat!.id })
  const { data: pkg } = await admin.from('packages').insert({
    provider_id: prov!.id, category_id: cat!.id, slug: `${tag}-pkg`.replace(/_/g, '-'),
    title_i18n: { en: 'LT package', hi: 'LT' }, price_paise: 500_000, discount_bps: 0,
    delivery_days: 3, revision_count: 1, status: 'active',
    scope_included: ['x'], scope_excluded: [], deliverables: ['y'],
  }).select('id').single()

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, '.probe.wav'), silenceWav(1))
  fs.writeFileSync(
    path.join(OUT_DIR, '.ctx.json'),
    JSON.stringify(
      {
        tag,
        createdAt: new Date().toISOString(),
        buyers: buyers.map((b) => ({ token: b.token, uid: b.uid, msmeId: b.msmeId })),
        providerUid: provUser.user.id,
        providerId: prov!.id,
        packageId: pkg!.id,
        categorySlug: cat!.slug,
      },
      null,
      2,
    ),
  )
  console.log(`wrote loadtest/.ctx.json (${BUYERS} buyers, package ${pkg!.id})`)
  console.log('run k6 now, then ALWAYS: tsx scripts/loadtest-cleanup.ts')
}

main().catch((e) => { console.error(e); process.exit(1) })
