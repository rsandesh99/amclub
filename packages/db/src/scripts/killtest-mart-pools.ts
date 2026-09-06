/**
 * AMC Mart M1 — pool killtests at the DB layer (LOCAL Postgres only). Proves
 * the claims migration 0023 makes:
 *
 *  1. pool_events is append-only (trigger raises; client roles cannot UPDATE/DELETE).
 *  2. RLS: cross-tenant pool_members reads = 0 rows (buyer B cannot see buyer A's
 *     commitment); the public sees open pools but never drafts; a seller sees
 *     allocations only once the pool closed met; clients cannot write pools.
 *  3. buyer_pool_discipline_v1 counts due / honoured / defaulted correctly.
 *  4. Constraints: one commitment per (pool, buyer); min_qty ≤ target_qty.
 *
 * The lifecycle (met / unmet / expiry / exit / capture-fail / replay) is
 * exercised by apps/web/scripts/verify-mart.ts against the running API; the
 * pure machine by @amclub/shared tests.
 *
 * Usage: pnpm --filter @amclub/db exec tsx src/scripts/killtest-mart-pools.ts --url postgres://…/amclub_kt
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
  const tag = `kt_pool_${Date.now()}`
  const ids = { seller: randomUUID(), buyerA: randomUUID(), buyerB: randomUUID(), admin: randomUUID(), sellerId: '', msmeA: '', msmeB: '', product: '', poolOpen: '', poolDraft: '', poolMet: '' }
  try {
    console.log(`\nMart pool killtests → ${target!.replace(/\/\/.*@/, '//***@')}\n`)
    for (const [uid, label, roles] of [[ids.seller, 's', ['provider']], [ids.buyerA, 'a', ['msme']], [ids.buyerB, 'b', ['msme']], [ids.admin, 'adm', ['admin']]] as const) {
      await sql`INSERT INTO auth.users (id, email) VALUES (${uid}, ${`${tag}_${label}@killtest.amclub`})`
      await sql`INSERT INTO users (id, email, roles) VALUES (${uid}, ${`${tag}_${label}@killtest.amclub`}, ${sql.array([...roles])})`
    }
    ids.sellerId = (await sql`INSERT INTO provider_profiles (user_id, legal_name, display_name, slug, state, status, languages, sells_goods)
      VALUES (${ids.seller}, ${tag}, ${tag}, ${`${tag}-s`}, 'AP', 'active', ${sql.array(['en'])}, true) RETURNING id`)[0]!['id'] as string
    ids.msmeA = (await sql`INSERT INTO msme_profiles (user_id, business_name, state) VALUES (${ids.buyerA}, 'KT A', 'AP') RETURNING id`)[0]!['id'] as string
    ids.msmeB = (await sql`INSERT INTO msme_profiles (user_id, business_name, state) VALUES (${ids.buyerB}, 'KT B', 'AP') RETURNING id`)[0]!['id'] as string
    ids.product = (await sql`INSERT INTO products (seller_id, category_slug, name, hsn_code, gst_rate_bps, unit, status, list_price_paise)
      VALUES (${ids.sellerId}, 'fasteners', ${`${tag} bolt`}, '7318', 1800, 'pcs', 'active', 450) RETURNING id`)[0]!['id'] as string
    const mkPool = async (status: string) =>
      (await sql`INSERT INTO pools (product_id, category_slug, title, unit, target_qty, min_qty, unit_price_paise, closes_at, status, seller_id, created_by)
        VALUES (${ids.product}, 'fasteners', ${`${tag} ${status}`}, 'pcs', 500, 200, 400, now() + interval '5 days', ${status}, ${ids.sellerId}, ${ids.admin}) RETURNING id`)[0]!['id'] as string
    ids.poolOpen = await mkPool('open')
    ids.poolDraft = await mkPool('draft')
    ids.poolMet = await mkPool('closed_met')
    const deliv = { contact_name: 'Ravi', contact_phone: '9876543210', address: 'Plot 4', city: 'Kurnool', state: 'AP', pincode: '518001', pickup: false }
    await sql`INSERT INTO pool_members (pool_id, msme_id, user_id, qty, delivery_snapshot) VALUES (${ids.poolOpen}, ${ids.msmeA}, ${ids.buyerA}, 100, ${sql.json(deliv)})`
    await sql`INSERT INTO pool_members (pool_id, msme_id, user_id, qty, delivery_snapshot, payment_state) VALUES (${ids.poolMet}, ${ids.msmeA}, ${ids.buyerA}, 120, ${sql.json(deliv)}, 'captured')`
    await sql`INSERT INTO pool_members (pool_id, msme_id, user_id, qty, delivery_snapshot, payment_state) VALUES (${ids.poolMet}, ${ids.msmeB}, ${ids.buyerB}, 80, ${sql.json(deliv)}, 'failed')`
    await sql`INSERT INTO pool_events (pool_id, actor_id, event_type, payload) VALUES (${ids.poolOpen}, ${ids.admin}, 'opened', '{}')`

    console.log('1. Append-only pool_events:')
    let raised = false
    try { await sql`UPDATE pool_events SET payload = '{"x":1}' WHERE pool_id = ${ids.poolOpen}` } catch (e) { raised = /append-only/.test(String(e)) }
    ok('UPDATE pool_events raises (trigger)', raised)
    const grants = await sql`SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee IN ('anon','authenticated') AND table_name = 'pool_events' AND privilege_type IN ('UPDATE','DELETE','INSERT')`
    ok('INSERT/UPDATE/DELETE revoked from client roles on pool_events', grants.length === 0, `(${grants.length})`)

    console.log('2. Constraints:')
    let dup = false
    try { await sql`INSERT INTO pool_members (pool_id, msme_id, user_id, qty, delivery_snapshot) VALUES (${ids.poolOpen}, ${ids.msmeA}, ${ids.buyerA}, 5, ${sql.json(deliv)})` } catch (e) { dup = /pool_members_pool_msme_uniq/.test(String(e)) }
    ok('one commitment per (pool, buyer)', dup)
    let badQty = false
    try { await sql`INSERT INTO pools (category_slug, title, unit, target_qty, min_qty, unit_price_paise, closes_at) VALUES ('fasteners', 'x', 'pcs', 10, 20, 1, now())` } catch (e) { badQty = /pools_qty_check/.test(String(e)) }
    ok('min_qty ≤ target_qty enforced', badQty)

    console.log('3. RLS:')
    const countAs = async (uid: string | null, role: 'anon' | 'authenticated', query: string): Promise<number> =>
      sql.begin(async (tx) => {
        if (uid) await tx.unsafe(`SELECT set_config('request.jwt.claim.sub', '${uid}', true)`)
        await tx.unsafe(`SET LOCAL ROLE ${role}`)
        const r = await tx.unsafe(query)
        return Number((r[0] as unknown as { n: number } | undefined)?.n ?? 0)
      })
    const pools = (w: string) => `SELECT count(*)::int AS n FROM pools WHERE title LIKE '${tag}%' ${w}`
    ok('anon sees the open + closed_met pools, not the draft', (await countAs(null, 'anon', pools(''))) === 2)
    ok('anon cannot see the draft', (await countAs(null, 'anon', pools(`AND id = '${ids.poolDraft}'`))) === 0)
    ok('admin sees the draft', (await countAs(ids.admin, 'authenticated', pools(`AND id = '${ids.poolDraft}'`))) === 1)
    ok('buyer A sees own commitment', (await countAs(ids.buyerA, 'authenticated', `SELECT count(*)::int AS n FROM pool_members WHERE pool_id = '${ids.poolOpen}'`)) === 1)
    ok("buyer B cannot see buyer A's commitment (cross-tenant = 0 rows)", (await countAs(ids.buyerB, 'authenticated', `SELECT count(*)::int AS n FROM pool_members WHERE pool_id = '${ids.poolOpen}'`)) === 0)
    ok('anon sees no pool_members rows at all', (await countAs(null, 'anon', `SELECT count(*)::int AS n FROM pool_members WHERE pool_id IN ('${ids.poolOpen}','${ids.poolMet}')`)) === 0)
    ok('seller cannot see allocations while the pool is OPEN', (await countAs(ids.seller, 'authenticated', `SELECT count(*)::int AS n FROM pool_members WHERE pool_id = '${ids.poolOpen}'`)) === 0)
    ok('seller sees allocations once closed_met', (await countAs(ids.seller, 'authenticated', `SELECT count(*)::int AS n FROM pool_members WHERE pool_id = '${ids.poolMet}'`)) === 2)
    let clientWrite = true
    try { await sql.begin(async (tx) => { await tx.unsafe(`SELECT set_config('request.jwt.claim.sub', '${ids.buyerA}', true)`); await tx.unsafe('SET LOCAL ROLE authenticated'); await tx.unsafe(`UPDATE pool_members SET payment_state = 'captured' WHERE pool_id = '${ids.poolOpen}'`) }) } catch { clientWrite = false }
    ok('a buyer cannot flip their own payment_state (writes are service-role only)', !clientWrite)
    let clientPoolInsert = true
    try { await sql.begin(async (tx) => { await tx.unsafe(`SELECT set_config('request.jwt.claim.sub', '${ids.buyerA}', true)`); await tx.unsafe('SET LOCAL ROLE authenticated'); await tx.unsafe(`INSERT INTO pools (category_slug, title, unit, target_qty, min_qty, unit_price_paise, closes_at, status) VALUES ('fasteners','x','pcs',10,5,1,now(),'open')`) }) } catch { clientPoolInsert = false }
    ok('a client cannot insert a pool', !clientPoolInsert)

    console.log('4. Discipline view:')
    const d = await sql`SELECT due, honoured, defaulted, commitments FROM buyer_pool_discipline_v1 WHERE msme_id = ${ids.msmeA}`
    ok('buyer A: due 1, honoured 1, defaulted 0, commitments 2', d[0]?.['due'] === 1 && d[0]?.['honoured'] === 1 && d[0]?.['defaulted'] === 0 && d[0]?.['commitments'] === 2, JSON.stringify(d[0]))
    const db = await sql`SELECT due, honoured, defaulted FROM buyer_pool_discipline_v1 WHERE msme_id = ${ids.msmeB}`
    ok('buyer B: due 1, honoured 0, defaulted 1', db[0]?.['due'] === 1 && db[0]?.['honoured'] === 0 && db[0]?.['defaulted'] === 1, JSON.stringify(db[0]))

    console.log(`\n${fail === 0 ? '✅' : '❌'} mart-pools: ${pass} passed, ${fail} failed\n`)
  } catch (e) {
    fail++
    console.error('\n✗ killtest aborted:', e instanceof Error ? e.message : e)
  } finally {
    await sql`DELETE FROM pools WHERE title LIKE ${tag + '%'}`
    await sql`DELETE FROM products WHERE name LIKE ${tag + '%'}`
    await sql`DELETE FROM provider_profiles WHERE slug LIKE ${tag + '%'}`
    await sql`DELETE FROM msme_profiles WHERE user_id IN (${ids.buyerA}, ${ids.buyerB})`
    await sql`DELETE FROM users WHERE id IN (${ids.seller}, ${ids.buyerA}, ${ids.buyerB}, ${ids.admin})`
    await sql`DELETE FROM auth.users WHERE id IN (${ids.seller}, ${ids.buyerA}, ${ids.buyerB}, ${ids.admin})`.catch(() => {})
    await sql.end()
    process.exit(fail === 0 ? 0 : 1)
  }
}
main().catch((e) => { console.error(e); process.exit(2) })
