/**
 * One-time repair: the Phase 1 seed double-encoded JSONB columns (stored a JSON
 * *string* instead of an object — jsonb_typeof = 'string'), so ->>'key' returned
 * null, titles rendered blank, and packages.search_tsv indexed empty text.
 *
 * Decode in place: col = (col #>> '{}')::jsonb where jsonb_typeof(col) = 'string'.
 * The UPDATE on packages re-fires the BEFORE-UPDATE tsv trigger, repopulating
 * search_tsv correctly. Idempotent (the WHERE guard skips already-fixed rows).
 */
import postgres from 'postgres'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(__dirname, '../../../../apps/web/.env.local') })
dotenv.config({ path: path.resolve(__dirname, '../../../../.env.local') })

const sql = postgres(process.env['DATABASE_URL']!, { max: 1 })

const TARGETS: { table: string; columns: string[] }[] = [
  { table: 'categories', columns: ['name_i18n', 'description_i18n', 'rfq_template'] },
  {
    table: 'packages',
    columns: ['title_i18n', 'scope_included', 'scope_excluded', 'deliverables', 'requirements_template', 'faqs'],
  },
]

async function main() {
  for (const { table, columns } of TARGETS) {
    for (const col of columns) {
      const res = await sql.unsafe(
        `UPDATE ${table} SET ${col} = (${col} #>> '{}')::jsonb
         WHERE ${col} IS NOT NULL AND jsonb_typeof(${col}) = 'string'`,
      )
      console.log(`${table}.${col}: fixed ${res.count} row(s)`)
    }
  }

  // Verify FTS now works.
  for (const q of ['GST', 'trademark', 'website', 'loan', 'payroll']) {
    const rows = await sql`SELECT count(*)::int AS n FROM search_packages(p_query => ${q}, p_limit => 50)`
    console.log(`  FTS "${q}" → ${rows[0]?.['n'] ?? 0} results`)
  }
  const [t] = await sql`SELECT title_i18n->>'en' AS en FROM packages LIMIT 1`
  console.log(`Sample title ->>'en' = ${t?.['en']}`)

  await sql.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
