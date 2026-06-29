import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth/admin'

/** GET — all orders, filterable by status, provider, msme, date range, q (order #). */
export async function GET(request: NextRequest) {
  const gate = await requireAdmin()
  if (gate.error) return gate.error

  const sp = new URL(request.url).searchParams
  const admin = await createAdminClient()
  let query = admin
    .from('orders')
    .select('id, order_number, title, status, source, total_paise, provider_earning_paise, commission_paise, provider_id, msme_id, created_at')
    .order('created_at', { ascending: false })
    .limit(200)

  const status = sp.get('status')
  const providerId = sp.get('providerId')
  const msmeId = sp.get('msmeId')
  const q = sp.get('q')?.trim()
  const from = sp.get('from')
  const to = sp.get('to')
  if (status) query = query.eq('status', status)
  if (providerId) query = query.eq('provider_id', providerId)
  if (msmeId) query = query.eq('msme_id', msmeId)
  if (q) query = query.ilike('order_number', `%${q}%`)
  if (from) query = query.gte('created_at', from)
  if (to) query = query.lte('created_at', to)

  const { data } = await query
  return NextResponse.json({ orders: data ?? [] })
}
