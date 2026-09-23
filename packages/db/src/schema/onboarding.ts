import { pgTable, uuid, text, timestamp, jsonb, integer, boolean, index, check, primaryKey } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users, providerProfiles } from './identity'
import { agentRuns, aiDecisions } from './engagement'
import { waConversations } from './whatsapp'

// Onboarding agent (0036, S1.6). One durable row per provider interview; the
// scripted state machine (ONBOARDING_STEPS in @amclub/shared) lives in
// `state`, `answers` is the redacted transcript, the ONE model call writes
// `draft`, the provider's button tap is the confirmation (draft_decision_id →
// ai_decisions), the wizard submit links provider_id. Service-role writes
// only (runtime + web routes); self + admin read. One ACTIVE session per user
// (partial unique index in SQL).
export const onboardingSessions = pgTable('onboarding_sessions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  rootRunId: uuid('root_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  conversationId: uuid('conversation_id').references(() => waConversations.id, { onDelete: 'set null' }),
  surface: text('surface').notNull(), // whatsapp | web
  locale: text('locale').default('en').notNull(),
  state: text('state').default('language').notNull(), // ONBOARDING_STEPS
  answers: jsonb('answers').default(sql`'[]'::jsonb`).notNull(), // OnboardingAnswer[] (redacted)
  photoRefs: text('photo_refs').array().default(sql`'{}'`).notNull(), // wa-media paths
  categorySlugs: text('category_slugs').array().default(sql`'{}'`).notNull(),
  gstin: text('gstin'),
  udyam: text('udyam'),
  draft: jsonb('draft'), // OnboardingDraft (strict)
  draftRunId: uuid('draft_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  draftDecisionId: uuid('draft_decision_id').references(() => aiDecisions.id),
  draftCount: integer('draft_count').default(0).notNull(),
  revisePending: boolean('revise_pending').default(false).notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  handedOffAt: timestamp('handed_off_at', { withTimezone: true }),
  providerId: uuid('provider_id').references(() => providerProfiles.id, { onDelete: 'set null' }),
  lastPromptAt: timestamp('last_prompt_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  failure: text('failure'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('onboarding_sessions_user_created_idx').on(table.userId, table.createdAt),
  check('onboarding_sessions_surface_check', sql`${table.surface} IN ('whatsapp', 'web')`),
])

// ARCHITECTURE §10 — confirmed capability facts with provenance. Written ONLY
// on draft confirmation (one per scope / deliverable line); read by nobody
// before S2.2.
export const providerCapabilityFacts = pgTable('provider_capability_facts', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  providerId: uuid('provider_id').references(() => providerProfiles.id, { onDelete: 'set null' }),
  categorySlug: text('category_slug').notNull(),
  fact: text('fact').notNull(), // ≤ 300 (CHECK)
  locale: text('locale').notNull(),
  sourceDecisionId: uuid('source_decision_id').references(() => aiDecisions.id).notNull(),
  sourceSessionId: uuid('source_session_id').references(() => onboardingSessions.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('provider_capability_facts_user_idx').on(table.userId, table.categorySlug),
])

// Experience v3 E10 (0055; FR-10.4, N27c): the v3 wizard's last saved step per
// applicant and the stall nudges (at most 2; PK (user_id, nudge_no)). Service role only.
export const providerOnboardingProgress = pgTable('provider_onboarding_progress', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  step: text('step').notNull(),
  categorySlug: text('category_slug'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
})

export const onboardingNudges = pgTable('onboarding_nudges', {
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  nudgeNo: integer('nudge_no').notNull(),
  step: text('step').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).default(sql`now()`).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.nudgeNo] })])
