import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'

/** GET — dispute queue (§5.4). Filter by ?status=open|under_review|resolved. */
export async function GET(request: NextRequest) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const status = new URL(request.url).searchParams.get('status')
  const admin = await createAdminClient()
  let q = admin
    .from('disputes')
    .select('id, status, reason, resolution, resolution_amount_paise, created_at, resolved_at, order:orders(id, order_number, title, total_paise, status, provider_id, msme_id)')
    .order('created_at', { ascending: false })
    .limit(200)
  if (status) q = q.eq('status', status)
  const { data } = await q
  return NextResponse.json({ disputes: data ?? [] })
}
