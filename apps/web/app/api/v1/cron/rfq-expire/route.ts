import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { addQuoteEvents } from '@/lib/rfq/events'
import { getAgentSetting } from '@/lib/agent/settings'
import { quoteWindowLapsed } from '@amclub/shared'
import { notifyQuotesExpired, notifyQuoteWindowLapsed, notifyRfqExpired } from '@/lib/notifications/events'
import { createNotification } from '@/lib/notifications/create'
import { releaseDeferredRfq } from '@/lib/rfq/release'
import { getRfqQualityHoldMinutes } from '@/lib/agent/rfq-quality'
import { captureServerEvent } from '@/lib/analytics/server'
import { notifyText } from '@/lib/i18n/notify'

export const dynamic = 'force-dynamic'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/** `rfq.expire` (§5.9) — RFQs past their 72h window with no accepted quote → 'expired'.
 *  (Accepted RFQs are already 'accepted' and untouched.)
 *  Then: quotes still 'submitted' on any closed RFQ → 'expired' (+ quote_events),
 *  so silent expiry becomes a measurable, distinct outcome from active decisions.
 *  A later step that fails is counted in `stepErrors` and marks the run degraded (M35). */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  return runCronJob(admin, 'rfq-expire', () => expireRfqs(admin))
}

async function expireRfqs(admin: Admin) {
  const nowIso = new Date().toISOString()
  let stepErrors = 0

  const { data, error } = await admin
    .from('rfqs')
    .update({ status: 'expired', updated_at: nowIso })
    .in('status', ['open', 'quoted'])
    .lte('expires_at', nowIso)
    .select('id, title, msme_id')
  if (error) throw new Error(`rfq expiry: ${error.message}`)

  // Tell each buyer once: only the rows THIS run moved to 'expired' are in `data`
  // (a re-run finds them already expired and moves nothing), so no duplicates.
  let buyersExpiredNotified = 0
  for (const r of (data ?? []) as { id: string; title: string | null; msme_id: string }[]) {
    try {
      await notifyRfqExpired(admin, r)
      buyersExpiredNotified++
    } catch (e) {
      stepErrors++
      console.error('[cron/rfq-expire] notify buyer', r.id, e)
    }
  }

  // S1.5 — hold guard: DEFERRED RFQs (fanout_at NULL, still open) older than
  // agent_settings.rfq_quality_hold_minutes are released as is, through the ONE
  // release path (guarded, so a buyer answering at the same moment yields exactly
  // one fan-out). With the flag off there are no deferred rows: a no-op select.
  let qualityReleased = 0
  try {
    const holdMinutes = await getRfqQualityHoldMinutes(admin)
    const cutoff = new Date(Date.now() - holdMinutes * 60_000).toISOString()
    const { data: deferred, error: defErr } = await admin
      .from('rfqs')
      .select('id, msme:msme_profiles!inner(user_id)')
      .is('fanout_at', null)
      .eq('status', 'open')
      .lte('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(200)
    if (defErr) {
      stepErrors++
      console.error('[cron/rfq-expire] deferred lookup', defErr)
    }
    for (const row of (deferred ?? []) as unknown as { id: string; msme: { user_id: string } | null }[]) {
      const { released, matched } = await releaseDeferredRfq(admin, row.id, 'auto_released')
      if (!released) continue
      qualityReleased++
      const buyerUserId = row.msme?.user_id ?? null
      if (buyerUserId) {
        // In-app only: the buyer can still answer provider questions (S1.3 threads).
        await createNotification(admin, {
          userId: buyerUserId,
          kind: 'rfq_sent_as_is',
          titleI18n: notifyText('rfq_sent_as_is.title'),
          bodyI18n: notifyText('rfq_sent_as_is.body', { matched }),
          link: `/app/rfq/${row.id}`,
        })
        captureServerEvent(buyerUserId, 'rfq_quality_auto_released', { rfq_id: row.id, matched, hold_minutes: holdMinutes, role: 'msme' })
      }
    }
  } catch (e) {
    stepErrors++
    console.error('[cron/rfq-expire] quality hold guard', e)
  }

  // Sweep ALL closed RFQs (not only this run's) so quotes left 'submitted'
  // from before this writer existed are closed too. Idempotent: only rows
  // still 'submitted' move, and the event is written for exactly those.
  const { data: stale, error: staleErr } = await admin
    .from('quotes')
    .select('id, rfq_id, provider_id, rfq:rfqs!inner(id, status, title)')
    .eq('status', 'submitted')
    .in('rfq.status', ['expired', 'cancelled'])
    .limit(500)
  if (staleErr) {
    stepErrors++
    console.error('[cron/rfq-expire] stale quotes lookup', staleErr)
  }

  let quotesExpired = 0
  if (stale && stale.length > 0) {
    const rfqOf = new Map(stale.map((q) => [q.id, q.rfq_id]))
    const staleById = new Map((stale as unknown as { id: string; rfq_id: string; provider_id: string; rfq: { title: string | null } | null }[]).map((q) => [q.id, q]))
    const { data: moved, error: moveErr } = await admin
      .from('quotes')
      .update({ status: 'expired', updated_at: nowIso })
      .in('id', [...rfqOf.keys()])
      .eq('status', 'submitted')
      .select('id')
    if (moveErr) {
      stepErrors++
      console.error('[cron/rfq-expire] quote expiry', moveErr)
    }
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
    // Only the quotes this run actually moved (guarded on 'submitted') — each provider told once.
    try {
      await notifyQuotesExpired(
        admin,
        movedIds.flatMap((id) => {
          const q = staleById.get(id)
          return q ? [{ providerId: q.provider_id, rfqId: q.rfq_id, rfqTitle: q.rfq?.title ?? null }] : []
        }),
      )
    } catch (e) {
      stepErrors++
      console.error('[cron/rfq-expire] notify providers', e)
    }
  }

  // S0.4 quote-or-decline window: matches on still-open RFQs older than
  // agent_settings.quote_window_hours with NO quote and NO decline are
  // auto-declined (reason window_lapsed) and the buyer is told how many of
  // the matched providers could not take it up. Idempotent: guarded on
  // declined_at IS NULL; notification once per RFQ per sweep that lapses ≥1.
  let matchesLapsed = 0
  let buyersNotified = 0
  try {
    const configured = await getAgentSetting(admin, 'quote_window_hours')
    // Ships dark: null/unset => the sweep does nothing until the founder sets a window.
    const windowHours = typeof configured === 'number' ? configured : null
    const { data: open } = windowHours === null ? { data: [] } : await admin
      .from('rfq_matches')
      .select('rfq_id, provider_id, notified_at, rfq:rfqs!inner(id, title, msme_id, status)')
      .is('declined_at', null)
      .in('rfq.status', ['open', 'quoted'])
      .lte('notified_at', new Date(Date.now() - (windowHours ?? 0) * 3600 * 1000).toISOString())
      .limit(1000)
    interface OpenMatch { rfq_id: string; provider_id: string; notified_at: string; rfq: { id: string; title: string | null; msme_id: string; status: string } }
    const rows = (open ?? []) as unknown as OpenMatch[]
    const now = new Date()
    const candidates = windowHours === null ? [] : rows.filter((m) => quoteWindowLapsed(new Date(m.notified_at), windowHours, now))
    if (candidates.length > 0) {
      const rfqIds = [...new Set(candidates.map((m) => m.rfq_id))]
      const { data: quoted } = await admin.from('quotes').select('rfq_id, provider_id').in('rfq_id', rfqIds)
      const quotedRows = (quoted ?? []) as { rfq_id: string; provider_id: string }[]
      const quotedKey = new Set(quotedRows.map((q) => `${q.rfq_id}:${q.provider_id}`))
      const lapsedByRfq = new Map<string, { rfq: OpenMatch['rfq']; n: number }>()
      for (const m of candidates) {
        if (quotedKey.has(`${m.rfq_id}:${m.provider_id}`)) continue
        const { data: moved } = await admin
          .from('rfq_matches')
          .update({ declined_at: nowIso, decline_reason: 'window_lapsed' })
          .eq('rfq_id', m.rfq_id)
          .eq('provider_id', m.provider_id)
          .is('declined_at', null)
          .select('rfq_id')
        if (moved && moved.length > 0) {
          matchesLapsed++
          const cur = lapsedByRfq.get(m.rfq_id) ?? { rfq: m.rfq, n: 0 }
          cur.n++
          lapsedByRfq.set(m.rfq_id, cur)
        }
      }
      for (const [rfqId, { rfq }] of lapsedByRfq) {
        const { count: total } = await admin.from('rfq_matches').select('*', { count: 'exact', head: true }).eq('rfq_id', rfqId)
        const { count: unavailable } = await admin.from('rfq_matches').select('*', { count: 'exact', head: true }).eq('rfq_id', rfqId).not('declined_at', 'is', null)
        await notifyQuoteWindowLapsed(admin, rfq, { unavailable: unavailable ?? 0, total: total ?? 0 })
        buyersNotified++
      }
    }
  } catch (e) {
    stepErrors++
    console.error('[cron/rfq-expire] quote-window sweep', e)
  }

  return { expired: data?.length ?? 0, buyersExpiredNotified, quotesExpired, matchesLapsed, buyersNotified, qualityReleased, stepErrors }
}
