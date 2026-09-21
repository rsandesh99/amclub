import type { DisputeStatementView, OrderEvidence, TriageCheck } from '@amclub/shared'
import { envelope } from '../untrusted/envelope'
import type { ChatParts } from '../llm/gateway'

/**
 * Prompt parts for `dispute_triage@v1` (S1.7). TRUSTED = the platform's record:
 * order facts (amounts in paise, dates), the event timeline with ids + actor
 * roles, milestone kinds + timestamps (never the notes), payout/refund status,
 * the deterministic checks, the S1.4 photo-plausibility findings when a
 * dossier exists, and the ref ALLOW-LIST. UNTRUSTED = every party text as its
 * own Envelope: the dispute reason, each statement, each milestone note, each
 * pre-payment thread message. A unit test asserts no party string ever
 * appears in `trusted`.
 */

export interface TriageEvent {
  id: string
  event: string
  created_at: string
  actor_role: string
}
export interface TriageThreadMessage {
  id: string
  sender_role: 'buyer' | 'provider' | 'unknown'
  body: string
  created_at: string
}
export interface DisputeTriagePartsInput {
  disputeId: string
  disputeReason: string
  disputeOpenedAt: string
  evidence: OrderEvidence
  /** The dispute detail's events (with ids — the evidence payload's events have none). */
  events: TriageEvent[]
  statements: DisputeStatementView[]
  thread: TriageThreadMessage[]
  documents: { id: string; kind: string; created_at: string }[]
  refund: { status: string; amount_paise: number } | null
  checks: TriageCheck[]
  allowedRefs: string[]
  /** S1.4 dossier findings for this order, when one exists (trusted facts; photos are not sent). */
  photoFindings?: { doc_id: string; looks_like_work: boolean; matches_stage: boolean; is_screenshot_or_document: boolean; confidence: number }[]
}

export function buildDisputeTriageParts(input: DisputeTriagePartsInput): ChatParts {
  const o = input.evidence.order
  const trusted = [
    `order: kind=${o.kind}; status=${o.status}; created_at=${o.created_at}; completed_at=${o.completed_at ?? 'null'}; total_paise=${o.total_paise}; provider_earning_paise=${o.provider_earning_paise}; source=${input.evidence.accepted?.source ?? 'unknown'}`,
    `dispute: id=${input.disputeId}; opened_at=${input.disputeOpenedAt}`,
    `payments: ${input.evidence.payments.map((p) => `${p.status} ${p.amount_paise} at ${p.captured_at ?? 'null'}`).join('; ') || 'none'}`,
    `payout: ${input.evidence.payout ? `${input.evidence.payout.status} ${input.evidence.payout.amount_paise}` : 'none'}`,
    `refund: ${input.refund ? `${input.refund.status} ${input.refund.amount_paise}` : 'none'}`,
    `events: ${input.events.map((e) => `event:${e.id}=${e.event} by ${e.actor_role} at ${e.created_at}`).join('; ') || 'none'}`,
    `milestones: ${input.evidence.milestones.map((m) => `milestone:${m.kind} at ${m.created_at} photo=${m.photo ? `doc:${m.photo.doc_id}` : 'none'}`).join('; ') || 'none'}`,
    input.evidence.goods_evidence
      ? `goods_evidence: dispatched_at=${input.evidence.goods_evidence.dispatched_at ?? 'null'}; delivered_photo_at=${input.evidence.goods_evidence.delivered_photo_at ?? 'null'}; buyer_received_at=${input.evidence.goods_evidence.buyer_received_at ?? 'null'}; auto_accepted_at=${input.evidence.goods_evidence.auto_accepted_at ?? 'null'}; return_window_hours=${input.evidence.goods_evidence.return_window_hours}; photos=${input.evidence.goods_evidence.photos.map((p) => `doc:${p.doc_id}(${p.kind})`).join(',') || 'none'}`
      : 'goods_evidence: none',
    `documents: ${input.documents.map((d) => `doc:${d.id}(${d.kind}) at ${d.created_at}`).join('; ') || 'none'}`,
    `statements_on_record: ${input.statements.map((s) => `statement:${s.id} by ${s.role} at ${s.created_at}`).join('; ') || 'none'}`,
    `thread_messages_on_record: ${input.thread.map((m) => `message:${m.id} by ${m.sender_role} at ${m.created_at}`).join('; ') || 'none'}`,
    `checks: ${input.checks.map((c) => `${c.name}=${c.ok ? 'ok' : 'FAIL'}${c.detail ? ` (${c.detail})` : ''}`).join('; ')}`,
    input.photoFindings && input.photoFindings.length
      ? `photo_findings (S1.4 dossier): ${input.photoFindings.map((f) => `doc:${f.doc_id} work=${f.looks_like_work} stage=${f.matches_stage} screenshot=${f.is_screenshot_or_document} conf=${f.confidence}`).join('; ')}`
      : 'photo_findings: none (photos are not sent to this call)',
    `allowed_refs: ${input.allowedRefs.join(', ') || 'none'}`,
  ]
  const untrusted = [envelope(input.disputeReason, { kind: 'dispute_reason', id: input.disputeId })]
  for (const s of input.statements) untrusted.push(envelope(s.body, { kind: `dispute_statement_${s.role}`, id: s.id }))
  input.evidence.milestones.forEach((m, i) => {
    if (m.note && m.note.trim()) untrusted.push(envelope(m.note, { kind: 'milestone_note', id: `${m.kind}-${i}` }))
  })
  for (const m of input.thread) if (m.body.trim()) untrusted.push(envelope(m.body, { kind: `quote_message_${m.sender_role}`, id: m.id }))
  return { trusted, untrusted }
}
