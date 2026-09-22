import { disputeTriageSchema as bare } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * Output schema for `dispute_triage@v1` (schemaRef: disputeTriageSchema). The
 * contract lives in @amclub/shared (disputes.ts); strict at every level: no
 * amount, resolution or tool field. S2.1: ops-only card, opted in for contact
 * and URLs only (rationale, timeline text, claims); the server clamp
 * (`clampTriage`) runs after the model, never before.
 */
export const disputeTriageSchema = customerFacingText(bare, { fields: ['rationale[]', 'gaps[]', 'timeline[].what', 'claims[].claim'], forbid: ['contact', 'urls'] })
export {
  disputeClaimSchema,
  clampTriage,
  triageAllowedRefs,
  triageDeterministicChecks,
  stubTriage,
  type DisputeTriage,
  type DisputeClaim,
  type TriageCheck,
} from '@amclub/shared'
