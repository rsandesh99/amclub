import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { recordHeartbeat } from '@/lib/jobs/heartbeat'
import { addQuoteEvents } from '@/lib/rfq/events'

export const dynamic = 'force-dynamic'

/** `rfq.expire` (§5.9) — RFQs past their 72h window with no accepted quote → 'expired'.
 *  (Accepted RFQs are already 'accepted' and untouched.)
 *  Then: quotes still 'submitted' on any closed RFQ → 'expired' (+ quote_events),
 *  so silent expiry becomes a measurable, distinct outcome from active decisions. */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  const nowIso = new Date().toISOString()

  const { data, error } = await admin
    .from('rfqs')
    .update({ status: 'expired', updated_at: nowIso })
    .in('status', ['open', 'quoted'])
    .lte('expires_at', nowIso)
    .select('id')
  if (error) {
    console.error('[cron/rfq-expire]', error)
    return NextResponse.json({ error: 'failed' }, { status: 500 })
  }

  // Sweep ALL closed RFQs (not only this run's) so quotes left 'submitted'
  // from before this writer existed are closed too. Idempotent: only rows
  // still 'submitted' move, and the event is written for exactly those.
  const { data: stale, error: staleErr } = await admin
    .from('quotes')
    .select('id, rfq_id, rfq:rfqs!inner(id, status)')
    .eq('status', 'submitted')
    .in('rfq.status', ['expired', 'cancelled'])
    .limit(500)
  if (staleErr) console.error('[cron/rfq-expire] stale quotes lookup', staleErr)

  let quotesExpired = 0
  if (stale && stale.length > 0) {
    const rfqOf = new Map(stale.map((q) => [q.id, q.rfq_id]))
    const { data: moved, error: moveErr } = await admin
      .from('quotes')
      .update({ status: 'expired', updated_at: nowIso })
      .in('id', [...rfqOf.keys()])
      .eq('status', 'submitted')
      .select('id')
    if (moveErr) console.error('[cron/rfq-expire] quote expiry', moveErr)
    const movedIds = (moved ?? []).map((m) => m.id)
    await addQuoteEvents(
      admin,
      movedIds.map((id) => ({
        quoteId: id,
        eventType: 'expired' as const,
        reason: 'rfq_expired',
        payload: { rfq_id: rfqOf.get(id) ?? null },
      })),
    )
    quotesExpired = movedIds.length
  }

  const result = { expired: data?.length ?? 0, quotesExpired }
  await recordHeartbeat(admin, 'rfq-expire', result)
  return NextResponse.json(result)
}
