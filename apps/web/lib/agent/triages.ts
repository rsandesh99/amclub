import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DisputeResolution, DisputeTriage, TriageCheck } from '@amclub/shared'
import { recordAiDecision } from '@/lib/mart/events'

/**
 * Dispute-triage readers + the ONE decision writer (S1.7). The runtime writes
 * triages; the founder decides through the EXISTING resolve route, which calls
 * closeTriage AFTER settlement when it was passed a triage_id: one ai_decisions
 * row (feature dispute_triage, run_id + tool summarize_dispute) and the
 * triage's decision columns written once (DB trigger + `IS NULL` guard).
 * Nothing here moves money; a failed decision write never fails the resolution.
 */

export const DISPUTE_TRIAGE_CAP = 3

export interface TriageRow {
  id: string
  dispute_id: string
  order_id: string
  run_id: string | null
  kind: 'service' | 'goods'
  checks: TriageCheck[]
  triage: DisputeTriage
  model_cost_paise: number
  stub: boolean
  decision: DisputeResolution | null
  decided_by: string | null
  decided_at: string | null
  decision_id: string | null
  notified_at: string | null
  created_at: string
  updated_at: string
}

const COLS = 'id, dispute_id, order_id, run_id, kind, checks, triage, model_cost_paise, stub, decision, decided_by, decided_at, decision_id, notified_at, created_at, updated_at'

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowOf(d: any): TriageRow {
  return { ...d, checks: Array.isArray(d.checks) ? d.checks : [], model_cost_paise: Number(d.model_cost_paise ?? 0), stub: d.stub === true }
}

export async function getTriage(admin: SupabaseClient, id: string): Promise<TriageRow | null> {
  const { data } = await admin.from('dispute_triages').select(COLS).eq('id', id).maybeSingle()
  return data ? rowOf(data) : null
}

/** The latest triage for a dispute (the console card). Errors → null (table may predate 0037). */
export async function getLatestTriageForDispute(admin: SupabaseClient, disputeId: string): Promise<TriageRow | null> {
  const { data, error } = await admin.from('dispute_triages').select(COLS).eq('dispute_id', disputeId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (error) {
    console.error('[triages] latest', error.message)
    return null
  }
  return data ? rowOf(data) : null
}

/** Every triage for a dispute, newest first (the console's history toggle). */
export async function triageHistory(admin: SupabaseClient, disputeId: string): Promise<TriageRow[]> {
  const { data, error } = await admin.from('dispute_triages').select(COLS).eq('dispute_id', disputeId).order('created_at', { ascending: false }).limit(DISPUTE_TRIAGE_CAP + 1)
  if (error) return []
  return ((data ?? []) as any[]).map(rowOf)
}

export async function countTriages(admin: SupabaseClient, disputeId: string): Promise<number> {
  const { count, error } = await admin.from('dispute_triages').select('id', { count: 'exact', head: true }).eq('dispute_id', disputeId)
  if (error) return 0
  return count ?? 0
}

export interface TriageSummary {
  triage: TriageRow
  dispute: { id: string; status: string; reason: string; resolution: string | null; created_at: string } | null
  order: { id: string; order_number: string; title: string; status: string; total_paise: number } | null
}

export async function listTriages(admin: SupabaseClient, opts: { status: 'pending' | 'decided' | 'all'; disputeId?: string | null; limit: number }): Promise<TriageSummary[]> {
  let q = admin.from('dispute_triages').select(COLS).order('created_at', { ascending: false }).limit(opts.limit)
  if (opts.status === 'pending') q = q.is('decision', null)
  if (opts.status === 'decided') q = q.not('decision', 'is', null)
  if (opts.disputeId) q = q.eq('dispute_id', opts.disputeId)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return Promise.all(((data ?? []) as any[]).map(rowOf).map((t) => summarize(admin, t)))
}

export async function summarize(admin: SupabaseClient, triage: TriageRow): Promise<TriageSummary> {
  const [{ data: dispute }, { data: order }] = await Promise.all([
    admin.from('disputes').select('id, status, reason, resolution, created_at').eq('id', triage.dispute_id).maybeSingle(),
    admin.from('orders').select('id, order_number, title, status, total_paise').eq('id', triage.order_id).maybeSingle(),
  ])
  return { triage, dispute: (dispute as any) ?? null, order: order ? { ...(order as any), total_paise: Number((order as any).total_paise) } : null }
}

/**
 * Link the founder's click to the triage: ONE ai_decisions row (feature
 * dispute_triage, run_id + tool summarize_dispute) and the triage's decision
 * columns written once. Called by the resolve route AFTER settlement; returns
 * the decision id or null when already decided / the write failed (logged).
 */
export async function closeTriage(
  admin: SupabaseClient,
  args: { triage: TriageRow; resolution: DisputeResolution; amountPaise: number | null; actorUserId: string },
): Promise<{ decisionId: string | null; already: boolean }> {
  const { triage } = args
  if (triage.decision) return { decisionId: triage.decision_id, already: true }
  const decisionId = await recordAiDecision(
    admin,
    args.actorUserId,
    {
      feature: 'dispute_triage',
      input_refs: { dispute_id: triage.dispute_id, triage_id: triage.id, order_id: triage.order_id },
      proposed: { recommendation: triage.triage.recommendation, partial_band: triage.triage.partial_band },
      final: { resolution: args.resolution, amount_paise: args.amountPaise },
    },
    { runId: triage.run_id, tool: 'summarize_dispute' },
  )
  if (!decisionId) return { decisionId: null, already: false }
  const { data, error } = await admin
    .from('dispute_triages')
    .update({ decision: args.resolution, decided_by: args.actorUserId, decided_at: new Date().toISOString(), decision_id: decisionId })
    .eq('id', triage.id)
    .is('decision', null)
    .select('id')
  if (error) console.error('[closeTriage]', error.message)
  return { decisionId, already: !data || (data as unknown[]).length === 0 }
}

export interface TriageStats {
  pending: number
  decided: number
  /** Founder resolution class === the recommended class, over decided triages (last 30 days). */
  agreement_rate_pct: number | null
  /** Share of triages that recommended needs_more_info (last 30 days). */
  needs_more_info_pct: number | null
}

export async function triageStats(admin: SupabaseClient): Promise<TriageStats> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const [{ count: pending }, { data: recent }] = await Promise.all([
    admin.from('dispute_triages').select('id', { count: 'exact', head: true }).is('decision', null),
    admin.from('dispute_triages').select('decision, triage').gte('created_at', since).limit(1000),
  ])
  const rows = (recent ?? []) as Array<{ decision: string | null; triage: { recommendation?: string } }>
  const decided = rows.filter((r) => r.decision)
  const agreed = decided.filter((r) => r.decision === r.triage?.recommendation).length
  const nmi = rows.filter((r) => r.triage?.recommendation === 'needs_more_info').length
  return {
    pending: pending ?? 0,
    decided: decided.length,
    agreement_rate_pct: decided.length ? Math.round((agreed / decided.length) * 100) : null,
    needs_more_info_pct: rows.length ? Math.round((nmi / rows.length) * 100) : null,
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
