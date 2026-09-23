import { pgTable, uuid, text, timestamp, jsonb, numeric, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// Experience v3 E15 F10 (0062) — shadow predictions: predicted vs actual for a
// shadow feature, shown to nobody but the admin console. Service role only;
// subject ids only; kept 24 months. Writers: apps/web/lib/shadow.
export const shadowPredictions = pgTable('shadow_predictions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  // cad_price_band | provider_fit
  feature: text('feature').notNull(),
  modelVersion: text('model_version').notNull(),
  // rfq
  subjectKind: text('subject_kind').notNull(),
  subjectId: uuid('subject_id').notNull(),
  predicted: jsonb('predicted').notNull(),
  actual: jsonb('actual'),
  error: numeric('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  index('shadow_predictions_subject_idx').on(table.feature, table.subjectKind, table.subjectId),
])
