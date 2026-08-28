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

// Legal documents: current versions (single source for pages, modal, acceptance rows)
export * from './legal'

// Zod schemas and derived TypeScript types
export * from './schemas/index'
