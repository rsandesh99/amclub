import { NextResponse } from 'next/server'
import { martApiGate } from '@/lib/mart/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { getPool, poolProgressFor, publicPool, buyerDiscipline } from '@/lib/mart/pools'

export const dynamic = 'force-dynamic'

/** The caller's pool commitments (newest first) + their discipline inputs. */
export async function GET() {
  const gate = martApiGate()
  if (gate) return gate
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = await createAdminClient()
  const { data: msme } = await admin.from('msme_profiles').select('id').eq('user_id', userId).maybeSingle()
  if (!msme) return NextResponse.json({ memberships: [], discipline: null })
  const { data: rows } = await admin.from('pool_members').select('*').eq('msme_id', msme.id).order('committed_at', { ascending: false }).limit(100)
  const memberships = []
  for (const m of rows ?? []) {
    const pool = await getPool(admin, m.pool_id)
    if (!pool) continue
    memberships.push({
      member: { id: m.id, qty: m.qty, payment_state: m.payment_state, pay_by: m.pay_by, order_id: m.order_id, committed_at: m.committed_at },
      pool: { ...publicPool(pool), progress: poolProgressFor(pool) },
    })
  }
  return NextResponse.json({ memberships, discipline: await buyerDiscipline(admin, msme.id) }, { headers: { 'Cache-Control': 'private, no-store' } })
}
