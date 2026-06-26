/** Verify anon CANNOT read gstin/pan from provider_profiles but CAN read safe
 *  columns. Uses the anon key (the public client's role). */
import { createClient } from '@supabase/supabase-js'
import path from 'path'
import dotenv from 'dotenv'
dotenv.config({ path: path.resolve(__dirname, '../../../../apps/web/.env.local') })
dotenv.config({ path: path.resolve(__dirname, '../../../../.env.local') })

const anon = createClient(process.env['NEXT_PUBLIC_SUPABASE_URL']!, process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY']!)

async function main() {
  const safe = await anon.from('provider_profiles').select('display_name, state').eq('status', 'active').limit(1)
  console.log(safe.error ? `✗ safe columns blocked: ${safe.error.message}` : `✓ anon CAN read safe columns (got ${safe.data?.length ?? 0} row)`)

  const sensitive = await anon.from('provider_profiles').select('gstin, pan').eq('status', 'active').limit(1)
  if (sensitive.error) console.log(`✓ anon BLOCKED from gstin/pan: ${sensitive.error.message}`)
  else console.log(`✗ LEAK — anon read gstin/pan: ${JSON.stringify(sensitive.data)}`)

  const view = await anon.from('public_providers').select('display_name').limit(1)
  console.log(view.error ? `• public_providers view: ${view.error.message}` : `✓ public_providers view readable (${view.data?.length ?? 0} row)`)
}
main().catch((e) => { console.error(e); process.exit(1) })
