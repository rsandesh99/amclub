import postgres from 'postgres'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(__dirname, '../../../../apps/web/.env.local') })
dotenv.config({ path: path.resolve(__dirname, '../../../../.env.local') })
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') })

const url = process.env['DATABASE_URL']
if (!url) throw new Error('DATABASE_URL not set')

const sql = postgres(url, { max: 1 })
const rlsSql = fs.readFileSync(path.resolve(__dirname, '../rls/policies.sql'), 'utf-8')

async function main() {
  console.log('Applying RLS policies...')
  await sql.unsafe(rlsSql)
  console.log('RLS policies applied successfully.')
  await sql.end()
}

main().catch((err) => {
  console.error('Failed to apply RLS:', err)
  process.exit(1)
})
