import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { resolveActor } from '@/lib/orders/actor'
import { serverError } from '@/lib/api/errors'
import { requireNotDelegated } from '@/lib/agent/scope'

/**
 * Toggle the "Pending Government Portal Processing" sub-state on an in-progress
 * order (LOCK 5, §3.7). This is a DISPLAY sub-state, NOT a status transition —
 * the order stays `in_progress`, so the canonical state machine and payout
 * logic are untouched (§8.4). Only the assigned provider may toggle it, and
 * only while in_progress.
 */
const bodySchema = z.object({ active: z.boolean() })

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Audit M8 — no agent tool wraps this write: a delegated token is refused.
  const delegated = await requireNotDelegated('POST /orders/[id]/external-wait')
  if (delegated) return delegated

  const { id } = await params
  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)

  const { data: order } = await admin
    .from('orders')
    .select('id, status, provider_id')
    .eq('id', id)
    .maybeSingle()
  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Provider-only, in-progress-only.
  if (!actor.providerId || order.provider_id !== actor.providerId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  if (order.status !== 'in_progress') {
    return NextResponse.json({ error: 'Order is not in progress' }, { status: 409 })
  }

  const { active } = parsed.data
  const { error } = await admin
    .from('orders')
    .update({ external_wait_since: active ? new Date().toISOString() : null })
    .eq('id', id)
  if (error) return serverError('[orders external-wait]', error)

  await admin.from('order_events').insert({
    order_id: id,
    actor_id: userId,
    event: active ? 'external_wait' : 'external_resume',
  })

  return NextResponse.json({ ok: true, externalWait: active })
}
