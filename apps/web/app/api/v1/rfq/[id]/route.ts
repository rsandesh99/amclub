import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireToolScope } from '@/lib/agent/scope'
import { getRfqForBuyer, getRfqForProvider } from '@/lib/rfq/queries'
import { createAdminClient } from '@/lib/supabase/server'
import { getBenchmarkFor } from '@/lib/benchmarks/view'

/** RFQ detail (mobile). Returns the buyer view if the caller owns the RFQ,
 *  else the provider view if they're matched. Cookie or Bearer. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // S2.2 — the Munshi detail read (extract_requirements with rfq_id); S3.1 — the procurement agent's read of the buyer's own
  // request (compare_quotes). A no-op for sessions and full-persona tokens.
  const scope = await requireToolScope(['extract_requirements', 'support_lookup', 'compare_quotes'])
  if (scope) return scope
  const { id } = await params

  // S3.2 — `benchmark` (the fair price range, the same row for both sides) is present ONLY when there is one to show;
  // with the display switch off the body is byte-identical to before
  const locale = request.headers.get('x-amc-locale') ?? request.headers.get('accept-language')?.slice(0, 2) ?? 'en'
  const buyer = await getRfqForBuyer(userId, id)
  if (buyer) {
    const benchmark = await getBenchmarkFor(await createAdminClient(), { rfqId: buyer.id, kind: buyer.kind, categorySlug: buyer.categorySlug, viewerUserId: userId, locale })
    return NextResponse.json({ role: 'buyer', rfq: buyer, ...(benchmark ? { benchmark } : {}) })
  }

  const provider = await getRfqForProvider(userId, id)
  if (provider) {
    const benchmark = await getBenchmarkFor(await createAdminClient(), { rfqId: provider.id, kind: provider.kind, categorySlug: provider.categorySlug, viewerUserId: userId, locale })
    return NextResponse.json({ role: 'provider', rfq: provider, ...(benchmark ? { benchmark } : {}) })
  }

  return NextResponse.json({ error: 'Not found' }, { status: 404 })
}
