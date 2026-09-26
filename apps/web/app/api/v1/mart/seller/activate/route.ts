import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { martApiGate } from '@/lib/mart/gate'
import { requireNotDelegated } from '@/lib/agent/scope'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { getSellerCtx } from '@/lib/mart/seller'
import { activateGoodsSelling } from '@/lib/mart/activation'
import { writeAudit } from '@/lib/audit/log'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'

/**
 * Goods activation gate (MART_DESIGN.md §2/§4.1): flips sells_goods=true ONLY
 * when the provider is active and holds a VERIFIED (non-stub) GSTIN record.
 * 409 with the activation state otherwise — the UI explains the next step.
 */
export async function POST(request: NextRequest) {
  const gate = martApiGate()
  if (gate) return gate
  // Audit wave 3: no agent tool wraps this route, so a delegated agent token is refused.
  const delegated = await requireNotDelegated('POST /mart/seller/activate')
  if (delegated) return delegated
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const rl = await enforce(limiters.authed, `mart-activate:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const admin = await createAdminClient()
  const seller = await getSellerCtx(admin, userId)
  if (!seller) return NextResponse.json({ error: 'No provider profile' }, { status: 404 })
  const r = await activateGoodsSelling(admin, seller.id)
  if (!r.ok) return NextResponse.json({ error: 'activation_gate', activation: r.activation }, { status: r.status })
  await writeAudit(admin, request, {
    actorId: userId,
    action: 'mart_goods_activated',
    entity: 'provider_profiles',
    entityId: seller.id,
    before: { sells_goods: false },
    after: { sells_goods: true, gstin: r.activation.gstin },
  })
  return NextResponse.json({ activation: r.activation })
}
