import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { poolJoinSchema } from '@amclub/shared'
import { martApiGate } from '@/lib/mart/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { joinPool, poolProgressFor } from '@/lib/mart/pools'
import { accountSuspendedResponse } from '@/lib/auth/suspension'

/** Commit to a pool (qty + delivery snapshot). Pay-on-close: no money moves here. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = martApiGate()
  if (gate) return gate
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const rl = await enforce(limiters.checkout, `pool-join:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const { id } = await params
  const parsed = poolJoinSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const admin = await createAdminClient()
  const { data: msme } = await admin.from('msme_profiles').select('id, deleted_at').eq('user_id', userId).maybeSingle()
  if (!msme) return NextResponse.json({ error: 'Complete your business profile first' }, { status: 403 })
  if (msme.deleted_at) return accountSuspendedResponse()
  const r = await joinPool(admin, { poolId: id, userId, msmeId: msme.id, input: parsed.data })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status })
  return NextResponse.json({
    member: { id: r.member.id, qty: r.member.qty, payment_state: r.member.payment_state },
    pool: { ...r.pool, progress: poolProgressFor(r.pool) },
    changed: r.changed,
  })
}
