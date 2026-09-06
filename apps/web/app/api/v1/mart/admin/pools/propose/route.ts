import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { martApiGate } from '@/lib/mart/gate'
import { requireAdmin } from '@/lib/auth/admin'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { proposePools } from '@/lib/mart/group-buy-agent'
import { createDraftPool, getPool } from '@/lib/mart/pools'
import { recordAiDecision } from '@/lib/mart/events'

export const dynamic = 'force-dynamic'

/**
 * Group-Buy Agent v1: propose pools from demand signals + schedule. GET
 * previews; POST persists the proposals as DRAFTS (status 'draft' — nothing
 * opens without the founder's approval) and records each as an ai_decisions
 * 'pool_draft' row with proposed = final = the draft (corrections are recorded
 * again at approval, where the founder edits terms).
 */
export async function GET() {
  const gate = martApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const admin = await createAdminClient()
  const proposals = await proposePools(admin)
  return NextResponse.json({ proposals }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(_request: NextRequest) {
  const gate = martApiGate()
  if (gate) return gate
  const auth = await requireAdmin()
  if (auth.error) return auth.error
  const rl = await enforce(limiters.adminMutation, `admin:${auth.userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const admin = await createAdminClient()
  const proposals = await proposePools(admin)
  const created = []
  for (const p of proposals) {
    const { id } = await createDraftPool(admin, p.draft, auth.userId, p.card_i18n)
    await recordAiDecision(admin, auth.userId, {
      feature: 'pool_draft',
      input_refs: { pool_id: id, product_id: p.product.id, order_ids: (p.draft.rationale['order_ids'] as string[]) ?? [], agent: p.vendor, stub: p.stub },
      proposed: { ...p.draft, card_i18n: p.card_i18n },
      final: { ...p.draft, card_i18n: p.card_i18n },
    })
    created.push(await getPool(admin, id))
  }
  return NextResponse.json({ created }, { status: 201 })
}
