import { supportTicketSummarySchema as bare } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/** `support_ticket_summary@v1` (S2.3) — ops-facing; the contact + urls rules keep a user's typed number out of the queue. */
export const supportTicketSummarySchema = customerFacingText(bare, { fields: ['summary'], forbid: ['contact', 'urls'] })
export type { SupportTicketSummary } from '@amclub/shared'
