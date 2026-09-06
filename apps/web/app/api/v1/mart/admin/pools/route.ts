import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { poolDraftSchema } from '@amclub/shared'
import { martApiGate } from '@/lib/mart/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { listPools, createDraftPool, getPool, poolProgressFor, type PoolRowStatus } from '@/lib/mart/pools'

export const dynamic = 'force-dynamic'

const STATUSES: PoolRowStatus[] = ['draft', 'open', 'closed_met', 'closed_unmet', 'ordered', 'fulfilled', 'cancelled']

/** Pool worklist by status (drafts first by default). */
export async function GET(request: NextRequest) {
  const gate = martApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const status = (request.nextUrl.searchParams.get('status') ?? 'draft') as PoolRowStatus
  if (!STATUSES.includes(status)) return NextResponse.json({ error: 'Invalid status' }, { status: 422 })
  const admin = await createAdminClient()
  const pools = await listPools(admin, { statuses: [status], limit: 200 })
  return NextResponse.json({ pools: pools.map((p) => ({ ...p, progress: poolProgressFor(p) })) }, { headers: { 'Cache-Control': 'private, no-store' } })
}

/** Founder creates a draft by hand (same shape the agent proposes). */
export async function POST(request: NextRequest) {
  const gate = martApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const rl = await enforce(limiters.adminMutation, `admin:${auth.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const body = await request.json().catch(() => null)
  const parsed = poolDraftSchema.safeParse(body?.draft ?? body)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const admin = await createAdminClient()
  const { id } = await createDraftPool(admin, parsed.data, auth.userId, body?.card_i18n ?? null)
  const pool = await getPool(admin, id)
  return NextResponse.json({ pool }, { status: 201 })
}
