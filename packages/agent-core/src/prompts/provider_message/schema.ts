import { providerMessageDraftSchema as bare } from '@amclub/shared'
import { customerFacingText } from '../../untrusted/output'

/**
 * `provider_message@v1` (S3.1) — the buyer's question to one provider. Provider-facing, so contact / off-platform
 * payment / approval / urls apply at parse; the no-negotiation rule is `clampProviderMessage` (shared), run by code on
 * every draft before anything is proposed — a price, a percentage or counter-offer phrasing is never proposed.
 */
export const providerMessageDraftSchema = customerFacingText(bare, { fields: ['body'], forbid: ['contact', 'payment', 'approval', 'urls'] })
export type { ProviderMessageDraft } from '@amclub/shared'
