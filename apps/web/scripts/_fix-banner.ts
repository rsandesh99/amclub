import { config } from 'dotenv'
import path from 'path'
config({ path: path.resolve(__dirname, '../.env.local') })
import { createClient } from '@supabase/supabase-js'

const admin = createClient(
  process.env['NEXT_PUBLIC_SUPABASE_URL']!,
  process.env['SUPABASE_SERVICE_ROLE_KEY']!,
  { auth: { persistSession: false } },
)

async function main() {
  const { error } = await admin
    .from('cms_banners')
    .update({
      image_url:
        'https://szccxxzlvkbjhqwucteo.supabase.co/storage/v1/object/public/public-assets/amclub-launch-banner.png',
      link: '/services',
      starts_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', '44bdad64-d629-4cd0-ba9b-50a6386a057a')
  if (error) throw error
  console.log('banner row fixed')
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
