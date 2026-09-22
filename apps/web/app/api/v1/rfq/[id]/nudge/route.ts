import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireToolScope } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { nudgeRfq } from '@/lib/support/nudge'

/**
 * POST /api/v1/rfq/[id]/nudge (S2.3 spine, no flag) — the buyer reminds every
 * matched, non-declined provider (bulk); a matched provider reminds the buyer.
 * Subject must be active (rfqIsActive); once per sender per cooldown (429).
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({ support_message_id: z.string().uuid().optional(), via: z.enum(['web', 'mobile', 'whatsapp', 'agent']).optional() }).strict()

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const scope = await requireToolScope('nudge_counterparty')
  if (scope) return scope
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const rl = await enforce(limiters.authed, `nudge:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const parsed = bodySchema.safeParse((await request.json().catch(() => ({}))) ?? {})
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  const r = await nudgeRfq(admin, id, { userId, actor: { msmeId: actor.msmeId, providerId: actor.providerId }, supportMessageId: parsed.data.support_message_id ?? null, via: parsed.data.via ?? 'web' })
  if (!r.ok) {
    const status = r.error === 'not_found' ? 404 : r.error === 'not_a_party' ? 403 : r.error === 'nudge_cooldown' ? 429 : 409
    return NextResponse.json({ error: r.error, ...(r.retryAfterSec ? { retry_after: r.retryAfterSec } : {}), ...(r.cooldownHours ? { cooldown_hours: r.cooldownHours } : {}) }, { status, ...(r.retryAfterSec ? { headers: { 'Retry-After': String(r.retryAfterSec) } } : {}) })
  }
  return NextResponse.json({ ok: true, nudge_id: r.nudgeId, recipients: r.recipients })
}
