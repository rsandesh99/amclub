import { threadReplyDraftSchema as bare } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * `thread_reply@v1` (S2.2) — the reply body the buyer will read: no contact
 * details, no off-platform payment instruction, no URL. A violation rejects
 * the model output and the follow-up job records no draft.
 */
export const threadReplyDraftSchema = customerFacingText(bare, { fields: ['body'], forbid: ['contact', 'payment', 'urls'] })
export type { ThreadReplyDraft } from '@amclub/shared'
