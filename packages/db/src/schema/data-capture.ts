import { pgTable, uuid, text, timestamp, jsonb, integer, boolean, index, unique } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './identity'

// Experience v3 E15 (0063) — nothing user-visible. Service role writes; see the migration header.

// F5 — a sample of search result pages; no user id; kept 180 days.
export const searchQueries = pgTable('search_queries', {
  id: uuid('id').primaryKey(),
  queryNorm: text('query_norm'),
  params: jsonb('params').default(sql`'{}'::jsonb`).notNull(),
  resultCount: integer('result_count').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [index('search_queries_created_idx').on(table.createdAt)])

// F6 — consented, text-only voice triples (no audio is ever kept).
export const corpusVoiceTriples = pgTable('corpus_voice_triples', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  rfqId: uuid('rfq_id'),
  lang: text('lang'),
  transcript: text('transcript').notNull(),
  parsed: jsonb('parsed').notNull(),
  final: jsonb('final').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [index('corpus_voice_triples_user_idx').on(table.userId)])

// F6 — consented document-intake → final-request pairs (the image stays in its bucket, by key).
export const corpusImagePairs = pgTable('corpus_image_pairs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  rfqId: uuid('rfq_id'),
  storageKey: text('storage_key'),
  docType: text('doc_type'),
  proposed: jsonb('proposed').notNull(),
  final: jsonb('final').notNull(),
  corrections: jsonb('corrections').default(sql`'[]'::jsonb`).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [index('corpus_image_pairs_user_idx').on(table.userId)])

// F6 — curated term → category / service; anyone reads reviewed rows.
export const serviceSynonyms = pgTable('service_synonyms', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  term: text('term').notNull(),
  termKey: text('term_key').notNull(),
  lang: text('lang').notNull(),
  categorySlug: text('category_slug').notNull(),
  serviceSlug: text('service_slug'),
  // curated | search_log | corpus
  source: text('source').notNull(),
  reviewed: boolean('reviewed').default(false).notNull(),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [unique('service_synonyms_term_lang_uniq').on(table.termKey, table.lang)])
