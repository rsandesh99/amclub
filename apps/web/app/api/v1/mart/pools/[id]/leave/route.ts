import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { martApiGate } from '@/lib/mart/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { leavePool, buyerPoolPayload } from '@/lib/mart/pools'

/** Withdraw a commitment — only while the pool is open. */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = martApiGate()
  if (gate) return gate
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const admin = await createAdminClient()
  const { data: msme } = await admin.from('msme_profiles').select('id').eq('user_id', userId).maybeSingle()
  if (!msme) return NextResponse.json({ error: 'No business profile' }, { status: 403 })
  const r = await leavePool(admin, { poolId: id, userId, msmeId: msme.id })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  // Audit M15 — never the agent rationale.
  return NextResponse.json({ pool: buyerPoolPayload(r.pool) })
}
