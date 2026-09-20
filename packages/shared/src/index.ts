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

// Agent config registry: agents_enabled, budget caps, cohort, consent version —
// the closed registry the admin console edits (S0.1, ADR-009 §7)
export * from './agent-settings'

// Services evidence engine: milestone machine + payout release gate (S0.3)
export * from './evidence'

// Trust mechanics: quote-or-decline reasons, configurable quote cap (S0.4)
export * from './trust'

// S1.4 — payout dossier contract (checks, photo findings, recommendation rule)
export * from './dossier'

// S1.1 — quote extraction contract (schema, clamp, edited-fields diff)
export * from './quote-extraction'

// Legal documents: current versions (single source for pages, modal, acceptance rows)
export * from './legal'

// Zod schemas and derived TypeScript types
export * from './schemas/index'

// AMC Mart — goods mode vocabulary, schemas, state machines, money math (M0)
export * from './mart/index'
