import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { canAddMilestone, milestoneSchema, nextMilestoneKind, MILESTONE_ORDER, type MilestoneKind } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { applyTransition } from '@/lib/orders/transitions'
import { notifyMilestone } from '@/lib/notifications/events'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { serverError } from '@/lib/api/errors'

/**
 * Services evidence engine (S0.3). POST adds the next milestone (provider only;
 * ordered machine; photo required for site_or_materials/in_progress/work_complete);
 * on work_complete it also runs the existing `deliver` transition so the 72h
 * auto-accept arms unchanged. GET returns the timeline. Buyer confirmation stays
 * the existing `accept_delivery` (delivered → completed) — no new transition.
 */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

async function loadServiceOrder(admin: Awaited<ReturnType<typeof createAdminClient>>, id: string) {
  const { data } = await admin.from('orders').select('*').eq('id', id).maybeSingle()
  return data as Record<string, unknown> | null
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { supabase, userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  // RLS (parties read) returns milestones only for an order the caller is party to.
  const { data, error } = await supabase
    .from('order_milestones')
    .select('id, kind, note, photo_doc_id, created_at, sort')
    .eq('order_id', id)
    .not('kind', 'is', null)
    .order('sort', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const kinds = (data ?? []).map((m) => m.kind as MilestoneKind)
  return NextResponse.json({ milestones: data ?? [], next: nextMilestoneKind(kinds) }, { headers: NO_STORE })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const rl = await enforce(limiters.authed, `milestone:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const admin = await createAdminClient()
  const order = await loadServiceOrder(admin, id)
  if (!order) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (order['kind'] === 'goods') return NextResponse.json({ error: 'Goods orders use the Mart order actions' }, { status: 409 })

  const actor = await resolveActor(admin, userId)
  if (!actor.providerId || order['provider_id'] !== actor.providerId) {
    return NextResponse.json({ error: 'Only the assigned provider can add milestones' }, { status: 403 })
  }

  const parsed = milestoneSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const { kind, note, photo_doc_id } = parsed.data

  // Verify the photo doc belongs to THIS order (never attach another order's doc).
  if (photo_doc_id) {
    const { data: doc } = await admin.from('order_documents').select('id').eq('id', photo_doc_id).eq('order_id', id).maybeSingle()
    if (!doc) return NextResponse.json({ error: 'photo_doc_id not found on this order' }, { status: 422 })
  }

  const { data: existingRows } = await admin.from('order_milestones').select('kind').eq('order_id', id).not('kind', 'is', null)
  const existing = (existingRows ?? []).map((r) => r.kind as MilestoneKind)
  const gate = canAddMilestone(existing, kind, String(order['status']))
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: 409 })

  const now = new Date().toISOString()
  const { data: inserted, error: insErr } = await admin
    .from('order_milestones')
    .insert({
      order_id: id,
      title: kind,
      kind,
      status: 'completed',
      completed_at: now,
      sort: MILESTONE_ORDER[kind],
      photo_doc_id: photo_doc_id ?? null,
      note: note ?? null,
      created_by: userId,
    })
    .select('id, kind, note, photo_doc_id, created_at, sort')
    .single()
  if (insErr) return serverError('[milestones POST]', insErr)

  await admin.from('order_events').insert({ order_id: id, actor_id: userId, event: 'milestone_added', payload: { kind, photo_doc_id: photo_doc_id ?? null } })
  await notifyMilestone(admin, order, kind)

  // work_complete delivers the order (arms the 72h auto-accept) via the canonical transition.
  let delivered = false
  if (kind === 'work_complete') {
    const res = await applyTransition(admin, id, 'deliver', actor)
    delivered = res.ok
    if (!res.ok) {
      // The evidence is recorded; surface why the auto-deliver didn't fire.
      return NextResponse.json({ milestone: inserted, delivered: false, deliver_error: res.error }, { status: 200, headers: NO_STORE })
    }
  }

  const kinds = [...existing, kind]
  return NextResponse.json({ milestone: inserted, next: nextMilestoneKind(kinds), delivered }, { status: 201, headers: NO_STORE })
}
