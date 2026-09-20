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
