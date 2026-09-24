import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { poolCancelSchema } from '@amclub/shared'
import { agentApiGate } from '@/lib/agent/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { cancelPool, poolErrorStatus } from '@/lib/pools/actions'
import { writeAudit } from '@/lib/audit/log'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'

/**
 * POST /api/v1/agent/admin/pools/[id]/cancel { reason } (S3.4, ADR 024) — ops stops a forming or open group. Members
 * are released and told; their requests carry on as normal. A group already closing is finished, never cancelled.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = agentApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const rl = await enforce(limiters.adminMutation, `admin:${auth.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const parsed = poolCancelSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 422 })
  const admin = await createAdminClient()
  const r = await cancelPool(admin, { adminUserId: auth.userId, poolId: id, reason: parsed.data.reason })
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: poolErrorStatus(r.error) })
  await writeAudit(admin, request, { actorId: auth.userId, action: 'pool.cancel', entity: 'service_pools', entityId: id, after: { reason: parsed.data.reason } })
  return NextResponse.json({ ok: true })
}
