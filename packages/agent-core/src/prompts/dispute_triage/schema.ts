/**
 * Output schema for `dispute_triage@v1` (schemaRef: disputeTriageSchema). The
 * contract lives in @amclub/shared (disputes.ts): the resolve route, the admin
 * console, the rig and the eval consume it. Strict at every level: no amount,
 * resolution or tool field can reach the card; the server clamp
 * (`clampTriage`) runs after the model, never before.
 */
export {
  disputeTriageSchema,
  disputeClaimSchema,
  clampTriage,
  triageAllowedRefs,
  triageDeterministicChecks,
  stubTriage,
  type DisputeTriage,
  type DisputeClaim,
  type TriageCheck,
} from '@amclub/shared'
