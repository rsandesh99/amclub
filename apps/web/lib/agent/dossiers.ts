import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DossierCheck, DossierRecommendation, PhotoFinding } from '@amclub/shared'
import { getGoodsDossier } from '@/lib/mart/release'
import { getServicesEvidence } from '@/lib/orders/evidence'
import { recordAiDecision } from '@/lib/mart/events'

/**
 * Payout dossier readers + the two decision writers (S1.4 §4d). The runtime
 * writes dossiers; the founder decides here — approve ONLY through the release
 * route (closeDossierApprove is called by it after the payout is rescheduled),
 * hold through the agent-admin decision route. Both record ONE ai_decisions row
 * (feature payout_dossier, run_id + tool set) and write the dossier's decision
 * columns once (DB trigger + `IS NULL` guard). Nothing here moves money.
 */

const BUCKET = 'order-documents'
const SIGNED_TTL_SEC = 15 * 60

export interface DossierRow {
  id: string
  order_id: string
  payout_id: string | null
  run_id: string | null
  kind: 'service' | 'goods'
  checks: DossierCheck[]
  anomalies: string[]
  photo_findings: PhotoFinding[]
  recommendation: DossierRecommendation
  rationale: string[]
  model_cost_paise: number
  decision: 'approve' | 'hold' | null
  decision_note: string | null
  decided_by: string | null
  decided_at: string | null
  decision_id: string | null
  notified_at: string | null
  created_at: string
  updated_at: string
}

const COLS = 'id, order_id, payout_id, run_id, kind, checks, anomalies, photo_findings, recommendation, rationale, model_cost_paise, decision, decision_note, decided_by, decided_at, decision_id, notified_at, created_at, updated_at'

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowOf(d: any): DossierRow {
  return {
    ...d,
    checks: Array.isArray(d.checks) ? d.checks : [],
    anomalies: d.anomalies ?? [],
    photo_findings: Array.isArray(d.photo_findings) ? d.photo_findings : [],
    rationale: d.rationale ?? [],
    model_cost_paise: Number(d.model_cost_paise ?? 0),
  }
}

export async function getDossier(admin: SupabaseClient, id: string): Promise<DossierRow | null> {
  const { data } = await admin.from('payout_dossiers').select(COLS).eq('id', id).maybeSingle()
  return data ? rowOf(data) : null
}

/** Latest dossier for an order (the panel on /admin/orders/[id]). */
export async function getLatestDossierForOrder(admin: SupabaseClient, orderId: string): Promise<DossierRow | null> {
  const { data } = await admin.from('payout_dossiers').select(COLS).eq('order_id', orderId).order('created_at', { ascending: false }).limit(1).maybeSingle()
  return data ? rowOf(data) : null
}

/** Latest dossier per order for a set of orders (the payouts worklist). Errors → empty (table may predate 0031). */
export async function latestDossiersByOrder(admin: SupabaseClient, orderIds: string[]): Promise<Map<string, Pick<DossierRow, 'id' | 'recommendation' | 'decision' | 'created_at'>>> {
  const out = new Map<string, Pick<DossierRow, 'id' | 'recommendation' | 'decision' | 'created_at'>>()
  if (orderIds.length === 0) return out
  const { data, error } = await admin.from('payout_dossiers').select('id, order_id, recommendation, decision, created_at').in('order_id', orderIds).order('created_at', { ascending: false })
  if (error) {
    console.error('[dossiers] latestDossiersByOrder', error.message)
    return out
  }
  for (const d of (data ?? []) as any[]) if (!out.has(d.order_id)) out.set(d.order_id, { id: d.id, recommendation: d.recommendation, decision: d.decision, created_at: d.created_at })
  return out
}

export interface DossierSummary {
  dossier: DossierRow
  order: { id: string; order_number: string; title: string; status: string; provider_id: string } | null
  payout: { id: string; status: string; amount_paise: number; scheduled_for: string | null } | null
  provider: { id: string; display_name: string } | null
}

export async function listDossiers(
  admin: SupabaseClient,
  opts: { status: 'pending' | 'decided' | 'all'; orderId?: string | null; limit: number },
): Promise<DossierSummary[]> {
  let q = admin.from('payout_dossiers').select(COLS).order('created_at', { ascending: false }).limit(opts.limit)
  if (opts.status === 'pending') q = q.is('decision', null)
  if (opts.status === 'decided') q = q.not('decision', 'is', null)
  if (opts.orderId) q = q.eq('order_id', opts.orderId)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  const rows = ((data ?? []) as any[]).map(rowOf)
  return Promise.all(rows.map((d) => summarize(admin, d)))
}

async function summarize(admin: SupabaseClient, dossier: DossierRow): Promise<DossierSummary> {
  const [{ data: order }, { data: payout }] = await Promise.all([
    admin.from('orders').select('id, order_number, title, status, provider_id').eq('id', dossier.order_id).maybeSingle(),
    dossier.payout_id
      ? admin.from('payouts').select('id, status, amount_paise, scheduled_for').eq('id', dossier.payout_id).maybeSingle()
      : admin.from('payouts').select('id, status, amount_paise, scheduled_for').eq('order_id', dossier.order_id).maybeSingle(),
  ])
  const { data: provider } = order
    ? await admin.from('provider_profiles').select('id, display_name').eq('id', (order as any).provider_id).maybeSingle()
    : { data: null }
  return {
    dossier,
    order: (order as any) ?? null,
    payout: payout ? { ...(payout as any), amount_paise: Number((payout as any).amount_paise) } : null,
    provider: (provider as any) ?? null,
  }
}

export interface DossierPhoto {
  doc_id: string
  stage: string
  signed_url: string | null
  mime: string | null
  uploaded_at: string | null
  finding: PhotoFinding | null
}

export interface DossierDetail extends DossierSummary {
  /** The live release gate (goods / services). Approve is disabled while reasons are non-empty. */
  release_gate: { ok: boolean; reasons: string[] }
  photos: DossierPhoto[]
}

/** The panel payload: summary + live gate + photos with fresh signed URLs and their findings. */
export async function dossierDetail(admin: SupabaseClient, dossier: DossierRow): Promise<DossierDetail> {
  const summary = await summarize(admin, dossier)
  const { data: ord } = await admin.from('orders').select('*').eq('id', dossier.order_id).maybeSingle()
  const release_gate = ord ? await releaseGateFor(admin, ord) : { ok: false, reasons: ['order_missing'] }

  // Photo stage labels: services from milestones, goods from the dossier's evidence doc ids.
  const stages = new Map<string, string>()
  if (dossier.kind === 'goods') {
    const { data: docs } = await admin.from('order_documents').select('id, kind').eq('order_id', dossier.order_id).in('kind', ['dispatch_photo', 'delivery_photo'])
    for (const d of (docs ?? []) as any[]) stages.set(d.id, d.kind)
  } else {
    const { data: ms } = await admin.from('order_milestones').select('kind, photo_doc_id').eq('order_id', dossier.order_id).not('photo_doc_id', 'is', null)
    for (const m of (ms ?? []) as any[]) if (m.photo_doc_id) stages.set(m.photo_doc_id, m.kind)
  }
  const findingBy = new Map(dossier.photo_findings.map((f) => [f.doc_id, f]))
  const docIds = [...new Set([...stages.keys(), ...findingBy.keys()])]
  const { data: docs } = docIds.length ? await admin.from('order_documents').select('id, file_url, mime, created_at').in('id', docIds) : { data: [] }
  const photos: DossierPhoto[] = await Promise.all(
    ((docs ?? []) as any[]).map(async (d) => {
      const { data: signed } = await admin.storage.from(BUCKET).createSignedUrl(d.file_url, SIGNED_TTL_SEC)
      return {
        doc_id: d.id,
        stage: stages.get(d.id) ?? 'unknown',
        signed_url: signed?.signedUrl ?? null,
        mime: d.mime ?? null,
        uploaded_at: d.created_at ?? null,
        finding: findingBy.get(d.id) ?? null,
      }
    }),
  )
  return { ...summary, release_gate, photos }
}

/** The same gate the release route enforces — surfaced so the panel can disable Approve honestly. */
export async function releaseGateFor(admin: SupabaseClient, order: any): Promise<{ ok: boolean; reasons: string[] }> {
  if (order.kind === 'goods') {
    const g = await getGoodsDossier(admin, order)
    return { ok: g.gate.ok, reasons: [...g.gate.reasons] }
  }
  const ev = await getServicesEvidence(admin, order)
  return ev.enforced ? { ok: ev.gate.ok, reasons: [...ev.gate.reasons] } : { ok: true, reasons: [] }
}

// ── Decision writers ──────────────────────────────────────────────────────────

export type DecisionWrite = { ok: true; decisionId: string | null } | { ok: false; error: 'already_decided' | 'write_failed' }

async function writeDecision(
  admin: SupabaseClient,
  dossier: DossierRow,
  decision: 'approve' | 'hold',
  decidedBy: string,
  note: string | null,
): Promise<DecisionWrite> {
  if (dossier.decision) return { ok: false, error: 'already_decided' }
  const decisionId = await recordAiDecision(
    admin,
    decidedBy,
    {
      feature: 'payout_dossier',
      input_refs: { order_id: dossier.order_id, payout_id: dossier.payout_id, dossier_id: dossier.id },
      proposed: { recommendation: dossier.recommendation },
      final: { decision, note },
    },
    { runId: dossier.run_id, tool: 'recommend_payout_release' },
  )
  const { data, error } = await admin
    .from('payout_dossiers')
    .update({ decision, decision_note: note, decided_by: decidedBy, decided_at: new Date().toISOString(), decision_id: decisionId })
    .eq('id', dossier.id)
    .is('decision', null) // replay-safe: the trigger also refuses a second write
    .select('id')
  if (error) {
    console.error('[dossiers] writeDecision', error.message)
    return { ok: false, error: /written once/.test(error.message) ? 'already_decided' : 'write_failed' }
  }
  if (!data || (data as unknown[]).length === 0) return { ok: false, error: 'already_decided' }
  return { ok: true, decisionId }
}

/** Called by the release route AFTER the payout is rescheduled: closes the dossier as approve. */
export function closeDossierApprove(admin: SupabaseClient, dossier: DossierRow, decidedBy: string, note: string | null): Promise<DecisionWrite> {
  return writeDecision(admin, dossier, 'approve', decidedBy, note)
}

/** Hold: the payout simply stays held; the dossier records that a human looked. */
export function closeDossierHold(admin: SupabaseClient, dossier: DossierRow, decidedBy: string, note: string | null): Promise<DecisionWrite> {
  return writeDecision(admin, dossier, 'hold', decidedBy, note)
}

// ── Stats tile (/admin/agents) ────────────────────────────────────────────────

export interface DossierStats {
  pending: number
  decided: number
  approve_rate_pct: number | null
  /** Median minutes from order completion (dossier created) to the founder's decision, last 30 days. */
  median_completed_to_decision_min: number | null
}

export async function dossierStats(admin: SupabaseClient): Promise<DossierStats> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const [{ count: pending }, { data: decided }] = await Promise.all([
    admin.from('payout_dossiers').select('id', { count: 'exact', head: true }).is('decision', null),
    admin.from('payout_dossiers').select('decision, created_at, decided_at').not('decision', 'is', null).gte('decided_at', since).limit(1000),
  ])
  const rows = (decided ?? []) as Array<{ decision: string; created_at: string; decided_at: string }>
  const approves = rows.filter((r) => r.decision === 'approve').length
  const mins = rows
    .map((r) => (new Date(r.decided_at).getTime() - new Date(r.created_at).getTime()) / 60_000)
    .filter((m) => Number.isFinite(m) && m >= 0)
    .sort((a, b) => a - b)
  const median = mins.length ? mins[Math.floor((mins.length - 1) / 2)]! : null
  return {
    pending: pending ?? 0,
    decided: rows.length,
    approve_rate_pct: rows.length ? Math.round((approves / rows.length) * 100) : null,
    median_completed_to_decision_min: median == null ? null : Math.round(median),
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
