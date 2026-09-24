import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { martApiGate } from '@/lib/mart/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { getPool, getMember, poolCardText, poolProgressFor, publicPool } from '@/lib/mart/pools'

export const dynamic = 'force-dynamic'

/** One pool (public) + the caller's own membership when signed in + share text. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = martApiGate()
  if (gate) return gate
  const { id } = await params
  const admin = await createAdminClient()
  const pool = await getPool(admin, id)
  if (!pool || pool.status === 'draft' || pool.status === 'cancelled') return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { userId } = await getAuthedSupabase()
  let member = null
  if (userId) {
    const { data: msme } = await admin.from('msme_profiles').select('id').eq('user_id', userId).maybeSingle()
    if (msme) member = await getMember(admin, id, msme.id)
  }
  const locale = (request.nextUrl.searchParams.get('locale') ?? 'en') as 'en' | 'hi' | 'te'
  const base = process.env['NEXT_PUBLIC_APP_URL'] ?? request.nextUrl.origin
  return NextResponse.json(
    {
      pool: { ...publicPool(pool), progress: poolProgressFor(pool) },
      member: member ? { id: member.id, qty: member.qty, payment_state: member.payment_state, pay_by: member.pay_by, order_id: member.order_id } : null,
      shareText: poolCardText(pool, ['hi', 'te'].includes(locale) ? locale : 'en', `${base}/mart/pools/${pool.id}`),
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
