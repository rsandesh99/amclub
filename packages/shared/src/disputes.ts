import { z } from 'zod'
import { uuidSchema } from './schemas/index'
import type { OrderEvidence } from './dossier'

/**
 * Dispute-Triage contract (BUILD_PROMPTS S1.7). Two halves:
 *
 *  1. PARTY STATEMENTS (spine, not agent): one statement per party on an open
 *     dispute, contact-masked, editable until a triage exists.
 *  2. THE TRIAGE CARD (agent, recommendation only): a neutral timeline, each
 *     party's claims with the evidence refs that support or contradict them,
 *     the gaps, and a recommended resolution CLASS with rationale. STRICT
 *     schema: no amount, no resolution, no tool fields — the founder's click
 *     on the existing resolve route is the decision; partial refunds are a
 *     percent band, never a paise figure the founder could paste.
 *
 * Deterministic checks and the clamp are code (tested here); the model only
 * fills the card. Zero deps except zod, like the rest of @amclub/shared.
 */

// ── Party statements ──────────────────────────────────────────────────────────

export const DISPUTE_STATEMENT_MAX = 2000
export const DISPUTE_STATEMENT_MIN = 20
export const DISPUTE_STATEMENT_MAX_DOCS = 5

export const disputeStatementSchema = z.object({
  body: z.string().trim().min(DISPUTE_STATEMENT_MIN).max(DISPUTE_STATEMENT_MAX),
  document_ids: z.array(uuidSchema).max(DISPUTE_STATEMENT_MAX_DOCS).default([]),
})
export type DisputeStatementInput = z.infer<typeof disputeStatementSchema>

export const DISPUTE_PARTIES = ['buyer', 'provider'] as const
export type DisputeParty = (typeof DISPUTE_PARTIES)[number]

/** What the routes return (and the agent envelopes): the REDACTED body only. */
export interface DisputeStatementView {
  id: string
  role: DisputeParty
  body: string
  redacted: boolean
  document_ids: string[]
  created_at: string
  updated_at: string
}

// ── The triage card (model output; strict) ────────────────────────────────────

export const DISPUTE_TRIAGE_RECOMMENDATIONS = ['refund_full', 'refund_partial', 'release', 'needs_more_info'] as const
export type DisputeTriageRecommendation = (typeof DISPUTE_TRIAGE_RECOMMENDATIONS)[number]

export const TRIAGE_PARTIAL_BANDS = ['10_30', '30_50', '50_70', '70_90'] as const
export type TriagePartialBand = (typeof TRIAGE_PARTIAL_BANDS)[number]

const isoString = z.string().min(10)

/**
 * Evidence refs — REFS ONLY, never content: `event:<id>` | `milestone:<kind>` |
 * `doc:<id>` | `statement:<id>` | `message:<id>`. The runtime passes the allowed
 * list as a trusted part and `clampTriage` drops anything outside it.
 */
export const TRIAGE_REF_RE = /^(event|milestone|doc|statement|message):[A-Za-z0-9_-]{1,80}$/

export const disputeEvidenceRefSchema = z.object({
  ref: z.string().max(120),
  supports: z.enum(['supports', 'contradicts', 'neutral']),
}).strict()

export const disputeClaimSchema = z
  .object({
    party: z.enum(DISPUTE_PARTIES),
    claim: z.string().max(240),
    evidence: z.array(disputeEvidenceRefSchema).max(6),
    assessment: z.enum(['supported', 'contradicted', 'unverifiable']),
  })
  .strict()
export type DisputeClaim = z.infer<typeof disputeClaimSchema>

export const disputeTriageSchema = z
  .object({
    timeline: z.array(z.object({ at: isoString, what: z.string().max(160), ref: z.string().max(120) }).strict()).max(20),
    claims: z.array(disputeClaimSchema).max(10),
    /** What evidence would settle it. */
    gaps: z.array(z.string().max(200)).max(6),
    recommendation: z.enum(DISPUTE_TRIAGE_RECOMMENDATIONS),
    /** Only with refund_partial; the BUYER's refund share as a percent band. Never paise. */
    partial_band: z.enum(TRIAGE_PARTIAL_BANDS).nullable(),
    rationale: z.array(z.string().max(240)).min(1).max(5),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict() // no amount fields, no 'resolve' fields, no tool fields
export type DisputeTriage = z.infer<typeof disputeTriageSchema>

// ── Deterministic checks (code, tested) ───────────────────────────────────────

export const TRIAGE_CHECK_NAMES = [
  'statement_missing_buyer',
  'statement_missing_provider',
  'no_work_complete_photo',
  'delivered_before_dispute',
  'dispute_after_auto_accept',
  'payout_already_paid',
  'refund_already_exists',
  'goods_return_window_expired',
  'duplicate_photo_flag',
] as const
export type TriageCheckName = (typeof TRIAGE_CHECK_NAMES)[number]

/** `ok: true` = nothing to worry about on this axis (the healthy reading). */
export interface TriageCheck {
  name: TriageCheckName
  ok: boolean
  detail: string | null
}

export interface TriageCheckExtras {
  /** The dispute detail carries the refund row; the evidence payload does not. */
  refundExists?: boolean
  /** S1.4 near-duplicate photo anomalies for this order (from the latest dossier), if any. */
  duplicatePhotos?: number
  /** disputes.created_at (opened) — falls back to evidence.disputes[0].opened_at. */
  disputeOpenedAt?: string | null
}

const t = (s: string | null | undefined): number | null => {
  if (!s) return null
  const n = new Date(s).getTime()
  return Number.isFinite(n) ? n : null
}

export function triageDeterministicChecks(
  evidence: OrderEvidence,
  statements: Pick<DisputeStatementView, 'role'>[],
  extras: TriageCheckExtras = {},
): TriageCheck[] {
  const openedAt = t(extras.disputeOpenedAt) ?? t(evidence.disputes[0]?.opened_at) ?? null
  const hasBuyer = statements.some((s) => s.role === 'buyer')
  const hasProvider = statements.some((s) => s.role === 'provider')
  const goods = evidence.order.kind === 'goods'
  const ge = evidence.goods_evidence

  const workComplete = goods
    ? !!ge?.photos.some((p) => p.kind === 'delivery_photo')
    : evidence.milestones.some((m) => m.kind === 'work_complete' && m.photo !== null)

  const deliveredAt = goods
    ? t(ge?.delivered_photo_at)
    : t(evidence.events.find((e) => e.event === 'deliver')?.created_at) ?? t(evidence.milestones.find((m) => m.kind === 'work_complete')?.created_at)
  const deliveredBefore = deliveredAt !== null && openedAt !== null && deliveredAt < openedAt

  const autoAcceptedAt = goods ? t(ge?.auto_accepted_at) : t(evidence.events.find((e) => e.event === 'auto_accepted')?.created_at)
  const afterAutoAccept = autoAcceptedAt !== null && openedAt !== null && autoAcceptedAt < openedAt

  const paid = evidence.payout?.status === 'paid'
  const refundExists = extras.refundExists === true

  let windowExpired = false
  if (goods && ge && openedAt !== null) {
    const base = t(ge.delivered_photo_at)
    if (base !== null && ge.return_window_hours > 0) windowExpired = openedAt > base + ge.return_window_hours * 3600 * 1000
  }
  const dups = extras.duplicatePhotos ?? 0

  return [
    { name: 'statement_missing_buyer', ok: hasBuyer, detail: hasBuyer ? null : 'the buyer has not stated their side' },
    { name: 'statement_missing_provider', ok: hasProvider, detail: hasProvider ? null : 'the provider has not stated their side' },
    { name: 'no_work_complete_photo', ok: workComplete, detail: workComplete ? null : goods ? 'no delivery photo on record' : 'no work_complete milestone photo on record' },
    { name: 'delivered_before_dispute', ok: deliveredBefore, detail: deliveredBefore ? null : deliveredAt === null ? 'no delivery on record before the dispute' : 'the dispute was opened before delivery' },
    { name: 'dispute_after_auto_accept', ok: !afterAutoAccept, detail: afterAutoAccept ? 'the dispute was opened after the 72 h auto-accept' : null },
    { name: 'payout_already_paid', ok: !paid, detail: paid ? 'the provider payout was already paid' : null },
    { name: 'refund_already_exists', ok: !refundExists, detail: refundExists ? 'a refund row already exists on this payment' : null },
    { name: 'goods_return_window_expired', ok: !windowExpired, detail: windowExpired ? 'the return was opened after the return window' : null },
    { name: 'duplicate_photo_flag', ok: dups === 0, detail: dups > 0 ? `${dups} evidence photo(s) reused from another order (S1.4 dossier)` : null },
  ]
}

export function triageCheck(checks: TriageCheck[], name: TriageCheckName): TriageCheck | undefined {
  return checks.find((c) => c.name === name)
}

// ── Allowed refs + the clamp ──────────────────────────────────────────────────

export interface TriageRefSources {
  eventIds: string[]
  milestoneKinds: string[]
  docIds: string[]
  statementIds: string[]
  messageIds: string[]
}

/** The ref allow-list the model may cite (trusted part) and the clamp enforces. */
export function triageAllowedRefs(src: TriageRefSources): string[] {
  const out = new Set<string>()
  for (const id of src.eventIds) out.add(`event:${id}`)
  for (const k of src.milestoneKinds) out.add(`milestone:${k}`)
  for (const id of src.docIds) out.add(`doc:${id}`)
  for (const id of src.statementIds) out.add(`statement:${id}`)
  for (const id of src.messageIds) out.add(`message:${id}`)
  return [...out]
}

/**
 * Server-side clamp over the validated card (code, never the model):
 *  - a missing party statement OR low confidence ⇒ `needs_more_info`;
 *  - `partial_band` only with `refund_partial` (defaults to 30_50 when the model forgot it);
 *  - every evidence ref and timeline ref must be in the allow-list (others are dropped);
 *  - a `payout_already_paid` / `refund_already_exists` check adds a rationale line so the founder sees it.
 */
export function clampTriage(triage: DisputeTriage, checks: TriageCheck[], allowedRefs: readonly string[]): DisputeTriage {
  const allowed = new Set(allowedRefs)
  const missing = checks.some((c) => (c.name === 'statement_missing_buyer' || c.name === 'statement_missing_provider') && !c.ok)
  let recommendation: DisputeTriageRecommendation = triage.recommendation
  const rationale = [...triage.rationale]
  if (missing && recommendation !== 'needs_more_info') {
    recommendation = 'needs_more_info'
    rationale.unshift('A party has not stated their side yet; the record is one-sided.')
  }
  if (triage.confidence === 'low' && recommendation !== 'needs_more_info') {
    recommendation = 'needs_more_info'
    rationale.unshift('Low confidence: the decisive evidence is absent or contradictory.')
  }
  // Money-state notes always survive the 5-line cap (the model's lines are trimmed first).
  const notes: string[] = []
  for (const name of ['payout_already_paid', 'refund_already_exists'] as const) {
    const c = triageCheck(checks, name)
    if (c && !c.ok && c.detail && !rationale.some((r) => r.includes(c.detail!))) notes.push(`Note: ${c.detail}.`)
  }
  const partial_band: TriagePartialBand | null = recommendation === 'refund_partial' ? (triage.partial_band ?? '30_50') : null
  const claims = triage.claims.map((cl) => ({ ...cl, evidence: cl.evidence.filter((e) => allowed.has(e.ref)) }))
  const timeline = triage.timeline.filter((e) => allowed.has(e.ref))
  const lines = [...rationale.slice(0, Math.max(1, 5 - notes.length)), ...notes].slice(0, 5)
  return { ...triage, recommendation, partial_band, rationale: lines, claims, timeline }
}

// ── Stub producer (keyless / CI; the flag-on rig) ─────────────────────────────

/**
 * A deterministic card from the checks alone: `needs_more_info` when a statement
 * is missing, else `release` when delivery + work-complete are on record, else
 * `refund_partial` in the 30_50 band. Shared so the eval, the runtime stub and
 * the rig agree byte-for-byte.
 */
export function stubTriage(checks: TriageCheck[], refs: { statementRefs: string[]; deliveryRef: string | null; openedAt: string }): DisputeTriage {
  const missing = checks.some((c) => (c.name === 'statement_missing_buyer' || c.name === 'statement_missing_provider') && !c.ok)
  const delivered = triageCheck(checks, 'delivered_before_dispute')?.ok === true
  const complete = triageCheck(checks, 'no_work_complete_photo')?.ok === true
  const recommendation: DisputeTriageRecommendation = missing ? 'needs_more_info' : delivered && complete ? 'release' : 'refund_partial'
  const claims: DisputeClaim[] = refs.statementRefs.map((ref, i) => ({
    party: i === 0 ? 'buyer' : 'provider',
    claim: i === 0 ? 'The buyer disputes the delivered work.' : 'The provider states the work was delivered as agreed.',
    evidence: [{ ref, supports: 'neutral' as const }, ...(refs.deliveryRef ? [{ ref: refs.deliveryRef, supports: (i === 0 ? 'contradicts' : 'supports') as 'contradicts' | 'supports' }] : [])],
    assessment: 'unverifiable' as const,
  }))
  return {
    timeline: refs.deliveryRef ? [{ at: refs.openedAt, what: 'Dispute opened', ref: refs.deliveryRef }] : [],
    claims,
    gaps: missing ? ['The missing party statement.'] : complete ? [] : ['A work-complete or delivery photo.'],
    recommendation,
    partial_band: recommendation === 'refund_partial' ? '30_50' : null,
    rationale: [missing ? 'One party has not stated their side.' : delivered && complete ? 'Delivery and completion are on the record before the dispute.' : 'Delivery is not fully evidenced; a partial refund shares the risk.'],
    confidence: missing ? 'low' : 'medium',
  }
}

/** Human-readable band → "30–50 % of the order total refunded to the buyer". */
export function partialBandLabel(band: TriagePartialBand): string {
  const [lo, hi] = band.split('_')
  return `${lo}–${hi} %`
}
