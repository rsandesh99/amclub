/**
 * @amclub/agent-core — the library shared by apps/agent-runtime (the always-on
 * loops/workers) and the Vercel functions (bounded single-shot calls). It owns
 * the model gateway, the prompt registry, the untrusted-content Envelope, the
 * ledgers, the budget counters, the delegated-identity credential, and the
 * runner. NO `next` dependency (ADR-009 §1). Both sides import the same bytes,
 * so one gateway, one cost logger, one injection boundary, one confirm gate.
 */
export * from './untrusted/envelope'
export * from './prompts/registry'
export { helloSchema, type Hello } from './prompts/hello/schema'
export { photoPlausibilitySchema, photoFindingSchema, type PhotoPlausibility, type PhotoFinding } from './prompts/photo_plausibility/schema'
export { quoteExtractionSchema, type QuoteExtraction } from './prompts/quote_extract/schema'
export { comparePointersSchema, type ComparePointers } from './prompts/quote_compare/schema'
export { declineMessageSchema, type DeclineMessage } from './prompts/decline_message/schema'
export { rfqQualityModelOutputSchema, rfqQualityReportSchema, rfqQualityPrecheck, mergeQualityReport, type RfqQualityModelOutput, type RfqQualityReport } from './prompts/rfq_quality/schema'
export * from './rfq-quality/parts'
// S1.6 — onboarding interview: pure state machine, prompt parts (taint), draft summary renderer
export * from './onboarding/index'
export { onboardingDraftSchema, type OnboardingDraft } from './prompts/onboarding_interview/schema'
export * from './compare/parts'
export * from './compare/stub'
export * from './decline/parts'
export * from './quote-extract/parts'
export * from './bounded'
export * from './media/dhash'
export * from './dossier/checks'
export * from './dossier/fixtures'
export * from './llm/router'
export * from './llm/gateway'
export * from './ledger'
export * from './budget'
export * from './auth/runtime-credential'
export * from './runner'
export * from './whatsapp'
