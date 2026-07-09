/**
 * Phase 8 §2 — load-test cleanup. Removes EVERYTHING the k6 runs created:
 * orders (+payments/refunds/payouts/events/milestones/documents/invoices),
 * checkout sessions, RFQs (+matches/quotes), notifications, ai_invocations,
 * then the msme/provider profiles, package and users from loadtest/.ctx.json.
 *
 * Idempotent — safe to re-run. Run: tsx scripts/loadtest-cleanup.ts
 */
import { config } from 'dotenv'
import path from 'path'
import fs from 'fs'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })
const CTX_PATH = path.resolve(__dirname, '../../../loadtest/.ctx.json')

async function main() {
  if (!fs.existsSync(CTX_PATH)) {
    console.log('no loadtest/.ctx.json — nothing to clean')
    return
  }
  const ctx = JSON.parse(fs.readFileSync(CTX_PATH, 'utf8')) as {
    tag: string
    buyers: { uid: string; msmeId: string }[]
    providerUid: string
    providerId: string
    packageId: string
  }
  const msmeIds = ctx.buyers.map((b) => b.msmeId)
  const userIds = [...ctx.buyers.map((b) => b.uid), ctx.providerUid]
  console.log(`cleanup ${ctx.tag}: ${msmeIds.length} buyers, provider ${ctx.providerId}`)

  // Orders and their satellites.
  const { data: orders, error: ordersErr } = await admin.from('orders').select('id').in('msme_id', msmeIds)
  if (ordersErr) throw new Error(`orders query: ${ordersErr.message}`)
  const orderIds = (orders ?? []).map((o) => o.id)
  console.log(`  orders: ${orderIds.length}`)
  for (let i = 0; i < orderIds.length; i += 50) {
    const chunk = orderIds.slice(i, i + 50)
    const { data: pays } = await admin.from('payments').select('id').in('order_id', chunk)
    if (pays?.length) await admin.from('refunds').delete().in('payment_id', pays.map((p) => p.id))
    await admin.from('payments').delete().in('order_id', chunk)
    await admin.from('payouts').delete().in('order_id', chunk)
    await admin.from('order_events').delete().in('order_id', chunk)
    await admin.from('order_milestones').delete().in('order_id', chunk)
    await admin.from('order_documents').delete().in('order_id', chunk)
    await admin.from('invoices').delete().in('order_id', chunk)
    await admin.from('orders').delete().in('id', chunk)
  }
  await admin.from('checkout_sessions').delete().eq('package_id', ctx.packageId)

  // RFQs and their satellites.
  const { data: rfqs } = await admin.from('rfqs').select('id').in('msme_id', msmeIds)
  const rfqIds = (rfqs ?? []).map((r) => r.id)
  console.log(`  rfqs: ${rfqIds.length}`)
  for (let i = 0; i < rfqIds.length; i += 50) {
    const chunk = rfqIds.slice(i, i + 50)
    await admin.from('quotes').delete().in('rfq_id', chunk)
    await admin.from('rfq_matches').delete().in('rfq_id', chunk)
    await admin.from('rfqs').delete().in('id', chunk)
  }

  // Per-user residue, profiles, users.
  await admin.from('notifications').delete().in('user_id', userIds)
  await admin.from('ai_invocations').delete().in('user_id', userIds)
  // Deletes below must not fail silently — a swallowed FK violation here is
  // exactly how test residue survives (it happened once; see docs/LOAD_TEST.md).
  const mustDelete = async (label: string, q: PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await q
    if (error) throw new Error(`${label}: ${error.message}`)
  }
  await mustDelete('bank', admin.from('provider_bank_accounts').delete().eq('provider_id', ctx.providerId))
  await mustDelete('prov-cats', admin.from('provider_categories').delete().eq('provider_id', ctx.providerId))
  await mustDelete('package', admin.from('packages').delete().eq('id', ctx.packageId))
  await mustDelete('provider', admin.from('provider_profiles').delete().eq('id', ctx.providerId))
  await mustDelete('msmes', admin.from('msme_profiles').delete().in('id', msmeIds))
  await mustDelete('users', admin.from('users').delete().in('id', userIds))
  for (const uid of userIds) await admin.auth.admin.deleteUser(uid).catch(() => {})

  fs.unlinkSync(CTX_PATH)
  console.log('cleaned up; .ctx.json removed')
}

main().catch((e) => { console.error(e); process.exit(1) })
