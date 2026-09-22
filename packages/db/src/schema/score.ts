import { pgTable, uuid, text, timestamp, jsonb, boolean, integer, date, primaryKey, uniqueIndex, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { providerProfiles, msmeProfiles } from './identity'

// AMC Score v1 (0042, S2.4, ADR-010). Snapshots are the latest per (subject, version), upserted nightly by
// cron/score-compute from the score_inputs_provider / score_inputs_buyer SQL functions and the pure formula in
// @amclub/shared score.ts. A provider reads their OWN provider rows; buyer rows are admin / ops only; no client
// writes. score_events is APPEND-ONLY (raise_append_only trigger, RULES 3).
export const providerScores = pgTable(
  'provider_scores',
  {
    providerId: uuid('provider_id').references(() => providerProfiles.id, { onDelete: 'cascade' }).notNull(),
    scoreVersion: text('score_version').notNull(),
    score: integer('score'), // 0..100, null below the sample gate
    components: jsonb('components').notNull(),
    sample: jsonb('sample').notNull(),
    gated: boolean('gated').notNull(),
    note: jsonb('note'), // the day's coaching note { on, locale, text } — informational
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.providerId, t.scoreVersion] }) }),
)

export const buyerScores = pgTable(
  'buyer_scores',
  {
    msmeId: uuid('msme_id').references(() => msmeProfiles.id, { onDelete: 'cascade' }).notNull(),
    scoreVersion: text('score_version').notNull(),
    score: integer('score'),
    components: jsonb('components').notNull(),
    sample: jsonb('sample').notNull(),
    gated: boolean('gated').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.msmeId, t.scoreVersion] }) }),
)

export const scoreHistory = pgTable(
  'score_history',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    subjectType: text('subject_type').notNull(), // provider | buyer
    subjectId: uuid('subject_id').notNull(),
    scoreVersion: text('score_version').notNull(),
    score: integer('score'),
    components: jsonb('components').notNull(),
    computedOn: date('computed_on').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ subjectDay: uniqueIndex('score_history_subject_day_uidx').on(t.subjectType, t.subjectId, t.scoreVersion, t.computedOn) }),
)

export const scoreEvents = pgTable(
  'score_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    scoreVersion: text('score_version').notNull(),
    delta: integer('delta').notNull(),
    fromScore: integer('from_score'),
    toScore: integer('to_score'),
    reason: text('reason').notNull(), // the component that moved most, or 'gate'
    ref: jsonb('ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ subjectCreated: index('score_events_subject_created_idx').on(t.subjectType, t.subjectId, t.createdAt) }),
)
