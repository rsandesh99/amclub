import { approvalIntentSchema as bare } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * `approval_intent@v1` (S2.2) — strict; `intent` is advisory: code approves
 * ONLY through `isUnambiguousYes` (the allow-list), never through this output.
 * `edit_instructions` is quoted back to the provider in a WhatsApp message, so
 * it carries no contact details, payment instructions or URLs.
 */
export const approvalIntentSchema = customerFacingText(bare, { fields: ['edit_instructions'], forbid: ['contact', 'payment', 'urls'] })
export type { ApprovalIntent } from '@amclub/shared'
