/**
 * AMC Mart — DEMO data (founder's short public demo, 2026-09-19).
 *
 * Seeds three FICTIONAL goods sellers, two fictional pilot buyers, 14 active
 * listings with price tiers + typographic card images, and two open group-buy
 * pools with committed members — enough for /mart, /mart/c/*, /mart/p/* and
 * /mart/pools to render. Everything is anchored so it can be removed cleanly:
 *   auth users   <role>-demo-N@demo.amclub.in
 *   provider/msme slugs & names as in the catalog file
 *   storage keys public-assets/mart/demo/*
 *
 * Writes go through the service role (server-side seed, same as seed.ts);
 * the activation gate is honoured honestly with an `admin_attest` GSTIN row
 * per seller (never a stub). Product approvals are attributed to ADMIN_EMAIL.
 *
 *   DEMO_CATALOG=<catalog.json> DEMO_IMAGES=<dir> APPLY=1  tsx scripts/mart-demo-data.ts
 *   REMOVE=1                                               tsx scripts/mart-demo-data.ts
 * Dry run (neither flag) prints the plan. Idempotent: re-APPLY updates in place.
 */
import { config } from 'dotenv'
import { resolve, join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
config({ path: resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
const ADMIN_EMAIL = process.env['ADMIN_EMAIL'] ?? 'rsandesh99@gmail.com'
const APPLY = process.env['APPLY'] === '1'
const REMOVE = process.env['REMOVE'] === '1'
const DOMAIN = 'demo.amclub.in'
const KEY_PREFIX = 'mart/demo/'
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })

type Tier = [number, number]
interface Catalog {
  sellers: { n: number; display_name: string; legal_name: string; city: string; state: string; gstin: string }[]
  buyers: { n: number; business_name: string; city: string; state: string }[]
  products: { key: string; seller: number; category_slug: string; name: string; brand: string; hsn_code: string; gst_rate_bps: number; unit: string; min_order_qty: number; description: string; specs: { k: string; v: string }[]; tiers: Tier[] }[]
  pools: { key: string; product_key: string; seller: number; category_slug: string; title: string; unit: string; target_qty: number; min_qty: number; unit_price_paise: number; closes_in_days: number; members: [number, number][] }[]
}

const sellerEmail = (n: number) => `seller-demo-${n}@${DOMAIN}`
const buyerEmail = (n: number) => `buyer-demo-${n}@${DOMAIN}`
const slugOf = (s: string) => 'demo-' + s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

async function findAuthUser(email: string): Promise<string | null> {
  // No filter API on listUsers; page through (demo project is small).
  for (let page = 1; page <= 20; page++) {
    const { data } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    const hit = data.users.find((u) => u.email?.toLowerCase() === email)
    if (hit) return hit.id
    if (data.users.length < 200) break
  }
  return null
}

async function ensureUser(email: string, roles: string[], fullName: string): Promise<string> {
  let id = await findAuthUser(email)
  if (!id) {
    const { data, error } = await admin.auth.admin.createUser({ email, password: randomBytes(18).toString('base64url'), email_confirm: true })
    if (error) throw new Error(`createUser ${email}: ${error.message}`)
    id = data.user.id
  }
  const { error } = await admin.from('users').upsert({ id, email, roles, full_name: fullName }, { onConflict: 'id' })
  if (error) throw new Error(`users upsert ${email}: ${error.message}`)
  return id
}

async function apply(cat: Catalog, imagesDir: string) {
  const { data: adminUser } = await admin.from('users').select('id').eq('email', ADMIN_EMAIL).maybeSingle()
  if (!adminUser) throw new Error(`admin user ${ADMIN_EMAIL} not found`)
  const adminId = adminUser.id as string
  const now = new Date().toISOString()

  // ── images ──────────────────────────────────────────────────────────────
  const keys = [...cat.products.map((p) => p.key), ...cat.pools.map((p) => p.key)]
  for (const k of keys) {
    const file = join(imagesDir, `${k}.png`)
    if (!existsSync(file)) throw new Error(`missing image ${file}`)
    const { error } = await admin.storage.from('public-assets').upload(`${KEY_PREFIX}${k}.png`, readFileSync(file), { contentType: 'image/png', upsert: true })
    if (error) throw new Error(`upload ${k}: ${error.message}`)
  }
  console.log(`✓ ${keys.length} images in public-assets/${KEY_PREFIX}`)

  // ── sellers ─────────────────────────────────────────────────────────────
  const sellerIds = new Map<number, string>()
  for (const s of cat.sellers) {
    const uid = await ensureUser(sellerEmail(s.n), ['provider'], s.display_name)
    const slug = slugOf(s.display_name)
    const row = {
      user_id: uid, legal_name: s.legal_name, display_name: s.display_name, slug, state: s.state, city: s.city,
      status: 'active', languages: ['en', 'te'], gstin: s.gstin, sells_goods: true,
      about: `Industrial supplies distributor, ${s.city}. Ships across Andhra Pradesh.`,
    }
    const { data: existing } = await admin.from('provider_profiles').select('id').eq('user_id', uid).maybeSingle()
    let pid: string
    if (existing) {
      const { error } = await admin.from('provider_profiles').update(row).eq('id', existing.id)
      if (error) throw new Error(`provider update ${slug}: ${error.message}`)
      pid = existing.id
    } else {
      const { data, error } = await admin.from('provider_profiles').insert(row).select('id').single()
      if (error) throw new Error(`provider insert ${slug}: ${error.message}`)
      pid = data.id
    }
    sellerIds.set(s.n, pid)
    // Honest activation record: founder attestation, never a stub.
    const { data: att } = await admin.from('gstin_verifications').select('id').eq('user_id', uid).eq('provider', 'admin_attest').limit(1)
    if (!att?.length) {
      await admin.from('gstin_verifications').insert({ user_id: uid, gstin: s.gstin, verified: true, stub: false, provider: 'admin_attest', result: { reason: 'demo seller (founder demo 2026-09-19)' } })
    }
  }
  console.log(`✓ ${cat.sellers.length} sellers (sells_goods=true, attested)`)

  // ── buyers (pool members) ───────────────────────────────────────────────
  const buyers = new Map<number, { uid: string; msmeId: string; city: string; state: string; name: string }>()
  for (const b of cat.buyers) {
    const uid = await ensureUser(buyerEmail(b.n), ['msme'], b.business_name)
    const { data: existing } = await admin.from('msme_profiles').select('id').eq('user_id', uid).maybeSingle()
    let mid: string
    if (existing) mid = existing.id
    else {
      const { data, error } = await admin.from('msme_profiles').insert({ user_id: uid, business_name: b.business_name, state: b.state, city: b.city }).select('id').single()
      if (error) throw new Error(`msme insert ${b.business_name}: ${error.message}`)
      mid = data.id
    }
    buyers.set(b.n, { uid, msmeId: mid, city: b.city, state: b.state, name: b.business_name })
  }
  console.log(`✓ ${cat.buyers.length} pilot buyers`)

  // ── products + tiers ────────────────────────────────────────────────────
  const productIds = new Map<string, string>()
  for (const p of cat.products) {
    const sellerId = sellerIds.get(p.seller)!
    const row = {
      seller_id: sellerId, category_slug: p.category_slug, name: p.name, description: p.description, brand: p.brand,
      specs: p.specs, availability: 'in_stock', hsn_code: p.hsn_code, gst_rate_bps: p.gst_rate_bps, unit: p.unit,
      images: [`${KEY_PREFIX}${p.key}.png`], min_order_qty: p.min_order_qty, country_of_origin: 'IN',
      list_price_paise: p.tiers[0]![1], status: 'active', approved_by: adminId, approved_at: now,
    }
    const { data: existing } = await admin.from('products').select('id').eq('seller_id', sellerId).eq('name', p.name).is('deleted_at', null).maybeSingle()
    let pid: string
    if (existing) {
      const { error } = await admin.from('products').update(row).eq('id', existing.id)
      if (error) throw new Error(`product update ${p.key}: ${error.message}`)
      pid = existing.id
      await admin.from('price_tiers').delete().eq('product_id', pid)
    } else {
      const { data, error } = await admin.from('products').insert(row).select('id').single()
      if (error) throw new Error(`product insert ${p.key}: ${error.message}`)
      pid = data.id
    }
    const { error: tErr } = await admin.from('price_tiers').insert(p.tiers.map(([min_qty, unit_price_paise]) => ({ product_id: pid, min_qty, unit_price_paise })))
    if (tErr) throw new Error(`tiers ${p.key}: ${tErr.message}`)
    productIds.set(p.key, pid)
  }
  console.log(`✓ ${cat.products.length} active listings with tiers`)

  // ── pools + members ─────────────────────────────────────────────────────
  for (const pl of cat.pools) {
    const closes = new Date(Date.now() + pl.closes_in_days * 86_400_000).toISOString()
    const row = {
      product_id: productIds.get(pl.product_key)!, category_slug: pl.category_slug, spec: {}, title: pl.title, unit: pl.unit,
      target_qty: pl.target_qty, min_qty: pl.min_qty, unit_price_paise: pl.unit_price_paise, closes_at: closes, status: 'open',
      seller_id: sellerIds.get(pl.seller)!, created_by: adminId, approved_by: adminId, approved_at: now,
      rationale: { source: 'founder demo 2026-09-19' }, card_i18n: null,
    }
    const { data: existing } = await admin.from('pools').select('id').eq('title', pl.title).is('deleted_at', null).maybeSingle()
    let poolId: string
    if (existing) {
      const { error } = await admin.from('pools').update(row).eq('id', existing.id)
      if (error) throw new Error(`pool update ${pl.key}: ${error.message}`)
      poolId = existing.id
      await admin.from('pool_members').delete().eq('pool_id', poolId)
    } else {
      const { data, error } = await admin.from('pools').insert(row).select('id').single()
      if (error) throw new Error(`pool insert ${pl.key}: ${error.message}`)
      poolId = data.id
    }
    for (const [bn, qty] of pl.members) {
      const b = buyers.get(bn)!
      const { error } = await admin.from('pool_members').insert({
        pool_id: poolId, msme_id: b.msmeId, user_id: b.uid, qty, payment_state: 'blocked',
        delivery_snapshot: { contact_name: b.name, contact_phone: '', address: 'Industrial Estate', city: b.city, state: b.state, pincode: '518001', pickup: false },
      })
      if (error) throw new Error(`pool member ${pl.key}/${bn}: ${error.message}`)
    }
  }
  console.log(`✓ ${cat.pools.length} open pools with members`)
  console.log('\nOpen: https://amclub.in/mart  ·  https://amclub.in/mart/pools')
}

async function remove() {
  const { data: users } = await admin.from('users').select('id, email').like('email', `%@${DOMAIN}`)
  const uids = (users ?? []).map((u) => u.id as string)
  const { data: provs } = await admin.from('provider_profiles').select('id').in('user_id', uids.length ? uids : ['00000000-0000-0000-0000-000000000000'])
  const pids = (provs ?? []).map((p) => p.id as string)
  if (pids.length) {
    await admin.from('pools').delete().in('seller_id', pids) // cascades pool_members / pool_events
    await admin.from('products').delete().in('seller_id', pids) // cascades price_tiers / product_events
    await admin.from('provider_profiles').delete().in('id', pids)
  }
  if (uids.length) {
    await admin.from('gstin_verifications').delete().in('user_id', uids)
    await admin.from('msme_profiles').delete().in('user_id', uids)
    await admin.from('users').delete().in('id', uids)
    for (const id of uids) await admin.auth.admin.deleteUser(id)
  }
  const { data: files } = await admin.storage.from('public-assets').list(KEY_PREFIX.replace(/\/$/, ''), { limit: 200 })
  const paths = (files ?? []).map((f) => `${KEY_PREFIX}${f.name}`)
  if (paths.length) await admin.storage.from('public-assets').remove(paths)
  console.log(`✓ removed ${uids.length} demo users, ${pids.length} sellers (+ their listings/pools), ${paths.length} images`)
}

async function main() {
  if (REMOVE) return remove()
  const catPath = process.env['DEMO_CATALOG']
  const imagesDir = process.env['DEMO_IMAGES']
  if (!catPath || !imagesDir) throw new Error('DEMO_CATALOG and DEMO_IMAGES are required')
  const cat = JSON.parse(readFileSync(catPath, 'utf8')) as Catalog
  console.log(`Plan: ${cat.sellers.length} sellers, ${cat.buyers.length} buyers, ${cat.products.length} listings, ${cat.pools.length} pools → ${URL_}`)
  if (!APPLY) return console.log('(dry run — set APPLY=1)')
  await apply(cat, imagesDir)
}
main().catch((e) => { console.error('✗', e.message ?? e); process.exit(1) })
