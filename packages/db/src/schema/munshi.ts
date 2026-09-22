import { pgTable, uuid, text, timestamp, jsonb, boolean, bigint, integer, date, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users, providerProfiles } from './identity'
import { agentRuns, aiDecisions } from './engagement'
import { rfqs, quotes } from './rfq'

// Digital Munshi (0040, S2.2). One row per proposal the provider decides on:
// a quote draft, ONE clarifying question, a skip with a reason, or a reply on
// a quote thread. `draft` is the validated + clamped MunshiDraft /
// ThreadReplyDraft; `basis` the price-book rows the band came from (refs +
// paise). The provider's tap writes ai_decisions (decision_id) and the
// ordinary route runs under the delegated token; result_ref links what it
// created. Service-role writes only (runtime + web routes); provider reads
// own; admin reads. One OPEN draft per (rfq, provider) — partial unique index
// in SQL.
export const munshiDrafts = pgTable('munshi_drafts', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  providerId: uuid('provider_id').references(() => providerProfiles.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  rfqId: uuid('rfq_id').references(() => rfqs.id),
  quoteId: uuid('quote_id').references(() => quotes.id),
  kind: text('kind').notNull(), // quote | ask | skip | reply
  runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  draft: jsonb('draft').notNull(),
  basis: jsonb('basis').default(sql`'[]'::jsonb`).notNull(),
  status: text('status').default('proposed').notNull(), // MUNSHI_DRAFT_STATUSES
  decisionId: uuid('decision_id').references(() => aiDecisions.id),
  resultRef: jsonb('result_ref'),
  delivered: jsonb('delivered').default(sql`'{}'::jsonb`).notNull(),
  modelCostPaise: bigint('model_cost_paise', { mode: 'number' }).default(0).notNull(),
  stub: boolean('stub').default(false).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('munshi_drafts_provider_status_created_idx').on(table.providerId, table.status, table.createdAt),
  index('munshi_drafts_run_idx').on(table.runId),
  index('munshi_drafts_rfq_idx').on(table.rfqId),
  check('munshi_drafts_kind_check', sql`${table.kind} IN ('quote', 'ask', 'skip', 'reply')`),
  check('munshi_drafts_status_check', sql`${table.status} IN ('proposed', 'approved', 'edited', 'skipped', 'expired', 'failed')`),
])

// Per-provider scan state (0040, S2.2): the scan cursor, the daily counter
// (IST date), pause, and the once-per-match window warnings keyed by rfq id.
export const munshiProviderState = pgTable('munshi_provider_state', {
  providerId: uuid('provider_id').primaryKey().references(() => providerProfiles.id),
  userId: uuid('user_id').references(() => users.id).notNull(),
  lastScanAt: timestamp('last_scan_at', { withTimezone: true }),
  lastGrowthAt: timestamp('last_growth_at', { withTimezone: true }), // S2.4: the weekly growth nudge cursor (0042)
  lastScanRunId: uuid('last_scan_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  draftsToday: integer('drafts_today').default(0).notNull(),
  draftsTodayDate: date('drafts_today_date'),
  pausedUntil: timestamp('paused_until', { withTimezone: true }),
  locale: text('locale').default('en').notNull(),
  munshiReminders: jsonb('munshi_reminders').default(sql`'{}'::jsonb`).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
})
