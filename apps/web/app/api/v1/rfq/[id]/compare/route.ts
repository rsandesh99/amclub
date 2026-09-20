import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { resolveActor } from '@/lib/orders/actor'
import { enforce, limiters } from '@/lib/rate-limit'
import { RFQ_GOODS_LIST_COLS, isGoodsRow } from '@/lib/mart/staged-columns'
import { loadBuyerQuotes } from '@/lib/rfq/queries'
import { computeCompare, getComparePointers, toPointerLocale } from '@/lib/rfq/compare'
import { captureServerEvent } from '@/lib/analytics/server'

/**
 * GET /api/v1/rfq/[id]/compare?locale=xx (S1.2 §5) — the buyer's comparability
 * results (always; deterministic, no flag) plus pointers when the
 * compare_pointers agent is on for this buyer (cached per RFQ + locale; a
 * fresh bounded call otherwise, rate limited). Buyer must own the RFQ (404
 * otherwise). Flags never depend on any flag.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id: rfqId } = await params
  const admin = await createAdminClient()
  const actor = await resolveActor(admin, userId)
  if (!actor.msmeId) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  // Staged goods columns only through the fragment (empty while Mart is dark).
  const { data: rfq } = await admin.from('rfqs').select('id, msme_id' + RFQ_GOODS_LIST_COLS).eq('id', rfqId).eq('msme_id', actor.msmeId).maybeSingle()
  if (!rfq) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const kind: 'service' | 'goods' = isGoodsRow(rfq as { kind?: string | null }) ? 'goods' : 'service'
  const quotes = await loadBuyerQuotes(admin, rfqId)
  const results = computeCompare(kind, quotes)
  const locale = toPointerLocale(request.nextUrl.searchParams.get('locale'))

  // Pointers: a fresh model call only after the per-user limiter; cache hits are free.
  let allowModel = true
  const rl = await enforce(limiters.comparePointers, `compare-pointers:${userId}`)
  if (!rl.ok) allowModel = false
  const outcome = await getComparePointers(admin, { rfqId, kind, quotes, results, userId, locale, allowModel })
  if (!rl.ok && outcome.source === 'skipped') outcome.source = 'error'

  const flagsTotal = results.reduce((n, r) => n + r.flags.length, 0)
  captureServerEvent(userId, 'compare_viewed', { rfq_id: rfqId, quote_count: quotes.length, flags_total: flagsTotal, pointers: outcome.source === 'skipped' ? 'off' : outcome.source, role: 'msme' })

  return NextResponse.json(
    {
      results,
      pointers: outcome.pointers,
      pointers_source: outcome.source,
      ...(outcome.error ? { pointers_error: outcome.error } : !rl.ok && !outcome.pointers ? { pointers_error: 'rate_limited' } : {}),
      ...(outcome.dropped?.length ? { pointers_dropped: outcome.dropped } : {}),
    },
    { headers: NO_STORE },
  )
}
