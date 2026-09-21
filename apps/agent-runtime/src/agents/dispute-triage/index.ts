import {
  buildDisputeTriageParts,
  getPrompt,
  signRuntimeCredential,
  type AgentDefinition,
  type TriageEvent,
  type TriageThreadMessage,
} from '@amclub/agent-core'
import {
  clampTriage,
  disputeTriageSchema,
  orderEvidenceSchema,
  stubTriage,
  triageAllowedRefs,
  triageDeterministicChecks,
  type DisputeStatementView,
  type DisputeTriage,
  type DisputeTriageRecommendation,
} from '@amclub/shared'
import { admin } from '../../deps'
import { RUNTIME_ENV } from '../../env'

/**
 * Dispute-Triage agent (BUILD_PROMPTS S1.7). Persona ops; RECOMMENDATION ONLY.
 *
 *  1. read_order_evidence — the S1.4 read (GET /admin/orders/[id]/evidence).
 *  2. summarize_dispute — the dispute detail (GET /admin/disputes/[id]):
 *     statements, thread, documents, refund, payout. Both confirm:false GETs
 *     under the founder's delegated ops token; NO other tool is proposed and
 *     the resolve route is not wired (and refuses delegated tokens).
 *  3. triageDeterministicChecks (shared; code).
 *  4. ONE frontier call (dispute_triage@v1): order facts trusted, every party
 *     text as an Envelope; photos are NOT sent (S1.4 findings pass as facts).
 *  5. clampTriage → dispute_triages row (service role; agent-owned) →
 *     disputes.triage_id → POST …/triages/[id]/notify with the runtime credential.
 *
 * The card never moves money and never pre-selects a resolution; the founder's
 * click on the existing resolve route is the decision.
 */

export interface DisputeTriageInput {
  disputeId: string
  orderId: string
}
export interface DisputeTriageOutput {
  triageId: string
  recommendation: DisputeTriageRecommendation
  costPaise: number
}

export const DISPUTE_TRIAGE_CAP = 3

/* eslint-disable @typescript-eslint/no-explicit-any */
interface DisputeDetail {
  dispute: { id: string; status: string; reason: string; created_at: string; order_id: string }
  order: { id: string; kind: string; source: string | null }
  events: { id: string; event: string; created_at: string; actor_id: string | null; actor_role?: string }[]
  payment: { id: string } | null
  payout: { id: string; status: string } | null
  refund: { id: string; status: string; amount_paise: number } | null
  documents: { id: string; kind: string; created_at: string }[]
  statements?: DisputeStatementView[]
  thread?: TriageThreadMessage[]
}

const stubMode = () => !(process.env['AGENT_LLM_API_KEY'] || process.env['OPENROUTER_API_KEY']) || process.env['AGENT_LLM_STUB'] === '1'

export const disputeTriageAgent: AgentDefinition<DisputeTriageInput, DisputeTriageOutput> = {
  name: 'dispute_triage',
  persona: 'ops',
  async run(run, input) {
    // Re-triage cap: at most three rows per dispute (terminal; the worker never retries).
    const { count } = await admin().from('dispute_triages').select('id', { count: 'exact', head: true }).eq('dispute_id', input.disputeId)
    if ((count ?? 0) >= DISPUTE_TRIAGE_CAP) throw new Error('triage_cap')

    // 1. Evidence (S1.4 read).
    const ev = await run.proposeTool('read_order_evidence', { order_id: input.orderId })
    if (ev.status !== 'done') throw new Error('unexpected_park')
    if (!ev.result.ok) throw new Error(`evidence_read_failed:${ev.result.status}`)
    const evidence = orderEvidenceSchema.parse(ev.result.body)

    // 2. Dispute detail (statements, thread, documents, refund).
    const dd = await run.proposeTool('summarize_dispute', { dispute_id: input.disputeId })
    if (dd.status !== 'done') throw new Error('unexpected_park')
    if (dd.result.status === 404) throw new Error('dispute_not_found')
    if (!dd.result.ok) throw new Error(`dispute_read_failed:${dd.result.status}`)
    const detail = dd.result.body as DisputeDetail
    if (detail.dispute.status === 'resolved') throw new Error('dispute_resolved')
    const statements = detail.statements ?? []
    const thread = detail.thread ?? []

    // 3. Deterministic checks (+ S1.4 dossier facts when a dossier exists for the order).
    const { data: dossier } = await admin().from('payout_dossiers').select('anomalies, photo_findings').eq('order_id', input.orderId).order('created_at', { ascending: false }).limit(1).maybeSingle()
    const anomalies = ((dossier as any)?.anomalies ?? []) as string[]
    const duplicatePhotos = anomalies.filter((a) => a.startsWith('duplicate_photo:')).length
    const photoFindings = (((dossier as any)?.photo_findings ?? []) as any[]).map((f) => ({ doc_id: String(f.doc_id), looks_like_work: !!f.looks_like_work, matches_stage: !!f.matches_stage, is_screenshot_or_document: !!f.is_screenshot_or_document, confidence: Number(f.confidence ?? 0) }))
    const checks = triageDeterministicChecks(evidence, statements, { refundExists: !!detail.refund, duplicatePhotos, disputeOpenedAt: detail.dispute.created_at })

    // Refs the model may cite (trusted allow-list) — ids from the dispute detail; kinds from the evidence.
    const events: TriageEvent[] = detail.events.map((e) => ({ id: e.id, event: e.event, created_at: e.created_at, actor_role: e.actor_role ?? 'unknown' }))
    const allowedRefs = triageAllowedRefs({
      eventIds: events.map((e) => e.id),
      milestoneKinds: evidence.milestones.map((m) => m.kind),
      docIds: detail.documents.map((d) => d.id),
      statementIds: statements.map((s) => s.id),
      messageIds: thread.map((m) => m.id),
    })
    const parts = buildDisputeTriageParts({
      disputeId: input.disputeId,
      disputeReason: detail.dispute.reason,
      disputeOpenedAt: detail.dispute.created_at,
      evidence,
      events,
      statements,
      thread,
      documents: detail.documents,
      refund: detail.refund ? { status: detail.refund.status, amount_paise: Number(detail.refund.amount_paise) } : null,
      checks,
      allowedRefs,
      photoFindings,
    })

    // 4. ONE frontier call. The stub is the shared deterministic card (rig-meaningful without a key).
    const prompt = getPrompt('dispute_triage', 'v1')
    const deliveryEvent = events.find((e) => e.event === 'deliver' || e.event === 'delivered_photo')
    const out = await run.callModel({
      taskClass: prompt.taskClass,
      prompt,
      schema: disputeTriageSchema,
      parts,
      temperature: 0,
      feature: 'dispute_triage',
      stub: () => stubTriage(checks, { statementRefs: statements.map((s) => `statement:${s.id}`), deliveryRef: deliveryEvent ? `event:${deliveryEvent.id}` : null, openedAt: detail.dispute.created_at }),
    })
    const triage: DisputeTriage = clampTriage(out, checks, allowedRefs)

    // 5. Persist (agent-owned), point the dispute at the latest triage, notify once.
    const { data: runRow } = await admin().from('agent_runs').select('cost_est_paise').eq('id', run.runId).maybeSingle()
    const costPaise = Number((runRow as { cost_est_paise?: unknown } | null)?.cost_est_paise ?? 0)
    const { data: inserted, error } = await admin()
      .from('dispute_triages')
      .insert({ dispute_id: input.disputeId, order_id: input.orderId, run_id: run.runId, kind: evidence.order.kind, checks, triage, model_cost_paise: costPaise, stub: stubMode() })
      .select('id')
      .single()
    if (error || !inserted) throw new Error(`triage_write_failed:${error?.message ?? 'no row'}`)
    const triageId = (inserted as { id: string }).id
    await admin().from('disputes').update({ triage_id: triageId, updated_at: new Date().toISOString() }).eq('id', input.disputeId)

    try {
      const cred = signRuntimeCredential(RUNTIME_ENV.RUNTIME_SECRET, { userId: run.userId, persona: run.persona, runId: run.runId })
      const res = await fetch(`${RUNTIME_ENV.API_URL}/api/v1/agent/admin/triages/${triageId}/notify`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `AMC-Runtime ${cred}` }, body: '{}' })
      if (!res.ok) console.warn('[dispute_triage] notify ->', res.status)
      await res.text().catch(() => '')
    } catch (e) {
      console.warn('[dispute_triage] notify failed', (e as Error).message)
    }

    return { triageId, recommendation: triage.recommendation, costPaise }
  },
}
/* eslint-enable @typescript-eslint/no-explicit-any */
