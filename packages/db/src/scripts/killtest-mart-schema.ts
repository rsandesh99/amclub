/**
 * AMC Mart M0 — schema-level killtests (run against a bootstrapped LOCAL
 * Postgres, never prod). Proves, at the DB layer, the four claims the dark
 * build makes about migration 0022:
 *
 *  1. product_events / ai_decisions are append-only (BEFORE UPDATE raises;
 *     client roles cannot UPDATE/DELETE).
 *  2. materialize_order is INERT for services: a session without goods
 *     columns produces an order with kind='service', line_items NULL,
 *     delivery_snapshot NULL — the same row 0003 produced.
 *  3. materialize_order copies goods columns for kind='goods' sessions.
 *  4. RLS: cross-tenant catalog reads = 0 rows (seller B cannot see seller A's
 *     drafts; the public sees only ACTIVE products of ACTIVE goods sellers).
 *
 * Usage: pnpm --filter @amclub/db exec tsx src/scripts/killtest-mart-schema.ts --url postgres://…/amclub
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
  const tag = `kt_mart_${Date.now()}`
  const ids = {
    userA: randomUUID(), userB: randomUUID(), buyer: randomUUID(),
    sellerA: '', sellerB: '', msme: '', productA: '', productB: '',
    orders: [] as string[],
  }
  try {
    console.log(`\nMart schema killtests → ${target!.replace(/\/\/.*@/, '//***@')}\n`)

    // ── fixtures ──────────────────────────────────────────────────────────
    for (const [uid, label] of [[ids.userA, 'a'], [ids.userB, 'b'], [ids.buyer, 'buyer']] as const) {
      await sql`INSERT INTO auth.users (id, email) VALUES (${uid}, ${`${tag}_${label}@killtest.amclub`})`
      await sql`INSERT INTO users (id, email, roles) VALUES (${uid}, ${`${tag}_${label}@killtest.amclub`}, ${label === 'buyer' ? sql.array(['msme']) : sql.array(['provider'])})`
    }
    const mkSeller = async (uid: string, label: string, sells: boolean) => {
      const r = await sql`INSERT INTO provider_profiles (user_id, legal_name, display_name, slug, state, status, languages, sells_goods)
        VALUES (${uid}, ${label}, ${label}, ${`${tag}-${label}`}, 'AP', 'active', ${sql.array(['en'])}, ${sells}) RETURNING id`
      return r[0]!['id'] as string
    }
    ids.sellerA = await mkSeller(ids.userA, 'sellerA', true)
    ids.sellerB = await mkSeller(ids.userB, 'sellerB', false)
    const m = await sql`INSERT INTO msme_profiles (user_id, business_name, state) VALUES (${ids.buyer}, 'KT Buyer', 'AP') RETURNING id`
    ids.msme = m[0]!['id'] as string

    const pA = await sql`INSERT INTO products (seller_id, category_slug, name, hsn_code, gst_rate_bps, unit, status)
      VALUES (${ids.sellerA}, 'fasteners', ${`${tag} M8 bolt`}, '7318', 1800, 'pcs', 'active') RETURNING id`
    ids.productA = pA[0]!['id'] as string
    await sql`INSERT INTO price_tiers (product_id, min_qty, unit_price_paise) VALUES (${ids.productA}, 1, 450), (${ids.productA}, 100, 400)`
    const pB = await sql`INSERT INTO products (seller_id, category_slug, name, hsn_code, gst_rate_bps, unit, status)
      VALUES (${ids.sellerB}, 'fasteners', ${`${tag} draft nut`}, '7318', 1800, 'pcs', 'draft') RETURNING id`
    ids.productB = pB[0]!['id'] as string
    await sql`INSERT INTO product_events (product_id, actor_id, event_type, payload) VALUES (${ids.productA}, ${ids.userA}, 'created', '{}')`

    // ── 1. append-only ────────────────────────────────────────────────────
    console.log('1. Append-only event tables:')
    let raised = false
    try { await sql`UPDATE product_events SET payload = '{"x":1}' WHERE product_id = ${ids.productA}` } catch (e) { raised = /append-only/.test(String(e)) }
    ok('UPDATE product_events raises (trigger)', raised)
    await sql`INSERT INTO ai_decisions (feature, input_refs, proposed, final, decided_by) VALUES ('catalog_draft', '{}', '{"name":"a"}', '{"name":"b"}', ${ids.userA})`
    raised = false
    try { await sql`UPDATE ai_decisions SET final = '{}' WHERE decided_by = ${ids.userA}` } catch (e) { raised = /append-only/.test(String(e)) }
    ok('UPDATE ai_decisions raises (trigger)', raised)
    const grants = await sql`SELECT table_name, privilege_type FROM information_schema.role_table_grants
      WHERE grantee IN ('anon','authenticated') AND table_name IN ('product_events','ai_decisions') AND privilege_type IN ('UPDATE','DELETE')`
    ok('UPDATE/DELETE revoked from anon+authenticated on product_events + ai_decisions', grants.length === 0, `(${grants.length} grants)`)

    // ── 2 + 3. materialize_order ──────────────────────────────────────────
    console.log('2. materialize_order — services inertness:')
    const mkSession = async (goods: boolean) => {
      const rzp = `order_${tag}_${goods ? 'g' : 's'}_${randomUUID().slice(0, 6)}`
      const line = goods ? [{ product_id: ids.productA, name: 'M8 bolt', unit: 'pcs', qty: 100, tier_min_qty: 100, tier_unit_price_paise: 400, hsn_code: '7318', gst_rate_bps: 1800, line_taxable_paise: 40000, line_gst_paise: 7200 }] : null
      const deliv = goods ? { city: 'Kurnool', pincode: '518001', pickup: false } : null
      if (goods) {
        await sql`INSERT INTO checkout_sessions (razorpay_order_id, msme_id, provider_id, source, title, scope_snapshot,
            price_paise, discount_paise, gst_paise, total_paise, commission_bps, commission_paise, provider_earning_paise,
            delivery_days, idempotency_key, status, kind, line_items, delivery_snapshot)
          VALUES (${rzp}, ${ids.msme}, ${ids.sellerA}, 'package', 'KT goods', '{}', 40000, 0, 7200, 47200, 500, 2000, 38000, 3,
            ${randomUUID()}, 'created', 'goods', ${sql.json(line)}, ${sql.json(deliv)})`
      } else {
        // EXACTLY the column list the services checkout route writes — no kind / goods columns.
        await sql`INSERT INTO checkout_sessions (razorpay_order_id, msme_id, provider_id, source, title, scope_snapshot,
            price_paise, discount_paise, gst_paise, total_paise, commission_bps, commission_paise, provider_earning_paise,
            delivery_days, idempotency_key, status)
          VALUES (${rzp}, ${ids.msme}, ${ids.sellerA}, 'package', 'KT service', '{}', 500000, 0, 90000, 590000, 500, 25000, 475000, 5,
            ${randomUUID()}, 'created')`
      }
      const r = await sql`SELECT materialize_order(${rzp}, ${`pay_${rzp}`}, ${goods ? 47200 : 590000}, 'upi', '{}'::jsonb) AS id`
      const id = r[0]!['id'] as string
      ids.orders.push(id)
      return { id, rzp }
    }
    const svc = await mkSession(false)
    const svcRow = (await sql`SELECT kind, line_items, delivery_snapshot, status, total_paise FROM orders WHERE id = ${svc.id}`)[0]!
    ok("services order has kind='service'", svcRow['kind'] === 'service')
    ok('services order line_items IS NULL', svcRow['line_items'] === null)
    ok('services order delivery_snapshot IS NULL', svcRow['delivery_snapshot'] === null)
    ok('services order placed with frozen total', svcRow['status'] === 'placed' && Number(svcRow['total_paise']) === 590000)
    const replay = await sql`SELECT materialize_order(${svc.rzp}, ${`pay_${svc.rzp}`}, 590000, 'upi', '{}'::jsonb) AS id`
    ok('replayed webhook returns the SAME order (no duplicate)', replay[0]!['id'] === svc.id)

    console.log('3. materialize_order — goods columns copied:')
    const g = await mkSession(true)
    const gRow = (await sql`SELECT kind, line_items, delivery_snapshot FROM orders WHERE id = ${g.id}`)[0]!
    ok("goods order has kind='goods'", gRow['kind'] === 'goods')
    const li = gRow['line_items'] as { hsn_code: string; qty: number }[] | null
    ok('goods order line_items copied verbatim (hsn + qty)', li?.[0]?.hsn_code === '7318' && li?.[0]?.qty === 100)
    ok('goods order delivery_snapshot copied', (gRow['delivery_snapshot'] as { city?: string } | null)?.city === 'Kurnool')
    const safe = await sql`SELECT kind, line_items FROM order_safe_view WHERE id = ${g.id}`
    ok('order_safe_view rebuilt with the new columns', safe[0]?.['kind'] === 'goods' && safe[0]?.['line_items'] !== undefined)

    // ── 4. RLS ────────────────────────────────────────────────────────────
    console.log('4. RLS — cross-tenant catalog reads = 0 rows:')
    // Run one query as a client role inside a transaction: SET LOCAL ROLE +
    // the JWT sub claim the auth.uid() shim reads (Supabase sets the same GUC).
    const countAs = async (uid: string | null, role: 'anon' | 'authenticated', query: string): Promise<number> =>
      sql.begin(async (tx) => {
        if (uid) await tx.unsafe(`SELECT set_config('request.jwt.claim.sub', '${uid}', true)`)
        await tx.unsafe(`SET LOCAL ROLE ${role}`)
        const r = await tx.unsafe(query)
        return Number(r[0]!['n'])
      }) as Promise<number>
    const products = (where: string) => `SELECT count(*)::int AS n FROM products WHERE name LIKE '${tag}%' ${where}`

    ok('anon sees ONLY the active product of the goods-activated seller', (await countAs(null, 'anon', products(''))) === 1)
    ok("anon cannot see seller B's draft", (await countAs(null, 'anon', products(`AND id = '${ids.productB}'`))) === 0)
    ok("seller B cannot see seller A's product via owner policy scope (still public-active only)", (await countAs(ids.userB, 'authenticated', products(`AND id = '${ids.productA}'`))) === 1)
    ok("seller A cannot see seller B's DRAFT", (await countAs(ids.userA, 'authenticated', products(`AND id = '${ids.productB}'`))) === 0)
    ok('seller B sees own draft', (await countAs(ids.userB, 'authenticated', products(`AND id = '${ids.productB}'`))) === 1)
    // Deactivate seller A's goods flag → their active product vanishes from the public catalog.
    await sql`UPDATE provider_profiles SET sells_goods = false WHERE id = ${ids.sellerA}`
    ok('sells_goods=false hides an active product from the public (activation gate is a read gate too)', (await countAs(null, 'anon', products(''))) === 0)
    const tiersAnon = await countAs(null, 'anon', `SELECT count(*)::int AS n FROM price_tiers WHERE product_id = '${ids.productA}'`)
    ok('price_tiers follow the product visibility (0 rows when seller not goods-active)', tiersAnon === 0)
    const evAnon = await countAs(ids.userB, 'authenticated', `SELECT count(*)::int AS n FROM product_events WHERE product_id = '${ids.productA}'`)
    ok("seller B cannot read seller A's product_events", evAnon === 0)
    const settings = await countAs(ids.userB, 'authenticated', `SELECT count(*)::int AS n FROM mart_settings`)
    ok('non-admin cannot read mart_settings', settings === 0)

    console.log(`\n${fail === 0 ? '✅' : '❌'} mart-schema: ${pass} passed, ${fail} failed\n`)
  } catch (e) {
    fail++
    console.error('\n✗ killtest aborted:', e instanceof Error ? e.message : e)
  } finally {
    // zero residue
    for (const id of ids.orders) {
      await sql`DELETE FROM payments WHERE order_id = ${id}`
      await sql`DELETE FROM order_events WHERE order_id = ${id}`
      await sql`UPDATE checkout_sessions SET order_id = NULL WHERE order_id = ${id}`
      await sql`DELETE FROM orders WHERE id = ${id}`
    }
    await sql`DELETE FROM checkout_sessions WHERE msme_id = ${ids.msme}`.catch(() => {})
    await sql`DELETE FROM ai_decisions WHERE decided_by IN (${ids.userA}, ${ids.userB})`
    await sql`DELETE FROM products WHERE name LIKE ${tag + '%'}`
    await sql`DELETE FROM provider_profiles WHERE slug LIKE ${tag + '%'}`
    await sql`DELETE FROM msme_profiles WHERE user_id = ${ids.buyer}`
    await sql`DELETE FROM users WHERE id IN (${ids.userA}, ${ids.userB}, ${ids.buyer})`
    await sql`DELETE FROM auth.users WHERE id IN (${ids.userA}, ${ids.userB}, ${ids.buyer})`.catch(() => {})
    await sql.end()
    process.exit(fail === 0 ? 0 : 1)
  }
}
main().catch((e) => { console.error(e); process.exit(2) })
