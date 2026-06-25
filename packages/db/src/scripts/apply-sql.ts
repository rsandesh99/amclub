/**
 * Apply a single SQL migration file by name (statement-breakpoint aware).
 * Usage: tsx src/scripts/apply-sql.ts 0001_catalog_search.sql
 */
import postgres from 'postgres'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(__dirname, '../../../../apps/web/.env.local') })
dotenv.config({ path: path.resolve(__dirname, '../../../../.env.local') })

const url = process.env['DATABASE_URL']
if (!url) throw new Error('DATABASE_URL not set')

const file = process.argv[2]
if (!file) throw new Error('Usage: tsx src/scripts/apply-sql.ts <migration-file.sql>')

const sql = postgres(url, { max: 1 })
const migration = fs.readFileSync(path.resolve(__dirname, '../migrations', file), 'utf-8')
const stmts = migration.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean)

async function main() {
  console.log(`Applying ${file} (${stmts.length} statement block(s))...`)
  for (let i = 0; i < stmts.length; i++) {
    try {
      await sql.unsafe(stmts[i]!)
      process.stdout.write(`✓${i + 1} `)
    } catch (e) {
      console.log(`\n\nFailed at statement ${i + 1}:`)
      console.log(stmts[i]!.slice(0, 300))
      console.error('\nError:', e instanceof Error ? e.message : e)
      await sql.end()
      process.exit(1)
    }
  }
  console.log('\n\nApplied successfully.')
  await sql.end()
}

main()
