/**
 * AMC Mart — LAUNCH GATE PREFLIGHT (MART_DESIGN.md §8). Checks every gate item
 * a machine can check against a deployment + its database, and prints the
 * commands for the ones a human runs. Exit non-zero on any FAIL; WARN never
 * blocks (the founder decides). Run it twice: before the flip with
 * EXPECT_FLAG=off (prod today), and after the enabling deploy with
 * EXPECT_FLAG=on.
 *
 *   1. M0–M2 acceptance + inertness → `pnpm --filter @amclub/web mart:acceptance` (printed, not run here)
 *   2. Staged migrations 0022–0025 applied (probed through PostgREST with the service role)
 *   3. Founder decisions §9 encoded: every registry key present + valid; categories configured
 *   4. Provider addendum goods schedule live with the flag (/api/v1/legal/versions)
 *   5. Seed supply: ≥ SEED_SELLERS_MIN goods-activated sellers with an approved listing; pilot buyers
 *   6. Services baseline: aged held / failed payouts, open disputes (WARN); suites printed
 *
 * Run: BASE_URL=https://amclub.in EXPECT_FLAG=on pnpm --filter @amclub/web exec tsx scripts/verify-launch-gate.ts
 * Needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in apps/web/.env.local. Read-only. Zero residue.
 */
import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'
import { MART_SETTING_KEYS, parseMartSetting, PROVIDER_ADDENDUM_GOODS_VERSION, LEGAL_VERSIONS } from '@amclub/shared'

const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'
const EXPECT_ON = (process.env['EXPECT_FLAG'] ?? 'on') === 'on'
const SEED_SELLERS_MIN = Number(process.env['SEED_SELLERS_MIN'] ?? 3)
const PILOT_STATE = process.env['PILOT_STATE'] ?? 'AP'
const PILOT_BUYERS_MIN = Number(process.env['PILOT_BUYERS_MIN'] ?? 20)
const URL_ = process.env['NEXT_PUBLIC_SUPABASE_URL']!
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']!
if (!URL_ || !SERVICE) { console.error('NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required'); process.exit(2) }
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } })

let pass = 0, warn = 0, fail = 0
const ok = (n: string, x = '') => { console.log(`  ✓ ${n}${x ? ' — ' + x : ''}`); pass++ }
const wn = (n: string, x = '') => { console.log(`  ! ${n}${x ? ' — ' + x : ''}`); warn++ }
const no = (n: string, x = '') => { console.log(`  ✗ ${n}${x ? ' — ' + x : ''}`); fail++ }
const check = (n: string, c: boolean, x = '') => (c ? ok(n, x) : no(n, x))
const http = async (p: string, init?: RequestInit) => { const r = await fetch(`${BASE}${p}`, init); return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> } }
/** A column probe: PostgREST returns 200 when the column exists, 400 (PGRST204/42703) when it does not. */
const column = async (table: string, col: string) => !(await admin.from(table).select(col).limit(1)).error

;(async () => {
  console.log(`\nMart Launch Gate preflight → ${BASE} (expecting flag ${EXPECT_ON ? 'ON' : 'OFF'})\n`)

  console.log('1. Acceptance suites (run separately):')
  console.log(`     MART_ENABLED=true  BASE_URL=<preview>  pnpm --filter @amclub/web mart:acceptance`)
  console.log(`     MART_ENABLED=false BASE_URL=<prod>     pnpm --filter @amclub/web mart:acceptance -- --inert`)

  console.log('2. Flag + staged migrations:')
  const cats = await http('/api/v1/mart/categories')
  check(`MART_ENABLED delivered ${EXPECT_ON ? 'ON (200)' : 'OFF (404)'} on /api/v1/mart/categories`, EXPECT_ON ? cats.status === 200 : cats.status === 404, String(cats.status))
  const m0022 = await column('mart_categories', 'slug')
  const m0023 = await column('pools', 'id')
  const m0024 = await column('rfqs', 'kind')
  const m0025 = await column('mart_categories', 'return_freight_payer')
  const applied = m0022 && m0023 && m0024 && m0025
  if (EXPECT_ON) check('0022–0025 applied (mart_categories, pools, rfqs.kind, return_freight_payer)', applied, `${[m0022, m0023, m0024, m0025].map((b) => (b ? '✓' : '✗')).join(' ')}`)
  else if (applied) wn('staged migrations already applied while the flag is OFF (allowed: additive, inert; §8.2 wants them with the enabling deploy)')
  else ok('staged migrations not applied (flag OFF) — apply them WITH the enabling deploy')

  console.log('3. Founder decisions §9 as config:')
  if (applied) {
    const { data: rows } = await admin.from('mart_settings').select('key, value, updated_at')
    const byKey = new Map((rows ?? []).map((r) => [r.key as string, r]))
    for (const k of MART_SETTING_KEYS) {
      const row = byKey.get(k)
      if (!row) { no(`setting ${k} present`, 'missing — set it in /admin/mart/settings'); continue }
      const r = parseMartSetting(k, row.value)
      check(`setting ${k} valid`, r.ok, r.ok ? JSON.stringify(row.value).slice(0, 60) : (r as { error: string }).error)
    }
    const tds = byKey.get('tds')?.value as { rate_bps?: number } | undefined
    if (tds && Number(tds.rate_bps ?? 0) === 0) wn('tds.rate_bps is 0 — CA has not confirmed the section/rate (§2)')
    const { data: catRows } = await admin.from('mart_categories').select('slug, is_active, bis_blocked, return_window_hours, commission_bps, return_freight_payer, updated_at')
    const active = (catRows ?? []).filter((c) => c.is_active && !c.bis_blocked)
    check('≥ 1 active, non-blocked Mart category', active.length > 0, `${active.length}`)
    const touched = (catRows ?? []).some((c) => c.updated_at)
    if (!touched) wn('no category has ever been edited — §9.2/§9.3 still at seed defaults (48 h / 5 %)')
    const poolCats = (byKey.get('pool_categories')?.value as string[] | undefined) ?? []
    const activeSlugs = new Set(active.map((c) => c.slug))
    check('pool_categories ⊆ active categories', poolCats.every((s) => activeSlugs.has(s)), poolCats.join(','))
    const mode = byKey.get('pool_payment_mode')?.value
    if (mode === 'block_capture') wn('pool_payment_mode=block_capture — refused at join until PSP report §5 is signed off')
  } else wn('skipped (migrations not applied)')

  console.log('4. Provider addendum goods schedule:')
  const lv = await http('/api/v1/legal/versions')
  const versions = (lv.body['versions'] ?? {}) as Record<string, string>
  if (EXPECT_ON) {
    check('addendum version = goods-schedule version', versions['provider_addendum'] === PROVIDER_ADDENDUM_GOODS_VERSION, `${versions['provider_addendum']} (sections ${String(lv.body['provider_addendum_sections'])})`)
    check('addendum renders 8 sections', lv.body['provider_addendum_sections'] === 8)
  } else {
    check('addendum still at the services version (no re-accept before the flip)', versions['provider_addendum'] === LEGAL_VERSIONS.provider_addendum, versions['provider_addendum'])
  }
  wn('counsel sign-off on sections 6–8 (§9.5 liability caps/indemnities) is a human check — docs/COMPLIANCE.md row')

  console.log('5. Seed supply + pilot demand:')
  if (applied) {
    const { data: sellers } = await admin.from('provider_profiles').select('id, display_name, state, status, sells_goods').eq('sells_goods', true).eq('status', 'active').is('deleted_at', null)
    const ids = (sellers ?? []).map((s) => s.id)
    const { data: listed } = ids.length ? await admin.from('products').select('seller_id, category_slug').eq('status', 'active').is('deleted_at', null).in('seller_id', ids) : { data: [] }
    const withListing = new Set((listed ?? []).map((p) => p.seller_id))
    const ready = (sellers ?? []).filter((s) => withListing.has(s.id))
    check(`≥ ${SEED_SELLERS_MIN} goods sellers with an approved listing`, ready.length >= SEED_SELLERS_MIN, ready.map((s) => `${s.display_name} (${s.state})`).join(', ') || 'none')
    const { count: buyers } = await admin.from('msme_profiles').select('id', { count: 'exact', head: true }).eq('state', PILOT_STATE)
    if ((buyers ?? 0) < PILOT_BUYERS_MIN) wn(`${buyers ?? 0} MSME profiles in ${PILOT_STATE} (pilot list target ${PILOT_BUYERS_MIN})`)
    else ok(`${buyers} MSME profiles in ${PILOT_STATE}`)
  } else wn('skipped (migrations not applied)')

  console.log('6. Services baseline (never flip during an incident):')
  const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString()
  const { count: heldOld } = await admin.from('payouts').select('id', { count: 'exact', head: true }).eq('status', 'held').lt('created_at', weekAgo)
  const { count: failed } = await admin.from('payouts').select('id', { count: 'exact', head: true }).eq('status', 'failed')
  const { count: disputes } = await admin.from('disputes').select('id', { count: 'exact', head: true }).eq('status', 'open')
  if ((heldOld ?? 0) > 0) wn(`${heldOld} payouts held > 7 days — clear the /admin/payouts worklist first`); else ok('no payouts held > 7 days')
  if ((failed ?? 0) > 0) wn(`${failed} failed payouts`); else ok('no failed payouts')
  if ((disputes ?? 0) > 0) wn(`${disputes} open disputes`); else ok('no open disputes')
  console.log('     services suites: verify-authz · verify-money-loop · verify-rfq · verify-te-render (run against the same deploy)')

  console.log(`\n${fail === 0 ? '✅' : '❌'} launch-gate preflight: ${pass} pass, ${warn} warn, ${fail} fail\n`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
