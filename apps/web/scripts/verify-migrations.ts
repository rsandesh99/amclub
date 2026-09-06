/**
 * S1.4 — applied-migration preflight (verify-* convention).
 *
 * For every migration file, asserts its principal objects exist in the target
 * database. The manifest below is HAND-CURATED by design — parsing SQL for
 * object names is false precision. Every new migration MUST add its manifest
 * entry (enforced: the script fails if a migration file has no entry).
 *
 * Two modes:
 *   REST mode (default, needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *   from apps/web/.env.local): verifies tables and views by probing PostgREST
 *   with the service role — structure coverage, functions/triggers SKIPPED.
 *   SQL mode (additionally set DATABASE_URL): authoritative — to_regclass for
 *   tables/views, pg_proc for functions, pg_trigger for triggers.
 *
 * Exit: non-zero on ANY missing object (SKIPPED is not missing).
 * Run: pnpm --filter @amclub/web exec tsx scripts/verify-migrations.ts
 */
import { config } from 'dotenv'
import path from 'path'
import { readdirSync } from 'fs'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

interface Entry {
  file: string
  tables?: string[]
  views?: string[]
  functions?: string[]
  /** [table, trigger] pairs */
  triggers?: [string, string][]
  note?: string
  /** Dark-build migration: not applied to prod until its Launch Gate. */
  staged?: boolean
}

// ─── THE MANIFEST — one entry per migration file + policies.sql ──────────────
const MANIFEST: Entry[] = [
  {
    file: '0000_robust_phalanx.sql',
    tables: [
      'users', 'msme_profiles', 'provider_profiles', 'provider_verifications',
      'provider_bank_accounts', 'categories', 'provider_categories', 'packages',
      'rfqs', 'rfq_matches', 'quotes', 'orders', 'order_events',
      'order_milestones', 'order_documents', 'payments', 'refunds', 'payouts',
      'disputes', 'reviews', 'conversations', 'messages', 'saved_providers',
      'notifications', 'coupons', 'coupon_redemptions', 'invoices',
      'audit_logs', 'cms_banners',
    ],
    functions: ['set_updated_at', 'generate_order_number', 'packages_tsv_update'],
    triggers: [['packages', 'packages_tsv_trigger']],
  },
  { file: '0001_catalog_search.sql', functions: ['search_packages'] },
  { file: '0002_checkout_sessions.sql', tables: ['checkout_sessions'] },
  { file: '0003_materialize_order.sql', functions: ['materialize_order'] },
  { file: '0004_provider_column_privileges.sql', note: 'grants only — no structural objects' },
  { file: '0005_msme_state_nullable.sql', note: 'column alteration only' },
  { file: '0006_users_phone_nullable.sql', note: 'column alteration only' },
  { file: '0007_search_headline_credential.sql', functions: ['search_packages'] },
  { file: '0008_orders_external_wait.sql', note: 'column addition only (orders.external_wait_since)' },
  { file: '0009_rfq_quote_slot.sql', functions: ['claim_quote_slot', 'release_quote_slot'] },
  { file: '0010_reviews_coupons_engagement.sql', functions: ['recompute_provider_rating', 'increment_coupon_usage'] },
  { file: '0011_cms_hero_banner.sql', note: 'column additions + CHECK on cms_banners' },
  { file: '0012_rfq_voice_meta.sql', note: 'column addition only (rfqs.voice_meta)' },
  { file: '0013_ai_invocations.sql', tables: ['ai_invocations'] },
  { file: '0014_cron_heartbeats.sql', tables: ['cron_heartbeats'] },
  { file: '0015_provider_depth.sql', note: 'column additions only (years_experience, website)' },
  {
    file: '0016_quote_events_score_inputs.sql',
    tables: ['quote_events', 'bank_account_verifications'],
    views: ['provider_score_inputs_v1'],
    triggers: [['quote_events', 'quote_events_no_update']],
  },
  {
    file: '0017_terms_acceptances_refund_key.sql',
    tables: ['terms_acceptances'],
    functions: ['raise_append_only'],
    triggers: [['terms_acceptances', 'terms_acceptances_no_update']],
  },
  { file: '0018_quote_terms.sql', note: 'column additions only (quotes.gst_included/transport_included/valid_until/advance_percent)' },
  {
    file: '0019_order_events_append_only.sql',
    triggers: [['order_events', 'order_events_no_update']],
    note: 'trigger + REVOKE; reuses raise_append_only() from 0017',
  },
  {
    file: '0020_order_kind_columns.sql',
    views: ['order_safe_view', 'provider_score_inputs_v1'],
    note: 'kind columns on orders + checkout_sessions (defaults, no writer); safe-view rebuild; score view kind-scoped',
  },
  { file: '0021_gstin_verifications.sql', tables: ['gstin_verifications'] },
  {
    // AMC Mart M0 — STAGED (dark build): MISSING on prod is EXPECTED until the
    // Launch Gate deploy applies it. Set MART_MIGRATIONS_EXPECTED=false to
    // downgrade its rows to 'skipped' while verifying prod during the build.
    file: '0022_mart_catalog.sql',
    tables: ['mart_categories', 'mart_settings', 'products', 'price_tiers', 'product_events', 'ai_decisions'],
    views: ['order_safe_view'],
    functions: ['materialize_order'],
    triggers: [['product_events', 'product_events_no_update'], ['ai_decisions', 'ai_decisions_no_update']],
    staged: true,
  },
  // Not a migration, but bootstrap applies it last and its views must exist.
  { file: 'rls/policies.sql', views: ['order_safe_view', 'public_providers'] },
]

// ─── plumbing ────────────────────────────────────────────────────────────────
const URL = process.env['NEXT_PUBLIC_SUPABASE_URL']
const SERVICE = process.env['SUPABASE_SERVICE_ROLE_KEY']
const DB_URL = process.env['DATABASE_URL']
if (!URL || !SERVICE) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in apps/web/.env.local')
  process.exit(2)
}
const rest = createClient(URL, SERVICE, { auth: { persistSession: false } })

type Status = 'present' | 'MISSING' | 'skipped'
const rows: { migration: string; object: string; status: Status }[] = []
let missing = 0

function record(migration: string, object: string, status: Status) {
  rows.push({ migration, object, status })
  if (status === 'MISSING') missing++
}

async function restRelationExists(name: string): Promise<boolean> {
  // NOT head:true — PostgREST answers HEAD with 204 even for nonexistent
  // tables (verified against prod), which made every check pass. A real
  // select with limit(0) errors PGRST205/42P01 on a missing relation.
  const { error } = await rest.from(name).select('*').limit(0)
  if (!error) return true
  // 42P01 undefined_table / PGRST205 not in schema cache → missing.
  if (error.code === '42P01' || error.code === 'PGRST205' || /does not exist|schema cache/i.test(error.message)) {
    return false
  }
  // Any other error (e.g. RLS on a zero-policy table still 200s for service
  // role; unexpected errors) — the relation resolved, so it exists.
  return true
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function main() {
  // Every migration file must have a manifest entry.
  const migrationsDir = path.resolve(__dirname, '../../../packages/db/src/migrations')
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))
  const manifested = new Set(MANIFEST.map((m) => m.file))
  const unmanifested = files.filter((f) => !manifested.has(f))
  if (unmanifested.length > 0) {
    console.error(`✗ Migration files without a manifest entry: ${unmanifested.join(', ')}`)
    console.error('  Add each to MANIFEST in scripts/verify-migrations.ts (definition of done).')
    process.exit(1)
  }

  let sql: any = null
  if (DB_URL) {
    const dbPkg: any = await import('@amclub/db')
    sql = dbPkg.db
  }

  const stagedExpected = process.env['MART_MIGRATIONS_EXPECTED'] !== 'false'
  for (const entry of MANIFEST) {
    if (entry.staged && !stagedExpected) {
      record(entry.file, '(staged — MART_MIGRATIONS_EXPECTED=false)', 'skipped')
      continue
    }
    for (const t of entry.tables ?? []) {
      if (sql) {
        const r = await sql`SELECT to_regclass(${'public.' + t}) AS reg`
        record(entry.file, `table ${t}`, r[0]?.reg ? 'present' : 'MISSING')
      } else {
        record(entry.file, `table ${t}`, (await restRelationExists(t)) ? 'present' : 'MISSING')
      }
    }
    for (const v of entry.views ?? []) {
      if (sql) {
        const r = await sql`SELECT to_regclass(${'public.' + v}) AS reg`
        record(entry.file, `view ${v}`, r[0]?.reg ? 'present' : 'MISSING')
      } else {
        record(entry.file, `view ${v}`, (await restRelationExists(v)) ? 'present' : 'MISSING')
      }
    }
    for (const f of entry.functions ?? []) {
      if (sql) {
        const r = await sql`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ${f}`
        record(entry.file, `function ${f}`, r[0]?.n > 0 ? 'present' : 'MISSING')
      } else {
        record(entry.file, `function ${f}`, 'skipped')
      }
    }
    for (const [table, trig] of entry.triggers ?? []) {
      if (sql) {
        const r = await sql`SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = ${table} AND t.tgname = ${trig} AND NOT t.tgisinternal`
        record(entry.file, `trigger ${trig} ON ${table}`, r[0]?.n > 0 ? 'present' : 'MISSING')
      } else {
        record(entry.file, `trigger ${trig} ON ${table}`, 'skipped')
      }
    }
    if (!entry.tables && !entry.views && !entry.functions && !entry.triggers) {
      record(entry.file, `(${entry.note ?? 'no structural objects'})`, 'present')
    }
  }

  // Report table
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s.padEnd(n))
  console.log(`\nverify-migrations → ${URL} ${sql ? '(SQL mode — authoritative)' : '(REST mode — functions/triggers skipped; set DATABASE_URL for full checks)'}\n`)
  for (const r of rows) {
    const mark = r.status === 'present' ? '✓' : r.status === 'skipped' ? '⏭' : '✗'
    console.log(`  ${mark} ${pad(r.migration, 42)} ${pad(r.object, 48)} ${r.status}`)
  }
  const skipped = rows.filter((r) => r.status === 'skipped').length
  console.log(`\n${missing === 0 ? '✅' : '❌'} ${rows.length} checks: ${rows.length - missing - skipped} present, ${skipped} skipped, ${missing} MISSING\n`)
  if (sql) await sql.end?.()
  process.exit(missing === 0 ? 0 : 1)
}
main().catch((e) => {
  console.error(e)
  process.exit(2)
})
