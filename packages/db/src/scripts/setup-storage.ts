/** Create every Storage bucket production uses (KYC, orders, invoices, and the
 *  public CMS/media assets bucket — S1.3 drift fix: public-assets existed in
 *  prod but not here, so a DR rebuild would have 404'd the CMS banner).
 *  Idempotent — ignores "already exists". Run: tsx src/scripts/setup-storage.ts */
import { createClient } from '@supabase/supabase-js'
import path from 'path'
import dotenv from 'dotenv'

dotenv.config({ path: path.resolve(__dirname, '../../../../apps/web/.env.local') })
dotenv.config({ path: path.resolve(__dirname, '../../../../.env.local') })

const sb = createClient(process.env['NEXT_PUBLIC_SUPABASE_URL']!, process.env['SUPABASE_SERVICE_ROLE_KEY']!, {
  auth: { persistSession: false },
})

const BUCKETS: { name: string; public: boolean; fileSizeLimit?: number; allowedMimeTypes?: string[] }[] = [
  { name: 'kyc-documents', public: false },
  { name: 'order-documents', public: false },
  { name: 'invoices', public: false },
  // WhatsApp inbound media (S0.5) — private; runtime writes, signed reads.
  { name: 'wa-media', public: false },
  // Public-read, server-only-write (CMS banner images, marketing assets).
  { name: 'public-assets', public: true },
  // RFQ attachments (S1.8, spine) — private; buyer uploads through /api/v1/rfq/attachments,
  // 15-min signed reads for the buyer and matched providers. 10 MB; images, PDFs, STEP / DXF.
  {
    name: 'rfq-attachments',
    public: false,
    fileSizeLimit: 10 * 1024 * 1024,
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/step', 'model/step', 'application/dxf', 'image/vnd.dxf', 'application/octet-stream'],
  },
]

async function main() {
  for (const { name, public: isPublic, fileSizeLimit, allowedMimeTypes } of BUCKETS) {
    const { error } = await sb.storage.createBucket(name, {
      public: isPublic,
      ...(fileSizeLimit ? { fileSizeLimit } : {}),
      ...(allowedMimeTypes ? { allowedMimeTypes } : {}),
    })
    if (error && !/exists/i.test(error.message)) {
      console.error(`✗ ${name}: ${error.message}`)
    } else {
      console.log(`✓ ${name} (public: ${isPublic}) ${error ? '(already exists)' : 'created'}`)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
