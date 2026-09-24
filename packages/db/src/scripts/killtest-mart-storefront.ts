/**
 * AMC Mart storefront v2 (E16, staged migration 0069) — schema killtests
 * against a bootstrapped LOCAL Postgres, never prod:
 *
 *  1. mart_category_attributes: public read; client roles cannot write; only
 *     enum / bool may be facetable; options only on enums; keys are slugs.
 *  2. products.promises ⊆ the three known promises; sample price > 0.
 *  3. mart_promise_breaches: no client access at all; one row per
 *     (order, product, promise).
 *  4. mart_reorder_reminders: the owner reads their own, nobody else; client
 *     roles cannot write; the interval is 7..365 days.
 *
 * Usage: pnpm --filter @amclub/db exec tsx src/scripts/killtest-mart-storefront.ts --url postgres://…/amclub
 * Creates fixture rows and deletes them in `finally` (zero residue).
 */
import postgres from 'postgres'
import { randomUUID } from 'crypto'

const args = process.argv.slice(2)
const urlFlag = args.indexOf('--url')
const target = urlFlag !== -1 ? args[urlFlag + 1] : process.env['DATABASE_URL']
if (!target) {
  console.error('Pass --url <postgres-url> (a LOCAL bootstrapped database).')
  process.exit(1)
}
if (/supabase\.co|pooler\.supabase|amclub-prod/i.test(target)) {
  console.error('Refusing to run schema killtests against what looks like a hosted/prod database.')
  process.exit(1)
}

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${extra ? ' ' + extra : ''}`)
  if (cond) pass++
  else fail++
}

async function main() {
  const sql = postgres(target!, { max: 1, onnotice: () => {} })
  const tag = `kt_mstore_${Date.now()}`
  const cat = `${tag}-cat`.replace(/_/g, '-')
  const ids = { seller: randomUUID(), buyer: randomUUID(), other: randomUUID(), provider: '', product: '' }
  const rejects = async (q: () => Promise<unknown>) => { try { await q(); return false } catch { return true } }
  const as = <T>(uid: string | null, role: 'anon' | 'authenticated', fn: (tx: postgres.TransactionSql) => Promise<T>) =>
    sql.begin(async (tx) => {
      if (uid) await tx.unsafe(`SELECT set_config('request.jwt.claim.sub', '${uid}', true)`)
      await tx.unsafe(`SET LOCAL ROLE ${role}`)
      return fn(tx)
    }) as Promise<T>
  try {
    console.log(`\nMart storefront (0069) killtests → ${target!.replace(/\/\/.*@/, '//***@')}\n`)
    for (const [uid, label] of [[ids.seller, 'seller'], [ids.buyer, 'buyer'], [ids.other, 'other']] as const) {
      await sql`INSERT INTO auth.users (id, email) VALUES (${uid}, ${`${tag}_${label}@killtest.amclub`})`
      await sql`INSERT INTO users (id, email, roles) VALUES (${uid}, ${`${tag}_${label}@killtest.amclub`}, ${sql.array([label === 'seller' ? 'provider' : 'msme'])})`
    }
    ids.provider = (await sql`INSERT INTO provider_profiles (user_id, legal_name, display_name, slug, state, status, languages, sells_goods)
      VALUES (${ids.seller}, 'KT', 'KT', ${`${tag}-seller`.replace(/_/g, '-')}, 'AP', 'active', ${sql.array(['en'])}, true) RETURNING id`)[0]!['id'] as string
    await sql`INSERT INTO mart_categories (slug, name_i18n, return_window_hours, commission_bps, bis_blocked, is_active, sort_order)
      VALUES (${cat}, ${sql.json({ en: cat })}, 48, 500, false, true, 999)`
    ids.product = (await sql`INSERT INTO products (seller_id, category_slug, name, hsn_code, gst_rate_bps, unit, status)
      VALUES (${ids.provider}, ${cat}, ${`${tag} bolt`}, '7318', 1800, 'pcs', 'active') RETURNING id`)[0]!['id'] as string

    console.log('1. mart_category_attributes:')
    await sql`INSERT INTO mart_category_attributes (category_slug, key, label_i18n, type, options, facetable, required) VALUES (${cat}, 'material', ${sql.json({ en: 'Material' })}, 'enum', ${sql.json(['MS'])}, true, true)`
    ok('number attribute cannot be facetable', await rejects(() => sql`INSERT INTO mart_category_attributes (category_slug, key, label_i18n, type, facetable) VALUES (${cat}, 'dia', ${sql.json({ en: 'D' })}, 'number', true)`))
    ok('options only on enums', await rejects(() => sql`INSERT INTO mart_category_attributes (category_slug, key, label_i18n, type, options) VALUES (${cat}, 'note', ${sql.json({ en: 'N' })}, 'text', ${sql.json(['x'])})`))
    ok('key must be a slug', await rejects(() => sql`INSERT INTO mart_category_attributes (category_slug, key, label_i18n, type) VALUES (${cat}, 'Bad Key', ${sql.json({ en: 'B' })}, 'text')`))
    ok('anon reads the definitions', (await as(null, 'anon', (tx) => tx`SELECT count(*)::int AS n FROM mart_category_attributes WHERE category_slug = ${cat}`))[0]!['n'] === 1)
    ok('authenticated cannot insert definitions', await rejects(() => as(ids.seller, 'authenticated', (tx) => tx`INSERT INTO mart_category_attributes (category_slug, key, label_i18n, type) VALUES (${cat}, 'x', ${sql.json({ en: 'X' })}, 'text')`)))
    const upd = await as(ids.seller, 'authenticated', (tx) => tx`UPDATE mart_category_attributes SET required = false WHERE category_slug = ${cat}`).then((r) => r.count).catch(() => -1)
    ok('authenticated cannot update definitions', upd <= 0)

    console.log('2. products.promises / sample_price_paise:')
    ok('unknown promise refused', await rejects(() => sql`UPDATE products SET promises = ARRAY['free_lunch'] WHERE id = ${ids.product}`))
    await sql`UPDATE products SET promises = ARRAY['ships_48h', 'gst_invoice_24h'] WHERE id = ${ids.product}`
    ok('known promises accepted', true)
    ok('zero sample price refused', await rejects(() => sql`UPDATE products SET sample_price_paise = 0 WHERE id = ${ids.product}`))
    ok('attributes default {}', (await sql`SELECT attributes FROM products WHERE id = ${ids.product}`)[0]!['attributes'] !== null)

    console.log('3. mart_promise_breaches:')
    const breachAnon = await as(null, 'anon', (tx) => tx`SELECT count(*) FROM mart_promise_breaches`).then(() => 'read').catch(() => 'denied')
    ok('anon has no access', breachAnon === 'denied')
    const breachAuth = await as(ids.seller, 'authenticated', (tx) => tx`SELECT count(*) FROM mart_promise_breaches`).then(() => 'read').catch(() => 'denied')
    ok('authenticated has no access', breachAuth === 'denied')

    console.log('4. mart_reorder_reminders:')
    await sql`INSERT INTO mart_reorder_reminders (user_id, product_id, interval_days, next_at) VALUES (${ids.buyer}, ${ids.product}, 30, now() + interval '30 days')`
    ok('interval below 7 days refused', await rejects(() => sql`INSERT INTO mart_reorder_reminders (user_id, product_id, interval_days, next_at) VALUES (${ids.other}, ${ids.product}, 3, now())`))
    ok('the owner reads their reminder', (await as(ids.buyer, 'authenticated', (tx) => tx`SELECT count(*)::int AS n FROM mart_reorder_reminders WHERE product_id = ${ids.product}`))[0]!['n'] === 1)
    ok('another user reads nothing', (await as(ids.other, 'authenticated', (tx) => tx`SELECT count(*)::int AS n FROM mart_reorder_reminders WHERE product_id = ${ids.product}`))[0]!['n'] === 0)
    ok('the owner cannot write directly', await rejects(() => as(ids.buyer, 'authenticated', (tx) => tx`INSERT INTO mart_reorder_reminders (user_id, product_id, interval_days, next_at) VALUES (${ids.buyer}, ${ids.product}, 60, now())`)))

    console.log(`\n${fail === 0 ? '✅' : '❌'} killtest-mart-storefront: ${pass} passed, ${fail} failed\n`)
  } catch (e) {
    fail++
    console.error('\n✗ suite aborted:', e instanceof Error ? e.message : e)
  } finally {
    await sql`DELETE FROM mart_reorder_reminders WHERE user_id IN (${ids.buyer}, ${ids.other})`
    if (ids.product) await sql`DELETE FROM products WHERE id = ${ids.product}`
    await sql`DELETE FROM mart_categories WHERE slug = ${cat}`
    if (ids.provider) await sql`DELETE FROM provider_profiles WHERE id = ${ids.provider}`
    for (const uid of [ids.seller, ids.buyer, ids.other]) {
      await sql`DELETE FROM users WHERE id = ${uid}`
      await sql`DELETE FROM auth.users WHERE id = ${uid}`
    }
    await sql.end()
    process.exit(fail === 0 ? 0 : 1)
  }
}
main()
