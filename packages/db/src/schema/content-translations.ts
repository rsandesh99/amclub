import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { providerProfiles } from './identity'

// Experience v3 E14 FR-14.3 (N32b, 0061) — model drafts of a provider's own
// catalogue copy in hi / te / ta. A draft never renders; the provider's approve
// writes the text into the entity's i18n map. Service role writes; the provider
// reads their own rows.
export const contentTranslations = pgTable('content_translations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  providerId: uuid('provider_id').references(() => providerProfiles.id, { onDelete: 'cascade' }).notNull(),
  // package | profile
  subjectKind: text('subject_kind').notNull(),
  subjectId: uuid('subject_id').notNull(),
  // title | ideal_for | about
  field: text('field').notNull(),
  // hi | te | ta
  lang: text('lang').notNull(),
  sourceText: text('source_text').notNull(),
  draftText: text('draft_text').notNull(),
  finalText: text('final_text'),
  // draft | approved | rejected | stale
  status: text('status').default('draft').notNull(),
  invocationId: uuid('invocation_id'),
  decisionId: uuid('decision_id'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  index('content_translations_provider_idx').on(table.providerId, table.createdAt),
])
