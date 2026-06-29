/**
 * Remove verification-script artifacts from a database. Anchors STRICTLY on the
 * test markers the verify scripts use, so it can never touch real/seed data:
 *   • users with email @killtest.amclub  (verify-rfq / phase6 / phase7)
 *   • provider/msme profiles owned by those users
 *   • the dedicated test category ("P7 Test Cat" / slug p7-*-cat)
 *   • all rows hanging off those (packages, orders + children, rfqs + children,
 *     reviews, payouts/payments/refunds, conversations, notifications, audit).
 *
 * Seed/demo providers (kapoor-tax-services, sharma-associates, rajesh-co-ca, …)
 * are owned by NON-killtest users and are never selected.
 *
 * Dry run (default — lists, deletes nothing):  tsx scripts/cleanup-test-data.ts
 * Execute:                          APPLY=1   tsx scripts/cleanup-test-data.ts
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

const URL = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const APPLY = process.env['APPLY'] === '1'
const admin = createClient(URL, SERVICE, { auth: { persistSession: false } })

const ids = <T extends { id: string }>(rows: T[] | null) => (rows ?? []).map((r) => r.id)
const t = (p: PromiseLike<unknown>) => Promise.resolve(p).catch((e) => console.error('  ! delete error', e?.message ?? e))

async function main() {
  console.log(`\n🧪 Test-data cleanup → ${URL}   [${APPLY ? 'APPLY — deleting' : 'DRY RUN — nothing deleted'}]\n`)

  // ── 1. Identify the test cohort by its markers ──────────────────────────────
  const { data: testUsers } = await admin.from('users').select('id, email').like('email', '%@killtest.amclub')
  const userIds = ids(testUsers)

  const { data: provByUser } = userIds.length
    ? await admin.from('provider_profiles').select('id, slug, display_name, user_id').in('user_id', userIds)
    : { data: [] }
  const providerIds = ids(provByUser as any)

  const { data: msmeByUser } = userIds.length
    ? await admin.from('msme_profiles').select('id, business_name, user_id').in('user_id', userIds)
    : { data: [] }
  const msmeIds = ids(msmeByUser as any)

  // Test category: created only by verify-phase7. Match by name + slug shape.
  const { data: testCats } = await admin
    .from('categories')
    .select('id, slug, name_i18n')
    .or('slug.like.p7-%-cat,name_i18n->>en.eq.P7 Test Cat')
  const catIds = ids(testCats as any)

  // Dependent rows.
  const { data: pkgs } = providerIds.length ? await admin.from('packages').select('id, title_i18n, slug').in('provider_id', providerIds) : { data: [] }
  const pkgIds = ids(pkgs as any)
  const { data: orders } = (providerIds.length || msmeIds.length)
    ? await admin.from('orders').select('id, order_number').or([
        providerIds.length ? `provider_id.in.(${providerIds.join(',')})` : '',
        msmeIds.length ? `msme_id.in.(${msmeIds.join(',')})` : '',
      ].filter(Boolean).join(','))
    : { data: [] }
  const orderIds = ids(orders as any)
  const { data: rfqs } = msmeIds.length ? await admin.from('rfqs').select('id').in('msme_id', msmeIds) : { data: [] }
  const rfqIds = ids(rfqs as any)

  // ── Report ──────────────────────────────────────────────────────────────────
  console.log(`Users (@killtest.amclub):  ${userIds.length}`)
  console.log(`Providers:                 ${providerIds.length}` + ((provByUser as any[])?.length ? ` → ${(provByUser as any[]).map((p) => `${p.display_name} (${p.slug})`).join(', ')}` : ''))
  console.log(`MSME profiles:             ${msmeIds.length}` + ((msmeByUser as any[])?.length ? ` → ${(msmeByUser as any[]).map((m) => m.business_name).join(', ')}` : ''))
  console.log(`Test categories:           ${catIds.length}` + ((testCats as any[])?.length ? ` → ${(testCats as any[]).map((c) => `${c.name_i18n?.en} (${c.slug})`).join(', ')}` : ''))
  console.log(`Packages:                  ${pkgIds.length}` + ((pkgs as any[])?.length ? ` → ${(pkgs as any[]).map((p) => p.title_i18n?.en ?? p.slug).join(', ')}` : ''))
  console.log(`Orders:                    ${orderIds.length}`)
  console.log(`RFQs:                      ${rfqIds.length}`)

  if (!APPLY) {
    console.log('\n(DRY RUN) Re-run with APPLY=1 to delete the above. Nothing changed.\n')
    return
  }

  // ── 2. Delete, FK-safe (children → parents) ─────────────────────────────────
  console.log('\nDeleting…')
  for (const oid of orderIds) {
    const { data: pays } = await admin.from('payments').select('id').eq('order_id', oid)
    for (const p of pays ?? []) await t(admin.from('refunds').delete().eq('payment_id', p.id))
    await t(admin.from('coupon_redemptions').delete().eq('order_id', oid))
    await t(admin.from('reviews').delete().eq('order_id', oid))
    await t(admin.from('disputes').delete().eq('order_id', oid))
    await t(admin.from('payouts').delete().eq('order_id', oid))
    await t(admin.from('payments').delete().eq('order_id', oid))
    await t(admin.from('invoices').delete().eq('order_id', oid))
    await t(admin.from('order_documents').delete().eq('order_id', oid))
    await t(admin.from('order_events').delete().eq('order_id', oid))
  }
  for (const rid of rfqIds) {
    await t(admin.from('quotes').delete().eq('rfq_id', rid))
    await t(admin.from('rfq_matches').delete().eq('rfq_id', rid))
  }
  for (const mid of msmeIds) {
    await t(admin.from('reviews').delete().eq('msme_id', mid))
    await t(admin.from('conversations').delete().eq('msme_id', mid)) // cascades messages
    await t(admin.from('checkout_sessions').delete().eq('msme_id', mid))
  }
  for (const oid of orderIds) await t(admin.from('orders').delete().eq('id', oid))
  for (const rid of rfqIds) await t(admin.from('rfqs').delete().eq('id', rid))
  for (const pid of providerIds) {
    await t(admin.from('reviews').delete().eq('provider_id', pid))
    await t(admin.from('packages').delete().eq('provider_id', pid))
    await t(admin.from('provider_categories').delete().eq('provider_id', pid))
    await t(admin.from('provider_bank_accounts').delete().eq('provider_id', pid))
    await t(admin.from('provider_verifications').delete().eq('provider_id', pid))
    await t(admin.from('provider_profiles').delete().eq('id', pid))
  }
  for (const mid of msmeIds) await t(admin.from('msme_profiles').delete().eq('id', mid))
  for (const cid of catIds) {
    await t(admin.from('provider_categories').delete().eq('category_id', cid))
    await t(admin.from('categories').delete().eq('id', cid))
  }
  for (const uid of userIds) {
    await t(admin.from('audit_logs').delete().eq('actor_id', uid))
    await t(admin.from('notifications').delete().eq('user_id', uid))
    await t(admin.from('saved_providers').delete().eq('msme_id', uid)) // no-op if none
    await t(admin.from('users').delete().eq('id', uid))
    await admin.auth.admin.deleteUser(uid).catch(() => {})
  }

  // ── 3. Verify nothing remains ───────────────────────────────────────────────
  const { count: usersLeft } = await admin.from('users').select('id', { count: 'exact', head: true }).like('email', '%@killtest.amclub')
  const { data: catsLeft } = await admin.from('categories').select('id').or('slug.like.p7-%-cat,name_i18n->>en.eq.P7 Test Cat')
  const { data: provLeft } = await admin.from('provider_profiles').select('id').or('slug.like.p6\\_%,slug.like.p7\\_%,slug.like.rfqv\\_%')
  console.log(`\n✅ Done. Remaining test artifacts → users: ${usersLeft ?? 0}, test categories: ${(catsLeft ?? []).length}, test-slug providers: ${(provLeft ?? []).length}`)

  // Confirm seed/demo providers are untouched.
  const { data: seed } = await admin.from('provider_profiles').select('display_name').in('slug', ['kapoor-tax-services', 'sharma-associates', 'rajesh-co-ca'])
  console.log(`Seed demo providers still present: ${(seed ?? []).map((s: any) => s.display_name).join(', ') || 'NONE (!)'}`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
