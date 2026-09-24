/**
 * AMC Mart M2 — goods RFQ killtests at the DB layer (LOCAL Postgres only).
 * Proves the claims migration 0024 makes:
 *
 *  1. rfqs.kind is 'service' | 'goods' and defaults to 'service'; an existing
 *     services row is untouched (category_id set, no Mart columns).
 *  2. Shape check: a goods RFQ needs mart_category_slug + goods_spec and no
 *     category_id; a services RFQ needs category_id and no Mart columns.
 *  2b. goods_spec (the buyer's delivery contact) is not readable by anon /
 *     authenticated (0077, audit M4); every other rfqs column still is.
 *  3. mart_category_slug references mart_categories (FK).
 *  4. quotes goods terms are all-or-nothing and price_paise = unit × qty;
 *     product_id is SET NULL when the listing is deleted (the quote survives).
 *
 * The API lifecycle (fan-out to sellers only, server-computed quote price,
 * accept → goods order) is exercised by apps/web/scripts/verify-goods-rfq.ts.
 *
 * Usage: pnpm --filter @amclub/db exec tsx src/scripts/killtest-mart-goods-rfq.ts --url postgres://…/amclub_kt
 */
import postgres from 'postgres'
import { randomUUID } from 'crypto'

const args = process.argv.slice(2)
const urlFlag = args.indexOf('--url')
const target = urlFlag !== -1 ? args[urlFlag + 1] : process.env['DATABASE_URL']
if (!target) { console.error('Pass --url <postgres-url> (a LOCAL bootstrapped database).'); process.exit(1) }
if (/supabase\.co|pooler\.supabase|amclub-prod/i.test(target)) { console.error('Refusing to run against a hosted/prod database.'); process.exit(1) }

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, extra = '') => { console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' ' + extra : ''}`); if (cond) pass++; else fail++ }

async function main() {
  const sql = postgres(target!, { max: 1, onnotice: () => {} })
  const tag = `kt_grfq_${Date.now()}`
  const ids = { seller: randomUUID(), buyer: randomUUID(), sellerId: '', msme: '', product: '', svcRfq: '', goodsRfq: '', categoryId: '' }
  const spec = { item: `${tag} bolt`, qty: 500, unit: 'pcs', spec: [{ k: 'Grade', v: '8.8' }], delivery: { contact_name: 'KT', contact_phone: '9876543210', address: 'Plot 1', city: 'Kurnool', state: 'AP', pincode: '518001', pickup: false } }
  const rejects = async (name: string, fn: () => Promise<unknown>, pattern: RegExp) => {
    try { await fn(); ok(name, false, 'accepted') } catch (e) { ok(name, pattern.test(String(e)), String(e).split('\n')[0]!.slice(0, 100)) }
  }
  try {
    console.log(`\nMart goods-RFQ killtests → ${target!.replace(/\/\/.*@/, '//***@')}\n`)
    for (const [uid, label, roles] of [[ids.seller, 's', ['provider']], [ids.buyer, 'b', ['msme']]] as const) {
      await sql`INSERT INTO auth.users (id, email) VALUES (${uid}, ${`${tag}_${label}@killtest.amclub`})`
      await sql`INSERT INTO users (id, email, roles) VALUES (${uid}, ${`${tag}_${label}@killtest.amclub`}, ${sql.array([...roles])})`
    }
    ids.sellerId = (await sql`INSERT INTO provider_profiles (user_id, legal_name, display_name, slug, state, status, languages, sells_goods)
      VALUES (${ids.seller}, ${tag}, ${tag}, ${`${tag}-s`}, 'AP', 'active', ${sql.array(['en'])}, true) RETURNING id`)[0]!['id'] as string
    ids.msme = (await sql`INSERT INTO msme_profiles (user_id, business_name, state) VALUES (${ids.buyer}, 'KT B', 'AP') RETURNING id`)[0]!['id'] as string
    ids.product = (await sql`INSERT INTO products (seller_id, category_slug, name, hsn_code, gst_rate_bps, unit, status, list_price_paise)
      VALUES (${ids.sellerId}, 'fasteners', ${`${tag} bolt`}, '7318', 1800, 'pcs', 'active', 450) RETURNING id`)[0]!['id'] as string
    // A bootstrapped killtest DB may carry no services categories — make one and remove it after.
    const existing = await sql`SELECT id FROM categories WHERE is_active ORDER BY sort_order LIMIT 1`
    ids.categoryId = existing[0] ? (existing[0]['id'] as string) : ((await sql`INSERT INTO categories (slug, name_i18n) VALUES (${`${tag}-cat`}, ${sql.json({ en: tag })}) RETURNING id`)[0]!['id'] as string)

    console.log('1. Services RFQ default')
    ids.svcRfq = (await sql`INSERT INTO rfqs (msme_id, category_id, title, details, expires_at) VALUES (${ids.msme}, ${ids.categoryId}, ${`${tag} svc`}, '{}', now() + interval '3 days') RETURNING id`)[0]!['id'] as string
    const svc = (await sql`SELECT kind, mart_category_slug, goods_spec FROM rfqs WHERE id = ${ids.svcRfq}`)[0]!
    ok("kind defaults to 'service'; Mart columns NULL", svc['kind'] === 'service' && svc['mart_category_slug'] === null && svc['goods_spec'] === null)
    await rejects('unknown kind refused', () => sql`UPDATE rfqs SET kind = 'rental' WHERE id = ${ids.svcRfq}`, /rfqs_kind_check/)
    await rejects('services RFQ cannot carry a Mart category', () => sql`UPDATE rfqs SET mart_category_slug = 'fasteners' WHERE id = ${ids.svcRfq}`, /rfqs_kind_shape_check/)
    await rejects('services RFQ cannot drop category_id', () => sql`UPDATE rfqs SET category_id = NULL WHERE id = ${ids.svcRfq}`, /rfqs_kind_shape_check/)

    console.log('2. Goods RFQ shape')
    await rejects('goods RFQ without spec refused', () => sql`INSERT INTO rfqs (msme_id, kind, mart_category_slug, title, details, expires_at) VALUES (${ids.msme}, 'goods', 'fasteners', ${`${tag} g0`}, '{}', now() + interval '3 days')`, /rfqs_kind_shape_check/)
    await rejects('goods RFQ with a services category_id refused', () => sql`INSERT INTO rfqs (msme_id, kind, category_id, mart_category_slug, goods_spec, title, details, expires_at) VALUES (${ids.msme}, 'goods', ${ids.categoryId}, 'fasteners', ${sql.json(spec)}, ${`${tag} g1`}, '{}', now() + interval '3 days')`, /rfqs_kind_shape_check/)
    await rejects('goods RFQ with an unknown Mart category refused (FK)', () => sql`INSERT INTO rfqs (msme_id, kind, mart_category_slug, goods_spec, title, details, expires_at) VALUES (${ids.msme}, 'goods', 'no-such-category', ${sql.json(spec)}, ${`${tag} g2`}, '{}', now() + interval '3 days')`, /foreign key|mart_category/)
    ids.goodsRfq = (await sql`INSERT INTO rfqs (msme_id, kind, mart_category_slug, goods_spec, title, details, expires_at) VALUES (${ids.msme}, 'goods', 'fasteners', ${sql.json(spec)}, ${`${tag} g3`}, '{}', now() + interval '3 days') RETURNING id`)[0]!['id'] as string
    ok('well-formed goods RFQ inserts with category_id NULL', !!ids.goodsRfq)

    // Audit M4 (0077): the buyer's delivery contact inside goods_spec is not client-readable.
    console.log('2b. goods_spec is server-only (0077)')
    const asRole = (role: 'anon' | 'authenticated', q: string) => sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`)
      return tx.unsafe(q)
    })
    await rejects('authenticated cannot SELECT rfqs.goods_spec', () => asRole('authenticated', 'SELECT goods_spec FROM rfqs LIMIT 1'), /permission denied/)
    await rejects('authenticated cannot SELECT * FROM rfqs', () => asRole('authenticated', 'SELECT * FROM rfqs LIMIT 1'), /permission denied/)
    await rejects('anon cannot SELECT rfqs.goods_spec', () => asRole('anon', 'SELECT goods_spec FROM rfqs LIMIT 1'), /permission denied/)
    try {
      await asRole('authenticated', 'SELECT id, title, kind, mart_category_slug FROM rfqs LIMIT 1')
      ok('authenticated still reads the other rfqs columns (control)', true)
    } catch (e) { ok('authenticated still reads the other rfqs columns (control)', false, String(e).split('\n')[0]!) }

    console.log('3. Quote goods terms')
    const clearQuotes = () => sql`DELETE FROM quotes WHERE rfq_id = ${ids.goodsRfq}`
    await rejects('partial goods terms refused (unit price without qty/gst/hsn)', () => sql`INSERT INTO quotes (rfq_id, provider_id, price_paise, delivery_days, scope, unit_price_paise) VALUES (${ids.goodsRfq}, ${ids.sellerId}, 425000, 5, 'x', 850)`, /quotes_goods_terms_check/)
    await clearQuotes()
    await rejects('price_paise ≠ unit × qty refused', () => sql`INSERT INTO quotes (rfq_id, provider_id, price_paise, delivery_days, scope, unit_price_paise, qty, gst_rate_bps, hsn_code) VALUES (${ids.goodsRfq}, ${ids.sellerId}, 1, 5, 'x', 850, 500, 1800, '7318')`, /quotes_goods_terms_check/)
    await clearQuotes()
    await rejects('GST slab outside {0,5,12,18,28}% refused', () => sql`INSERT INTO quotes (rfq_id, provider_id, price_paise, delivery_days, scope, unit_price_paise, qty, gst_rate_bps, hsn_code) VALUES (${ids.goodsRfq}, ${ids.sellerId}, 425000, 5, 'x', 850, 500, 1500, '7318')`, /quotes_goods_terms_check|gst/)
    await clearQuotes()
    await rejects('HSN must be 4/6/8 digits', () => sql`INSERT INTO quotes (rfq_id, provider_id, price_paise, delivery_days, scope, unit_price_paise, qty, gst_rate_bps, hsn_code) VALUES (${ids.goodsRfq}, ${ids.sellerId}, 425000, 5, 'x', 850, 500, 1800, '73181')`, /quotes_goods_terms_check|hsn/)
    await clearQuotes()
    const quoteId = (await sql`INSERT INTO quotes (rfq_id, provider_id, price_paise, delivery_days, scope, unit_price_paise, qty, gst_rate_bps, hsn_code, product_id) VALUES (${ids.goodsRfq}, ${ids.sellerId}, 425000, 5, 'x', 850, 500, 1800, '7318', ${ids.product}) RETURNING id`)[0]!['id'] as string
    ok('complete goods terms with price = 500 × 850 insert', !!quoteId)
    await sql`DELETE FROM products WHERE id = ${ids.product}`
    const after = (await sql`SELECT product_id, price_paise FROM quotes WHERE id = ${quoteId}`)[0]!
    ok('deleting the listing SET NULLs product_id; the quote and its price survive', after['product_id'] === null && Number(after['price_paise']) === 425000)
    ids.product = ''
  } finally {
    await sql`DELETE FROM quotes WHERE rfq_id IN (SELECT id FROM rfqs WHERE title LIKE ${tag + '%'})`.catch(() => {})
    await sql`DELETE FROM rfqs WHERE title LIKE ${tag + '%'}`.catch(() => {})
    if (ids.product) await sql`DELETE FROM products WHERE id = ${ids.product}`.catch(() => {})
    await sql`DELETE FROM categories WHERE slug = ${`${tag}-cat`}`.catch(() => {})
    await sql`DELETE FROM msme_profiles WHERE user_id = ${ids.buyer}`.catch(() => {})
    await sql`DELETE FROM provider_profiles WHERE user_id = ${ids.seller}`.catch(() => {})
    await sql`DELETE FROM users WHERE id IN (${ids.seller}, ${ids.buyer})`.catch(() => {})
    await sql`DELETE FROM auth.users WHERE id IN (${ids.seller}, ${ids.buyer})`.catch(() => {})
    await sql.end()
  }
  console.log(`\n${pass} passed, ${fail} failed\n`)
  process.exit(fail ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
