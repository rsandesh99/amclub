import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'

export const dynamic = 'force-dynamic'

/** `rfq.expire` (§5.9) — RFQs past their 72h window with no accepted quote → 'expired'.
 *  (Accepted RFQs are already 'accepted' and untouched.) */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()

  const { data, error } = await admin
    .from('rfqs')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .in('status', ['open', 'quoted'])
    .lte('expires_at', new Date().toISOString())
    .select('id')
  if (error) {
    console.error('[cron/rfq-expire]', error)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }
  return NextResponse.json({ expired: data?.length ?? 0 })
}
