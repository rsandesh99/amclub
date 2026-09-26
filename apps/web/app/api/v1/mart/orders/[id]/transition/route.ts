import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { GOODS_ORDER_ACTIONS } from '@amclub/shared'
import { martApiGate } from '@/lib/mart/gate'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { resolveActor } from '@/lib/orders/actor'
import { applyGoodsTransition } from '@/lib/mart/goods-transitions'

const bodySchema = z.object({
  action: z.enum(GOODS_ORDER_ACTIONS),
  dispatch: z.unknown().optional(),
  deliver: z.unknown().optional(),
  return: z.unknown().optional(),
})

/** Goods order actions — see lib/mart/goods-transitions.ts for the action → §3.7 map. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = martApiGate()
  if (gate) return gate
  // Audit wave 3: no agent tool wraps this route, so a delegated agent token is refused.
  const delegated = await requireNotDelegated('POST /mart/orders/[id]/transition')
  if (delegated) return delegated
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  const result = await applyGoodsTransition(admin, id, parsed.data.action, actor, {
    ...(parsed.data.dispatch !== undefined ? { dispatch: parsed.data.dispatch } : {}),
    ...(parsed.data.deliver !== undefined ? { deliver: parsed.data.deliver } : {}),
    ...(parsed.data.return !== undefined ? { return: parsed.data.return } : {}),
  })
  // Audit M14 — 409 return_window_closed carries the deadline that passed.
  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.endsAt ? { endsAt: result.endsAt } : {}) }, { status: result.status ?? 400 })
  return NextResponse.json({ ok: true, status: (result.order as { status: string }).status })
}
