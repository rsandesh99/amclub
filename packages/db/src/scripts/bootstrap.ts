/**
 * Phase 8 §3 — fresh-database rebuild in ONE command.
 *
 * Applies every SQL migration (0000…latest, filename order, statement-
 * breakpoint aware) and then the RLS policies to the target database. This
 * closes the audit gap "migrations 0001+ are not journaled; disaster-recovery
 * path is run 14 files by hand".
 *
 * Target selection is EXPLICIT — this script will happily create 30 tables,
 * so it never silently uses DATABASE_URL:
 *   pnpm --filter @amclub/db db:bootstrap -- --url postgres://…/newdb
 *   pnpm --filter @amclub/db db:bootstrap -- --use-env-database-url
 *
 * Non-Supabase targets (local Postgres for drills/CI): the migrations
 * reference auth.users / auth.uid() / anon / authenticated / service_role.
 * When those are missing the script creates a minimal shim first (schema +
 * users table + uid() + roles) — detected automatically, skipped on Supabase.
 */
import postgres from 'postgres'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(__dirname, '../../../../apps/web/.env.local') })
dotenv.config({ path: path.resolve(__dirname, '../../../../.env.local') })

const args = process.argv.slice(2)
const urlFlag = args.indexOf('--url')
let target: string | undefined
if (urlFlag !== -1) target = args[urlFlag + 1]
else if (args.includes('--use-env-database-url')) target = process.env['DATABASE_URL']

if (!target) {
  console.error('Refusing to guess a target. Pass --url <postgres-url> or --use-env-database-url.')
  process.exit(1)
}

const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations')
const RLS_PATH = path.resolve(__dirname, '../rls/policies.sql')

const SUPABASE_SHIM = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY,
  email text,
  created_at timestamptz DEFAULT now()
);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $do$;
-- Supabase grants ALL on every new public table/sequence/function to the
-- client roles via default privileges; the migrations' REVOKEs (append-only
-- tables, 0004 column privileges) assume that baseline. Emulate it so a local
-- drill exercises the same grant surface (killtest-mart-schema relies on it).
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
`

async function main() {
  const sql = postgres(target!, { max: 1, onnotice: () => {} })
  try {
    const dbRows = await sql`SELECT current_database() AS db`
    console.log(`bootstrap → ${dbRows[0]!['db']}`)

    // Shim only when the Supabase surface is absent (bare Postgres).
    const authSchema = await sql`SELECT 1 FROM pg_namespace WHERE nspname = 'auth'`
    if (authSchema.length === 0) {
      console.log('  no auth schema — applying Supabase shim (local/bare-Postgres target)')
      await sql.unsafe(SUPABASE_SHIM)
    }

    // Helper prelude (FOLLOWUPS "fresh-bootstrap helper ordering"): migrations
    // 0016/0017/0021/0022/0023 carry inline RLS policies that call auth_user_id() /
    // has_role(), which policies.sql defines — and policies.sql runs LAST. On a
    // from-zero target those blocks failed. Apply ONLY the helper-function
    // section of policies.sql first (idempotent CREATE OR REPLACE; the full
    // file still runs at the end and re-asserts the same definitions).
    const rlsSource = fs.readFileSync(RLS_PATH, 'utf-8')
    const helpersEnd = rlsSource.indexOf('-- ─── Enable RLS on every table')
    if (helpersEnd > 0) {
      console.log('  rls/policies.sql (helper-function prelude)')
      // SQL-language bodies reference tables 0000 has not created yet; skip
      // body validation for the prelude only (the final full run re-checks).
      await sql.unsafe(`SET check_function_bodies = off; ${rlsSource.slice(0, helpersEnd)} SET check_function_bodies = on;`)
    }

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort() // 0000_…, 0001_…, … — numeric prefixes make lexicographic == chronological
    for (const file of files) {
      const migration = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8')
      const stmts = migration.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)
      process.stdout.write(`  ${file} (${stmts.length} blocks) `)
      for (let i = 0; i < stmts.length; i++) {
        try {
          await sql.unsafe(stmts[i]!)
        } catch (e) {
          console.error(`\nFAILED at ${file} block ${i + 1}:\n${stmts[i]!.slice(0, 300)}\n`)
          throw e
        }
      }
      console.log('✓')
    }

    console.log('  rls/policies.sql ')
    await sql.unsafe(fs.readFileSync(RLS_PATH, 'utf-8'))

    const tables = await sql`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`
    const policies = await sql`SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'`
    console.log(`done — ${tables[0]!['n']} tables, ${policies[0]!['n']} RLS policies`)
  } finally {
    await sql.end()
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
