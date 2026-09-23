// State machines — the single source of truth for all status enums and transitions
export * from './state-machines'

// Money math — order amounts, GST, commission split, refund policy matrix
export * from './money'

// ADR-014 — what a dispute resolution may do to the payout and refund rows
export * from './dispute-settlement'
export * from './dispute-window'

// Category taxonomy
export * from './categories'

// Per-category professional credential model (wizard options, statutory gating,
// canonical provider_verifications.kind mapping)
export * from './credentials'

// RFQ template fields + contact masking
export * from './rfq'
export * from './clarifications'
export * from './rfq-quality'

// S2.1 — customer-facing output policy (phrase lists + contact patterns; the Zod post-validator lives in agent-core)
export * from './output-policy'

// S1.8 — voice RFQ v2 / document intake: contracts, the clarify rule, deterministic STEP / DXF summaries
export * from './intake'
export * from './intake-rules'
export * from './drawings/step'
export * from './drawings/dxf'

// Voice RFQ specialization vocabulary (Phase 8b)
export * from './specializations'

// Indian state / UT codes (shared by web + mobile filters, wizards, DB columns)
export * from './states'

// GSTIN format + mod-36 checksum validation
export * from './gstin'

// Experience v3 rollout flags (closed registry, server-evaluated)
export * from './experiments'

// N16 — server price display ("₹X + 18 % GST = ₹Y")
export * from './price-display'
export * from './packages-v3'
export * from './search-v2'
export * from './rfq-v3'
export * from './home-v3'
export * from './licences'
export * from './provider-onboarding-v3'
export * from './partner-v3'
export * from './quote-v3'
export * from './insights-v3'
export * from './quote-loss'
export * from './order-workspace-v3'
export * from './order-messages'
export * from './mobile-v3'
export * from './motion'

// N9 — public measured stats (gated; never the composite score)
export * from './public-stats'

// N33 — display density preference
export * from './preferences'

// N3 — universal search contract
export * from './universal-search'

// N2 — /me/actions contract (nav badges + home action lists)
export * from './me-actions'

// N23 — the next action on an order (badges, home lists, NextStepBar)
export * from './order-next-action'

// E0 / U8 — provider home stats (server-computed, web + mobile)
export * from './provider-stats'

// Post-auth redirect sanitising + intent carry-over (E0 / U1)
export * from './safe-next'

// Indian mobile number normalisation (paste-safe national form + E.164)
export * from './phone'

// /api/v1/profile/me response contract (web + mobile)
export * from './profile'

// UI locale + provider spoken-language single sources of truth (S3)
export * from './locales'
export * from './i18n-text'
export * from './voice-languages'
export * from './content-translation'

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

// S1.7 — party statements + the Dispute-Triage card (strict, recommendation only; checks + clamp are code)
export * from './disputes'

// S1.1 — quote extraction contract (schema, clamp, edited-fields diff)
export * from './quote-extraction'

// S1.2 — comparability engine (deterministic flags + normalised totals), pointer + decline-message contracts
export * from './compare'
export * from './compare-pointers'
export * from './decline-message'

// S2.2 — Digital Munshi contract (scopes, draft schema + clamp, price band, the voice allow-list, thread replies, WhatsApp copy)
export * from './munshi'

// S2.3 — Support agent contract (intents, the reply matrix, the numbers rule) and every user-visible reply per locale
export * from './support'
export * from './support-copy'
export * from './score'
export * from './score-tips'
export * from './score-note'
export * from './munshi-growth'

// S3.1 — Buyer Procurement Agent contract (scopes without accept/pay, the turn classifier, the no-negotiation clamp, the chat quote summary) + every message it sends
export * from './procurement'
export * from './benchmarks'
export * from './procurement-copy'

// S1.6 — onboarding agent contract (steps + transitions, strict draft schema, capability facts) and interview copy (en/hi/te)
export * from './onboarding'
export * from './onboarding-copy'

// Legal documents: current versions (single source for pages, modal, acceptance rows)
export * from './legal'

// Zod schemas and derived TypeScript types
export * from './schemas/index'

// AMC Mart — goods mode vocabulary, schemas, state machines, money math (M0)
export * from './mart/index'
