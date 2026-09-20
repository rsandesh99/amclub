import { z } from 'zod'
import { uuidSchema } from './schemas/index'
import { milestoneKindSchema } from './evidence'

/**
 * Payout dossier contract (BUILD_PROMPTS S1.4, ADR-002 note). The
 * Payout-Evidence agent assembles a dossier for a payout that was born HELD:
 * deterministic checks, vision findings per evidence photo, anomaly flags — and
 * a recommendation computed by RULES from those inputs. The model never decides
 * anything: its findings are inputs to recommendDossier, and the founder's tap
 * on the existing release route is the only thing that moves money.
 *
 * Pure + zero deps except zod, like the rest of @amclub/shared: the runtime
 * (agent), the web routes and the verify script all consume the same rule.
 */

// ── Checks ────────────────────────────────────────────────────────────────────

export const DOSSIER_CHECK_NAMES = [
  'milestones_complete',      // services: all MILESTONE_KINDS; goods: dispatched + delivered_photo + buyer_received
  'work_complete_photo',      // services: work_complete has a photo; goods: delivery photo exists
  'buyer_confirmed',          // completed_at set (buyer tap or 72h auto-accept)
  'amount_matches_accepted',  // captured == total AND provider_earning == payout.amount AND accepted total == order total
  'no_open_dispute',
  'payout_is_held',
  'provider_payout_ready',    // verified bank + Route linked account + active provider
  'photos_plausible',         // every vision finding passes the thresholds below
  'no_duplicate_photos',      // dHash: no near-duplicate of a DIFFERENT order by the same provider
  'timeline_consistent',      // milestone times monotonic, after created_at; completion after the last photo
] as const
export type DossierCheckName = (typeof DOSSIER_CHECK_NAMES)[number]
export const dossierCheckNameSchema = z.enum(DOSSIER_CHECK_NAMES)

export const dossierCheckSchema = z.object({
  name: dossierCheckNameSchema,
  ok: z.boolean(),
  /** Human-readable why (never PII; refs + numbers only). */
  detail: z.string().max(500).nullable().default(null),
})
export type DossierCheck = z.infer<typeof dossierCheckSchema>
export const dossierChecksSchema = z.array(dossierCheckSchema).max(DOSSIER_CHECK_NAMES.length)

// ── Photo findings (the vision model's output — findings, never a decision) ──

export const photoFindingSchema = z.object({
  /** The order_documents id the finding is about (the image label in the prompt). */
  doc_id: z.string().min(1).max(80),
  looks_like_work: z.boolean(),
  matches_stage: z.boolean(),
  is_screenshot_or_document: z.boolean(),
  concerns: z.array(z.string().max(200)).max(5).default([]),
  confidence: z.number().min(0).max(1),
})
export type PhotoFinding = z.infer<typeof photoFindingSchema>

export const photoPlausibilitySchema = z.object({
  findings: z.array(photoFindingSchema).max(24),
})
export type PhotoPlausibility = z.infer<typeof photoPlausibilitySchema>

/** A finding below this confidence never contributes to an approve. */
export const PHOTO_CONFIDENCE_MIN = 0.6

export type PhotoFindingFailure = 'not_work' | 'stage_mismatch' | 'screenshot_or_document' | 'low_confidence'

/** Why a finding fails the approve thresholds (empty = passes). */
export function photoFindingFailures(f: PhotoFinding): PhotoFindingFailure[] {
  const out: PhotoFindingFailure[] = []
  if (!f.looks_like_work) out.push('not_work')
  if (!f.matches_stage) out.push('stage_mismatch')
  if (f.is_screenshot_or_document) out.push('screenshot_or_document')
  if (f.confidence < PHOTO_CONFIDENCE_MIN) out.push('low_confidence')
  return out
}

export function photoFindingPasses(f: PhotoFinding): boolean {
  return photoFindingFailures(f).length === 0
}

// ── Anomalies ─────────────────────────────────────────────────────────────────
// Free-form strings, but every producer uses one of these shapes so the admin
// panel can translate them: 'amount_mismatch' | 'completion_before_evidence' |
// 'dispute_open' | 'duplicate_photo:<doc_id>~<prior_doc_id>'.

export const DOSSIER_ANOMALY_KINDS = ['amount_mismatch', 'completion_before_evidence', 'dispute_open', 'duplicate_photo'] as const
export type DossierAnomalyKind = (typeof DOSSIER_ANOMALY_KINDS)[number]

export function anomalyKind(anomaly: string): DossierAnomalyKind | 'unknown' {
  const head = anomaly.split(':')[0] ?? ''
  return (DOSSIER_ANOMALY_KINDS as readonly string[]).includes(head) ? (head as DossierAnomalyKind) : 'unknown'
}

export function duplicatePhotoAnomaly(docId: string, priorDocId: string): string {
  return `duplicate_photo:${docId}~${priorDocId}`
}

// ── Recommendation (deterministic) ────────────────────────────────────────────

export const DOSSIER_RECOMMENDATIONS = ['approve', 'hold'] as const
export type DossierRecommendation = (typeof DOSSIER_RECOMMENDATIONS)[number]
export const dossierRecommendationSchema = z.enum(DOSSIER_RECOMMENDATIONS)

export interface RecommendDossierInput {
  checks: readonly DossierCheck[]
  findings: readonly PhotoFinding[]
  anomalies: readonly string[]
}

export interface DossierRecommendationResult {
  recommendation: DossierRecommendation
  /** Every failing item, machine-readable: check:<name> | anomaly:<a> | photo:<doc_id>:<failure> | check_missing:<name>. */
  rationale: string[]
}

/**
 * approve ONLY when every named check is present and ok, there are no
 * anomalies, and every photo finding passes (looks_like_work && matches_stage
 * && !is_screenshot_or_document && confidence >= 0.6). Otherwise hold, with the
 * failing items as the rationale. The model output cannot flip this directly —
 * a finding is one input among many, and a missing check is a hold.
 */
export function recommendDossier(input: RecommendDossierInput): DossierRecommendationResult {
  const rationale: string[] = []
  const byName = new Map<string, DossierCheck>()
  for (const c of input.checks) byName.set(c.name, c)
  for (const name of DOSSIER_CHECK_NAMES) {
    const c = byName.get(name)
    if (!c) rationale.push(`check_missing:${name}`)
    else if (!c.ok) rationale.push(`check:${name}`)
  }
  for (const a of input.anomalies) rationale.push(`anomaly:${a}`)
  for (const f of input.findings) {
    for (const why of photoFindingFailures(f)) rationale.push(`photo:${f.doc_id}:${why}`)
  }
  return { recommendation: rationale.length === 0 ? 'approve' : 'hold', rationale }
}

// ── Founder decision inputs ───────────────────────────────────────────────────

/** POST /api/v1/agent/admin/dossiers/[id]/decision — the ONLY decision this route accepts is hold. */
export const dossierHoldDecisionSchema = z.object({
  decision: z.literal('hold'),
  note: z.string().trim().max(500).optional(),
})
export type DossierHoldDecisionInput = z.infer<typeof dossierHoldDecisionSchema>

/** POST /api/v1/admin/payouts/[id] body — release, optionally closing a dossier as 'approve'. */
export const payoutReleaseBodySchema = z.object({
  action: z.literal('retry'),
  dossier_id: uuidSchema.optional(),
  note: z.string().trim().max(500).optional(),
})
export type PayoutReleaseBody = z.infer<typeof payoutReleaseBodySchema>

// ── Evidence payload (GET /api/v1/admin/orders/[id]/evidence) ─────────────────
// The one read the agent performs. Defined here so the web route (producer),
// the runtime agent (consumer) and the verify fixtures share the contract.

const isoString = z.string().min(1)
const paise = z.coerce.number().int()

export const evidencePhotoSchema = z.object({
  doc_id: uuidSchema,
  signed_url: z.string().nullable(),
  mime: z.string(),
  uploaded_at: isoString,
})
export type EvidencePhoto = z.infer<typeof evidencePhotoSchema>

export const orderEvidenceSchema = z.object({
  order: z.object({
    id: uuidSchema,
    kind: z.enum(['service', 'goods']),
    status: z.string(),
    order_number: z.string(),
    category_slug: z.string().nullable(),
    title: z.string(),
    created_at: isoString,
    completed_at: z.string().nullable(),
    total_paise: paise,
    provider_earning_paise: paise,
    provider_id: uuidSchema,
    msme_id: uuidSchema,
  }),
  accepted: z
    .object({
      source: z.enum(['quote', 'package']).nullable(),
      price_paise: paise.nullable(),
      total_paise: paise.nullable(),
      commission_paise: paise.nullable(),
      provider_earning_paise: paise.nullable(),
    })
    .nullable(),
  payments: z.array(z.object({ id: uuidSchema, status: z.string(), amount_paise: paise, captured_at: z.string().nullable() })),
  payout: z.object({ id: uuidSchema, status: z.string(), amount_paise: paise, scheduled_for: z.string().nullable() }).nullable(),
  provider: z.object({
    id: uuidSchema,
    status: z.string(),
    bank_verified: z.boolean(),
    route_account_present: z.boolean(),
  }),
  disputes: z.array(z.object({ id: uuidSchema, status: z.string(), reason: z.string(), opened_at: isoString })),
  /** Services milestones; notes are returned VERBATIM (the agent envelopes them). */
  milestones: z.array(
    z.object({
      kind: milestoneKindSchema,
      note: z.string().nullable(),
      created_at: isoString,
      photo: evidencePhotoSchema.nullable(),
    }),
  ),
  /** Goods evidence (kind='goods' only). */
  goods_evidence: z
    .object({
      dispatched_at: z.string().nullable(),
      delivered_photo_at: z.string().nullable(),
      buyer_received_at: z.string().nullable(),
      auto_accepted_at: z.string().nullable(),
      return_opened_at: z.string().nullable(),
      return_resolved_at: z.string().nullable(),
      return_window_hours: z.number().int().min(0),
      gate: z.object({ ok: z.boolean(), reasons: z.array(z.string()) }),
      photos: z.array(evidencePhotoSchema.extend({ kind: z.string() })),
    })
    .nullable(),
  events: z.array(z.object({ event: z.string(), created_at: isoString, actor_role: z.enum(['msme', 'provider', 'admin', 'system', 'unknown']) })),
})
export type OrderEvidence = z.infer<typeof orderEvidenceSchema>
