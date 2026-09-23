import 'server-only'
import { SEARCH_RETENTION_DAYS, SHADOW_RETENTION_MONTHS, declaredVsActual } from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import { writeAudit } from '@/lib/audit/log'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/** Paid orders (captured and not refunded / cancelled) — the statuses F4 counts. */
const PAID_STATUSES = ['placed', 'accepted', 'requirements_submitted', 'in_progress', 'delivered', 'revision_requested', 'completed', 'reviewed', 'disputed', 'resolved_release', 'resolved_partial'] as const
export const DVA_WINDOW_DAYS = 180
export const DVA_REFLAG_DAYS = 30

/**
 * E15 nightly (cron/data-foundations):
 *  - retention: search_queries after 180 days, shadow_predictions after 24 months;
 *  - F4 declared vs actual: a provider whose paid orders (last 180 days, n ≥ 5)
 *    sit more than half outside their declared categories gets ONE audit flag
 *    (`category_mismatch_flagged`) for ops at /admin/verifications — at most
 *    once per 30 days. Admin-only; never the public profile; nothing changes
 *    for the provider.
 */
export async function runDataFoundations(admin: Admin): Promise<{ purgedSearches: number; purgedShadows: number; checked: number; flagged: number }> {
  const now = Date.now()
  const searchCutoff = new Date(now - SEARCH_RETENTION_DAYS * 86_400_000).toISOString()
  const shadowCutoff = new Date(new Date(now).setUTCMonth(new Date(now).getUTCMonth() - SHADOW_RETENTION_MONTHS)).toISOString()
  const { data: ps } = await admin.from('search_queries').delete().lt('created_at', searchCutoff).select('id')
  const { data: sh } = await admin.from('shadow_predictions').delete().lt('created_at', shadowCutoff).select('id')

  const since = new Date(now - DVA_WINDOW_DAYS * 86_400_000).toISOString()
  const { data: orders } = await admin
    .from('orders')
    .select('provider_id, package:packages(category_id), quote:quotes(rfq:rfqs(category_id))')
    .in('status', [...PAID_STATUSES])
    .gte('created_at', since)
    .limit(20000)
  const byProvider = new Map<string, string[]>()
  for (const o of (orders ?? []) as unknown as { provider_id: string; package: { category_id: string } | null; quote: { rfq: { category_id: string | null } | null } | null }[]) {
    const cat = o.package?.category_id ?? o.quote?.rfq?.category_id ?? null
    if (!cat) continue // goods orders carry no services category
    byProvider.set(o.provider_id, [...(byProvider.get(o.provider_id) ?? []), cat])
  }
  const candidates = [...byProvider.entries()].filter(([, cats]) => cats.length >= 5)
  let flagged = 0
  if (candidates.length) {
    const ids = candidates.map(([id]) => id)
    const [{ data: declared }, { data: recent }] = await Promise.all([
      admin.from('provider_categories').select('provider_id, category_id').in('provider_id', ids),
      admin.from('audit_logs').select('entity_id').eq('action', 'category_mismatch_flagged').in('entity_id', ids).gte('created_at', new Date(now - DVA_REFLAG_DAYS * 86_400_000).toISOString()),
    ])
    const declaredBy = new Map<string, string[]>()
    for (const d of declared ?? []) declaredBy.set(d.provider_id as string, [...(declaredBy.get(d.provider_id as string) ?? []), d.category_id as string])
    const already = new Set((recent ?? []).map((r) => r.entity_id as string))
    for (const [pid, cats] of candidates) {
      const r = declaredVsActual(declaredBy.get(pid) ?? [], cats)
      if (!r.flag || already.has(pid)) continue
      flagged++
      await writeAudit(admin, null, { actorId: null, action: 'category_mismatch_flagged', entity: 'provider_profiles', entityId: pid, after: { n: r.n, outside: r.outside, share: r.share, top_actual_category_id: r.topActual, window_days: DVA_WINDOW_DAYS } })
    }
  }
  return { purgedSearches: (ps ?? []).length, purgedShadows: (sh ?? []).length, checked: candidates.length, flagged }
}
