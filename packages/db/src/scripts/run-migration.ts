import postgres from 'postgres'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(__dirname, '../../../../apps/web/.env.local') })
dotenv.config({ path: path.resolve(__dirname, '../../../../.env.local') })

const url = process.env['DATABASE_URL']
if (!url) throw new Error('DATABASE_URL not set')

const sql = postgres(url, { max: 1 })
const migration = fs.readFileSync(
  path.resolve(__dirname, '../migrations/0000_robust_phalanx.sql'),
  'utf-8'
)

const stmts = migration.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)
console.log(`Running ${stmts.length} statements...`)

async function main() {
  for (let i = 0; i < stmts.length; i++) {
    try {
      await sql.unsafe(stmts[i]!)
      process.stdout.write(`✓${i + 1} `)
    } catch (e: any) {
      console.log(`\n\nFailed at statement ${i + 1}:`)
      console.log(stmts[i]!.slice(0, 300))
      console.error('\nError:', e.message)
      await sql.end()
      process.exit(1)
    }
  }
  console.log('\n\nAll statements applied successfully.')
  await sql.end()
}

main()
