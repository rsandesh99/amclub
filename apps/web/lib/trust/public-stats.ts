import 'server-only'
import { computeProviderPublicStats, publicStatsView, type PublicStatsRow, type PublicStatsView, type StatsMatchInput, type StatsOrderInput } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { getAgentSetting } from '@/lib/agent/settings'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * N9 nightly write (called from cron/provider-stats): recompute every active
 * provider's provider_public_stats row from orders, delivery events and RFQ
 * matches. Service role only; a missing table (migration 0049 not applied yet)
 * is reported, never thrown, so the existing response-time job still runs.
 */
export async function recomputePublicStats(admin: Admin, now: number = Date.now()): Promise<{ providers: number; written: number; skipped?: string }> {
  const since365 = new Date(now - 365 * 86400e3).toISOString()
  const since90 = new Date(now - 90 * 86400e3).toISOString()
  const { data: providers } = await admin.from('provider_profiles').select('id').eq('status', 'active').is('deleted_at', null)
  const ids = (providers ?? []).map((p) => p.id as string)
  if (ids.length === 0) return { providers: 0, written: 0 }

  const { data: orderRows } = await admin
    .from('orders')
    .select('id, provider_id, msme_id, status, due_at, created_at, kind')
    .in('provider_id', ids)
  const service = (orderRows ?? []).filter((o) => o.kind !== 'goods')
  const deliveredAt = new Map<string, string>()
  const recentIds = service.filter((o) => (o.created_at as string) >= since365).map((o) => o.id as string)
  for (let i = 0; i < recentIds.length; i += 500) {
    const { data: ev } = await admin.from('order_events').select('order_id, created_at').eq('event', 'deliver').in('order_id', recentIds.slice(i, i + 500))
    for (const e of ev ?? []) {
      const prev = deliveredAt.get(e.order_id as string)
      if (!prev || (e.created_at as string) < prev) deliveredAt.set(e.order_id as string, e.created_at as string)
    }
  }
  const orders: StatsOrderInput[] = service.map((o) => ({
    id: o.id as string, providerId: o.provider_id as string, msmeId: o.msme_id as string, status: o.status as string,
    dueAt: (o.due_at as string | null) ?? null, createdAt: o.created_at as string, firstDeliveredAt: deliveredAt.get(o.id as string) ?? null,
  }))

  const { data: matchRows } = await admin.from('rfq_matches').select('rfq_id, provider_id, notified_at, declined_at, decline_reason').in('provider_id', ids).gte('notified_at', since90)
  const rfqIds = [...new Set((matchRows ?? []).map((m) => m.rfq_id as string))]
  const quotedAt = new Map<string, string>()
  for (let i = 0; i < rfqIds.length; i += 500) {
    const { data: qs } = await admin.from('quotes').select('rfq_id, provider_id, created_at').in('rfq_id', rfqIds.slice(i, i + 500))
    for (const q of qs ?? []) quotedAt.set(`${q.provider_id}:${q.rfq_id}`, q.created_at as string)
  }
  const matches: StatsMatchInput[] = (matchRows ?? []).map((m) => ({
    providerId: m.provider_id as string, rfqId: m.rfq_id as string, notifiedAt: (m.notified_at as string | null) ?? null,
    declinedAt: (m.declined_at as string | null) ?? null, declineReason: (m.decline_reason as string | null) ?? null,
    quotedAt: quotedAt.get(`${m.provider_id}:${m.rfq_id}`) ?? null,
  }))

  let written = 0
  const rows = ids.map((id) => ({ provider_id: id, ...computeProviderPublicStats(id, orders, matches, now) }))
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await admin.from('provider_public_stats').upsert(rows.slice(i, i + 200), { onConflict: 'provider_id' })
    if (error) return { providers: ids.length, written, skipped: error.message }
    written += Math.min(200, rows.length - i)
  }
  return { providers: ids.length, written }
}

/** The gate settings, read once per request. */
export async function publicStatsSettings(admin: Admin): Promise<{ enabled: boolean; minN: number }> {
  const [enabled, minN] = await Promise.all([getAgentSetting(admin, 'public_stats_enabled'), getAgentSetting(admin, 'public_stats_min_n')])
  return { enabled: enabled === true, minN: Number(minN) || 10 }
}

/** Gated buyer views for these providers (null each when off, missing or below the gates). */
export async function publicStatsFor(admin: Admin, providerIds: string[]): Promise<Map<string, PublicStatsView | null>> {
  const out = new Map<string, PublicStatsView | null>()
  if (providerIds.length === 0) return out
  const settings = await publicStatsSettings(admin)
  if (!settings.enabled) return out
  const { data, error } = await admin.from('provider_public_stats').select('provider_id, completed_orders, on_time_pct, on_time_n, repeat_buyer_pct, repeat_n, response_rate_pct, response_n, computed_at').in('provider_id', providerIds)
  if (error) return out
  for (const r of data ?? []) {
    const row: PublicStatsRow = {
      completed_orders: Number(r.completed_orders), on_time_pct: r.on_time_pct == null ? null : Number(r.on_time_pct), on_time_n: Number(r.on_time_n),
      repeat_buyer_pct: r.repeat_buyer_pct == null ? null : Number(r.repeat_buyer_pct), repeat_n: Number(r.repeat_n),
      response_rate_pct: r.response_rate_pct == null ? null : Number(r.response_rate_pct), response_n: Number(r.response_n), computed_at: r.computed_at as string,
    }
    out.set(r.provider_id as string, publicStatsView(row, settings))
  }
  return out
}
