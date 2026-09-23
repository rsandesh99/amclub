import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { quotePreview, quotePreviewRequestSchema } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { resolveActor } from '@/lib/orders/actor'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { isOnFor } from '@/lib/experiments'

/**
 * POST /api/v1/rfq/[id]/quote/preview (PRD Experience v3 E11 FR-11.4) — what
 * the buyer will see and what the provider will receive for a price + GST
 * mode, BEFORE submitting. Pure computation over the shared money rule
 * (`quotePreview` → `quoteChargeAmounts`, the same function checkout's quote
 * branch and the compare screen use; ADR-015 / ADR-017) at the RFQ
 * category's current commission. No write. Only a provider matched to the
 * RFQ may ask; rate-limited. 404 unless the `partner` experience is on.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isOnFor('partner', userId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const delegated = await requireNotDelegated('rfq/quote/preview')
  if (delegated) return delegated
  const rl = await enforce(limiters.quotePreview, `quote-preview:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const parsed = quotePreviewRequestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body', code: 'invalid_body' }, { status: 422 })

  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.providerId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const { data: match } = await admin.from('rfq_matches').select('rfq_id').eq('rfq_id', id).eq('provider_id', actor.providerId).maybeSingle()
  if (!match) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { data: rfq } = await admin.from('rfqs').select('category:categories(commission_bps)').eq('id', id).maybeSingle()
  const cat = rfq?.category as { commission_bps?: number } | { commission_bps?: number }[] | null | undefined
  const commissionBps = Number((Array.isArray(cat) ? cat[0]?.commission_bps : cat?.commission_bps) ?? 1000)
  return NextResponse.json(quotePreview({ pricePaise: parsed.data.price_paise, gstIncluded: parsed.data.gst_included, commissionBps }), { headers: { 'Cache-Control': 'private, no-store' } })
}
