/**
 * RLS test suite — Phase 1 done-criteria.
 * Uses Supabase admin API to create test users, then runs queries as those
 * users via SET LOCAL to simulate their JWT, and asserts access is correct.
 *
 * Tests:
 *  T1: MSME cannot read another MSME's order
 *  T2: Unverified provider (status≠active) is invisible to anonymous users
 *  T3: Anonymous user can read active packages only (not draft/paused/removed)
 *  T4: Provider reads only rfq_matches where provider_id = their own id
 */

import postgres from 'postgres'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.resolve(__dirname, '../../../../apps/web/.env.local') })
dotenv.config({ path: path.resolve(__dirname, '../../../../.env.local') })

const SUPABASE_URL = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE_ROLE_KEY = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const DATABASE_URL = process.env['DATABASE_URL']!

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !DATABASE_URL) {
  throw new Error('Missing required env vars')
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// Direct postgres connection (bypasses RLS via service role for setup/teardown)
const db = postgres(DATABASE_URL, { max: 1 })

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function createTestUser(phone: string, role: 'msme' | 'provider') {
  const { data, error } = await admin.auth.admin.createUser({
    phone,
    phone_confirm: true,
    user_metadata: { full_name: `Test ${role}` },
  })
  if (error) throw new Error(`createUser failed: ${error.message}`)
  const userId = data.user.id

  // Insert into public.users
  await db`
    INSERT INTO users (id, phone, full_name, roles)
    VALUES (${userId}, ${phone}, ${'Test ' + role}, ${[role]})
    ON CONFLICT (id) DO NOTHING
  `
  return userId
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let msme1Id: string, msme2Id: string, provider1Id: string, provider2Id: string
let msme1ProfileId: string, msme2ProfileId: string
let provider1ProfileId: string, provider2ProfileId: string
let order1Id: string, package1Id: string, package2Id: string
let rfq1Id: string

async function setup() {
  console.log('\n⚙ Setting up test data...')

  // Create auth users — use last 5 digits of timestamp to keep phone ≤15 digits
  const ts = String(Date.now()).slice(-5)
  msme1Id = await createTestUser(`+9190000${ts}01`, 'msme')
  msme2Id = await createTestUser(`+9190000${ts}02`, 'msme')
  provider1Id = await createTestUser(`+9190000${ts}03`, 'provider')
  provider2Id = await createTestUser(`+9190000${ts}04`, 'provider')

  // MSME profiles
  const [mp1] = await db`
    INSERT INTO msme_profiles (user_id, business_name, state)
    VALUES (${msme1Id}, 'Test MSME 1', 'AP')
    RETURNING id
  `
  msme1ProfileId = mp1!['id']

  const [mp2] = await db`
    INSERT INTO msme_profiles (user_id, business_name, state)
    VALUES (${msme2Id}, 'Test MSME 2', 'MH')
    RETURNING id
  `
  msme2ProfileId = mp2!['id']

  // Provider profiles — one active, one pending_kyc
  const [pp1] = await db`
    INSERT INTO provider_profiles (user_id, legal_name, display_name, slug, state, status)
    VALUES (${provider1Id}, 'Active Provider Ltd', 'Active Provider', ${'active-prov-t' + ts}, 'KA', 'active')
    RETURNING id
  `
  provider1ProfileId = pp1!['id']

  const [pp2] = await db`
    INSERT INTO provider_profiles (user_id, legal_name, display_name, slug, state, status)
    VALUES (${provider2Id}, 'Pending Provider Ltd', 'Pending Provider', ${'pending-prov-t' + ts}, 'TN', 'pending_kyc')
    RETURNING id
  `
  provider2ProfileId = pp2!['id']

  // Get a category id
  const [cat] = await db`SELECT id FROM categories LIMIT 1`
  if (!cat) throw new Error('No categories found — run seed first')

  // Packages: one active (from active provider), one draft (from active provider), one from pending provider
  const [pkg1] = await db`
    INSERT INTO packages (provider_id, category_id, slug, title_i18n, scope_included, deliverables, price_paise, delivery_days, status)
    VALUES (${provider1ProfileId}, ${cat['id']}, ${'pkg-active-' + ts}, '{"en":"Active Package"}', '["scope"]', '["deliverable"]', 69900, 7, 'active')
    RETURNING id
  `
  package1Id = pkg1!['id']

  const [pkg2] = await db`
    INSERT INTO packages (provider_id, category_id, slug, title_i18n, scope_included, deliverables, price_paise, delivery_days, status)
    VALUES (${provider1ProfileId}, ${cat['id']}, ${'pkg-draft-' + ts}, '{"en":"Draft Package"}', '["scope"]', '["deliverable"]', 49900, 5, 'draft')
    RETURNING id
  `
  package2Id = pkg2!['id']

  // Order belonging to msme1 (not msme2)
  const [ord] = await db`
    INSERT INTO orders (order_number, msme_id, provider_id, source, title, scope_snapshot, price_paise, gst_paise, total_paise, commission_bps, commission_paise, provider_earning_paise, delivery_days, status)
    VALUES (${'AMC-TEST-' + ts}, ${msme1ProfileId}, ${provider1ProfileId}, 'package', 'Test Order', '{}', 69900, 12582, 82482, 1000, 6990, 62910, 7, 'placed')
    RETURNING id
  `
  order1Id = ord!['id']

  // RFQ and matches: rfq from msme1, matched to provider1 (not provider2)
  const [rfq] = await db`
    INSERT INTO rfqs (msme_id, category_id, title, details, expires_at)
    VALUES (${msme1ProfileId}, ${cat['id']}, 'Test RFQ', '{}', now() + interval '72 hours')
    RETURNING id
  `
  rfq1Id = rfq!['id']

  await db`
    INSERT INTO rfq_matches (rfq_id, provider_id)
    VALUES (${rfq1Id}, ${provider1ProfileId})
  `

  console.log('✓ Test data ready\n')
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`)
    failed++
  }
}

async function runTests() {
  // ── T1: MSME cannot read another MSME's order ──────────────────────────────
  console.log('T1: MSME cannot read another MSME\'s order')
  await db.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL role = 'authenticated'; SET LOCAL "request.jwt.claims" = '{"sub":"${msme2Id}","role":"authenticated"}';`)
    const rows = await tx.unsafe(`SELECT id FROM orders WHERE id = '${order1Id}'`)
    assert(rows.length === 0, 'msme2 gets 0 rows when querying msme1\'s order')
  })

  // ── T2: Unverified provider invisible to anonymous users ───────────────────
  console.log('T2: Unverified provider (status=pending_kyc) invisible to anon')
  await db.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL role = 'anon'; SET LOCAL "request.jwt.claims" = '{"role":"anon"}';`)
    const rows = await tx.unsafe(`SELECT id FROM provider_profiles WHERE id = '${provider2ProfileId}'`)
    assert(rows.length === 0, 'anon gets 0 rows for pending_kyc provider')
  })

  await db.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL role = 'anon'; SET LOCAL "request.jwt.claims" = '{"role":"anon"}';`)
    const rows = await tx.unsafe(`SELECT id FROM provider_profiles WHERE id = '${provider1ProfileId}'`)
    assert(rows.length === 1, 'anon can read active provider')
  })

  // ── T3: Anonymous can read active packages only ────────────────────────────
  console.log('T3: Anonymous user sees active packages only')
  await db.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL role = 'anon'; SET LOCAL "request.jwt.claims" = '{"role":"anon"}';`)
    const rows = await tx.unsafe(`SELECT id, status FROM packages WHERE id IN ('${package1Id}', '${package2Id}')`)
    assert(rows.length === 1, 'anon sees exactly 1 package (the active one)')
    assert(rows[0]?.['status'] === 'active', 'the visible package has status=active')
  })

  // ── T4: Provider reads only rfq_matches for their own provider_id ──────────
  console.log('T4: Provider reads only own rfq_matches')
  await db.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL role = 'authenticated'; SET LOCAL "request.jwt.claims" = '{"sub":"${provider2Id}","role":"authenticated"}';`)
    const rows = await tx.unsafe(`SELECT rfq_id FROM rfq_matches WHERE rfq_id = '${rfq1Id}'`)
    assert(rows.length === 0, 'provider2 cannot see rfq_match belonging to provider1')
  })

  await db.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL role = 'authenticated'; SET LOCAL "request.jwt.claims" = '{"sub":"${provider1Id}","role":"authenticated"}';`)
    const rows = await tx.unsafe(`SELECT rfq_id FROM rfq_matches WHERE rfq_id = '${rfq1Id}'`)
    assert(rows.length === 1, 'provider1 can see own rfq_match')
  })
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

async function teardown() {
  console.log('\n🧹 Cleaning up test data...')
  try {
    if (rfq1Id) await db`DELETE FROM rfq_matches WHERE rfq_id = ${rfq1Id}`
    if (rfq1Id) await db`DELETE FROM rfqs WHERE id = ${rfq1Id}`
    if (order1Id) await db`DELETE FROM orders WHERE id = ${order1Id}`
    const pkgIds = [package1Id, package2Id].filter(Boolean)
    if (pkgIds.length) for (const p of pkgIds) await db`DELETE FROM packages WHERE id = ${p}`
    const ppIds = [provider1ProfileId, provider2ProfileId].filter(Boolean)
    if (ppIds.length) for (const p of ppIds) await db`DELETE FROM provider_profiles WHERE id = ${p}`
    const mpIds = [msme1ProfileId, msme2ProfileId].filter(Boolean)
    if (mpIds.length) for (const p of mpIds) await db`DELETE FROM msme_profiles WHERE id = ${p}`
    const uIds = [msme1Id, msme2Id, provider1Id, provider2Id].filter(Boolean)
    if (uIds.length) for (const u of uIds) await db`DELETE FROM users WHERE id = ${u}`
    for (const uid of [msme1Id, msme2Id, provider1Id, provider2Id].filter(Boolean)) {
      await admin.auth.admin.deleteUser(uid)
    }
    console.log('✓ Cleaned up')
  } catch (e) {
    console.error('Teardown error (non-fatal):', e)
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  let fatalError: unknown
  try {
    await setup()
    await runTests()
  } catch (err) {
    fatalError = err
    console.error('\nSetup/test error:', err)
  } finally {
    await teardown()
    await db.end()
  }

  if (fatalError) process.exit(1)
  console.log(`\n${'─'.repeat(40)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
