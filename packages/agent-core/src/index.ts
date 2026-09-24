/**
 * @amclub/agent-core — the library shared by apps/agent-runtime (the always-on
 * loops/workers) and the Vercel functions (bounded single-shot calls). It owns
 * the model gateway, the prompt registry, the untrusted-content Envelope, the
 * ledgers, the budget counters, the delegated-identity credential, and the
 * runner. NO `next` dependency (ADR-009 §1). Both sides import the same bytes,
 * so one gateway, one cost logger, one injection boundary, one confirm gate.
 */
export * from './untrusted/envelope'
export * from './untrusted/injection'
export * from './untrusted/output'
export * from './prompts/registry'
export { helloSchema, type Hello } from './prompts/hello/schema'
export { photoPlausibilitySchema, photoFindingSchema, type PhotoPlausibility, type PhotoFinding } from './prompts/photo_plausibility/schema'
export { quoteExtractionSchema, type QuoteExtraction } from './prompts/quote_extract/schema'
export { comparePointersSchema, type ComparePointers } from './prompts/quote_compare/schema'
export { declineMessageSchema, type DeclineMessage } from './prompts/decline_message/schema'
export { rfqQualityModelOutputSchema, rfqQualityReportSchema, rfqQualityPrecheck, mergeQualityReport, type RfqQualityModelOutput, type RfqQualityReport } from './prompts/rfq_quality/schema'
export * from './rfq-quality/parts'
// S1.8 — voice/document intake: parse (v1/v2), clarify and document parts (taint); the parser prompt lives here now
export * from './intake/parts'
export { rfqParseModelOutputSchema, type RfqParseModelOutput } from './prompts/rfq_parse/schema'
// S2.1 — the customer-facing contract wraps these in the agent-core schema files; import them from here, not from shared
export { clarifyQuestionSchema } from './prompts/rfq_clarify/schema'
export { documentExtractSchema } from './prompts/document_extract/schema'
// S1.6 — onboarding interview: pure state machine, prompt parts (taint), draft summary renderer
export * from './onboarding/index'
// S1.7 — dispute triage: prompt parts (taint); the strict card + checks + clamp live in shared
export * from './dispute-triage/parts'
export { disputeTriageSchema, type DisputeTriage } from './prompts/dispute_triage/schema'
export { onboardingDraftSchema, type OnboardingDraft } from './prompts/onboarding_interview/schema'
export * from './compare/parts'
export * from './compare/stub'
export * from './decline/parts'
export * from './quote-extract/parts'
// S2.2 — Digital Munshi: parts builders, the pure draft agent (driven by the runtime and by the eval harness), wrapped schemas
export * from './munshi/parts'
export * from './munshi/agent'
export { munshiDraftSchema } from './prompts/quote_draft/schema'
export { approvalIntentSchema } from './prompts/approval_intent/schema'
export { threadReplyDraftSchema } from './prompts/thread_reply/schema'
// S2.3 — Support agent: the ONE engine (web / mobile session client, WhatsApp token GETs), parts builders, wrapped schemas
export * from './support/parts'
export * from './support/core'
export * from './support/stub'
export { supportIntentSchema } from './prompts/support_intent/schema'
export { supportTicketSummarySchema } from './prompts/support_ticket_summary/schema'
export * from './score/parts'
export { scoreNoteSchema } from './prompts/score_note/schema'
export * from './benchmark/parts'
export { benchmarkExplainSchema } from './prompts/benchmark_explain/schema'
export * from './content-translate/parts'
export { contentTranslateSchema } from './prompts/provider_content_translate/schema'
// S3.1 — the Buyer Procurement Agent (the turn + watch definitions, the session rules both the runtime and the harness apply, parts, keyless producers)
export * from './procurement/parts'
export * from './procurement/stub'
export * from './procurement/session'
export * from './procurement/agent'
export { procurementTurnSchema } from './prompts/procurement_turn/schema'
export { clarificationAnswerDraftSchema } from './prompts/clarification_answer/schema'
export { providerMessageDraftSchema } from './prompts/provider_message/schema'
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
