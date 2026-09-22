import { munshiDraftSchema as bare } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * `quote_draft@v1` (S2.2) — the bare contract is `munshiDraftSchema` in
 * @amclub/shared (strict; the clamp is `clampMunshiDraft`). The customer-facing
 * strings — the quote scope the buyer will read, the clarifying question, and
 * the rationale lines the provider reads — carry no contact details, no
 * off-platform payment instruction and no URL; a violation rejects the model
 * output and the run fails cleanly (no draft is stored, nothing is proposed).
 */
export const munshiDraftSchema = customerFacingText(bare, { fields: ['quote.scope', 'question', 'rationale[]'], forbid: ['contact', 'payment', 'urls'] })
export type { MunshiDraft } from '@amclub/shared'
