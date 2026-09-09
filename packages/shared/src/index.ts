// State machines — the single source of truth for all status enums and transitions
export * from './state-machines'

// Money math — order amounts, GST, commission split, refund policy matrix
export * from './money'

// Category taxonomy
export * from './categories'

// Per-category professional credential model (wizard options, statutory gating,
// canonical provider_verifications.kind mapping)
export * from './credentials'

// RFQ template fields + contact masking
export * from './rfq'

// Voice RFQ specialization vocabulary (Phase 8b)
export * from './specializations'

// Indian state / UT codes (shared by web + mobile filters, wizards, DB columns)
export * from './states'

// GSTIN format + mod-36 checksum validation
export * from './gstin'

// /api/v1/profile/me response contract (web + mobile)
export * from './profile'

// UI locale + provider spoken-language single sources of truth (S3)
export * from './locales'

// Agentic assistant contract: task classes → tiers, personas, tool allowlists,
// confirm gates, event kinds (H0 groundwork, DESIGN.md §8.6 / ADR-008)
export * from './agent'

// Legal documents: current versions (single source for pages, modal, acceptance rows)
export * from './legal'

// Zod schemas and derived TypeScript types
export * from './schemas/index'

// AMC Mart — goods mode vocabulary, schemas, state machines, money math (M0)
export * from './mart/index'
