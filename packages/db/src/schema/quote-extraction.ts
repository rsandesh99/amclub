import { pgTable, uuid, text, timestamp, jsonb, boolean, bigint, integer, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users, providerProfiles } from './identity'
import { rfqs, quotes } from './rfq'
import { aiDecisions } from './engagement'

// Quote extraction (0032, S1.1). One row per bounded model call on a provider's
// quote text: the sanitised input, the CLAMPED proposal, cost; decision_id is
// set by the submit route when the provider confirms (ai_decisions, feature
// quote_extraction). Service-role writes only; provider reads own; admin reads.
export const quoteExtractions = pgTable('quote_extractions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  rfqId: uuid('rfq_id').references(() => rfqs.id).notNull(),
  providerId: uuid('provider_id').references(() => providerProfiles.id).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  source: text('source').notNull(), // typed | voice
  inputText: text('input_text').notNull(),
  proposed: jsonb('proposed').notNull(), // QuoteExtraction (clamped)
  uncertainFields: text('uncertain_fields').array().default(sql`'{}'`).notNull(),
  model: text('model'),
  stub: boolean('stub').default(false).notNull(),
  costEstPaise: bigint('cost_est_paise', { mode: 'number' }),
  decisionId: uuid('decision_id').references(() => aiDecisions.id),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  index('quote_extractions_rfq_provider_created_idx').on(table.rfqId, table.providerId, table.createdAt),
  check('quote_extractions_source_check', sql`${table.source} IN ('typed', 'voice')`),
])

// Provider price book (0032, S1.1). The provider's stated price per (category,
// unit) from every submitted quote while AGENT_ENABLED — S2.2 Digital Munshi
// drafts from it; nothing reads it in S1.1. source_quote_id UNIQUE ⇒ idempotent.
export const providerPriceBook = pgTable('provider_price_book', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  providerId: uuid('provider_id').references(() => providerProfiles.id).notNull(),
  kind: text('kind').notNull(), // services | goods
  categorySlug: text('category_slug').notNull(),
  specialization: text('specialization'),
  unit: text('unit').notNull(), // services: 'job'; goods: goods_spec.unit
  pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
  deliveryDays: integer('delivery_days'),
  gstIncluded: boolean('gst_included'),
  transportIncluded: boolean('transport_included'),
  // 0040 (S2.2): NULL for a manual row (source 'manual'); the UNIQUE stays (NULLs are distinct).
  sourceQuoteId: uuid('source_quote_id').references(() => quotes.id).unique(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull(),
  // 0040 (S2.2): set by finalizeQuoteAcceptance for the winning quote; Munshi prefers accepted rows as its basis.
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  // 0040 (S2.2): the provider's soft delete through DELETE /partner/price-book/[id]; 'manual' rows come from POST.
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  source: text('source').default('quote').notNull(), // quote | manual
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  index('provider_price_book_provider_category_confirmed_idx').on(table.providerId, table.categorySlug, table.confirmedAt),
  check('provider_price_book_kind_check', sql`${table.kind} IN ('services', 'goods')`),
  check('provider_price_book_price_positive', sql`${table.pricePaise} > 0`),
  check('provider_price_book_source_check', sql`${table.source} IN ('quote', 'manual')`),
])
