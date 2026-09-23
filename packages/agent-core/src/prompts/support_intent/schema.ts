import { supportIntentSchema as bare } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * `support_intent@v1` (S2.3) — the classifier's output has NO reply field by
 * design; the only free text is `ops_summary`, read by a human on the ticket
 * queue, so the contact + urls rules apply (a phone number the user typed
 * must not ride into the summary; the masked transcript is on the ticket).
 */
export const supportIntentSchema = customerFacingText(bare, { fields: ['ops_summary'], forbid: ['contact', 'urls'] })
export type { SupportIntentOutput } from '@amclub/shared'
