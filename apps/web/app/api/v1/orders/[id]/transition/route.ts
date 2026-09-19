import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireToolScope } from '@/lib/agent/scope'
import { resolveActor } from '@/lib/orders/actor'
import { applyTransition, type OrderAction } from '@/lib/orders/transitions'

const bodySchema = z.object({
  action: z.enum([
    'accept',
    'submit_requirements',
    'start',
    'deliver',
    'accept_delivery',
    'request_revision',
    'resume',
    'cancel',
    'raise_dispute',
  ]),
  revisionNote: z.string().max(1000).optional(),
  disputeReason: z.string().max(1000).optional(),
  requirementsData: z.record(z.string(), z.unknown()).optional(),
})

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Only the buyer 'draft_dispute' tool wraps this route (AGENT_TOOLS); no-op for sessions.
  const scope = await requireToolScope('draft_dispute')
  if (scope) return scope

  const { id } = await params
  const json = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)

  // Stash submitted requirements as an order_event payload via the extra channel.
  const extra: { revisionNote?: string; disputeReason?: string } = {}
  if (parsed.data.revisionNote) extra.revisionNote = parsed.data.revisionNote
  if (parsed.data.disputeReason) extra.disputeReason = parsed.data.disputeReason

  const result = await applyTransition(admin, id, parsed.data.action as OrderAction, actor, extra)

  if (parsed.data.action === 'submit_requirements' && result.ok && parsed.data.requirementsData) {
    await admin.from('order_events').insert({
      order_id: id,
      actor_id: userId,
      event: 'requirements_data',
      payload: parsed.data.requirementsData,
    })
  }

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status ?? 400 })
  }
  return NextResponse.json({ ok: true, status: (result.order as { status: string }).status })
}
