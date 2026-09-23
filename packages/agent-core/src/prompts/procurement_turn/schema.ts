import { procurementTurnSchema as bare } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * `procurement_turn@v1` (S3.1) — the per-message router. NO reply field by design (the buyer only ever reads a
 * template). The only free text is `provider_question`, which never reaches anyone directly (provider_message@v1
 * drafts from the buyer's own words, the no-negotiation clamp checks the draft, the buyer confirms), so only the
 * contact + urls rules apply here.
 */
export const procurementTurnSchema = customerFacingText(bare, { fields: ['provider_question'], forbid: ['contact', 'urls'] })
export type { ProcurementTurn } from '@amclub/shared'
