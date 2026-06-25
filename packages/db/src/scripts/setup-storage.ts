/** Create the private Storage buckets used by KYC, orders, and invoices.
 *  Idempotent — ignores "already exists". Run: tsx src/scripts/setup-storage.ts */
import { createClient } from '@supabase/supabase-js'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(__dirname, '../../../../apps/web/.env.local') })
dotenv.config({ path: path.resolve(__dirname, '../../../../.env.local') })

const sb = createClient(process.env['NEXT_PUBLIC_SUPABASE_URL']!, process.env['SUPABASE_SERVICE_ROLE_KEY']!, {
  auth: { persistSession: false },
})

const BUCKETS = ['kyc-documents', 'order-documents', 'invoices']

async function main() {
  for (const name of BUCKETS) {
    const { error } = await sb.storage.createBucket(name, { public: false })
    if (error && !/exists/i.test(error.message)) {
      console.error(`✗ ${name}: ${error.message}`)
    } else {
      console.log(`✓ ${name} ${error ? '(already exists)' : 'created'}`)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
