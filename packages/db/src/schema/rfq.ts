import {
  pgTable, uuid, text, integer, timestamp, jsonb, bigint, date, boolean,
  index, unique, primaryKey,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { msmeProfiles, providerProfiles } from './identity'
import { categories } from './catalog'

export const rfqs = pgTable('rfqs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  msmeId: uuid('msme_id').references(() => msmeProfiles.id, { onDelete: 'cascade' }).notNull(),
  // Nullable since 0024 for kind='goods' only (CHECK rfqs_kind_shape_check).
  categoryId: uuid('category_id').references(() => categories.id),
  title: text('title').notNull(),
  details: jsonb('details').notNull(),
  attachments: jsonb('attachments').default(sql`'[]'::jsonb`).notNull(),
  budgetMinPaise: bigint('budget_min_paise', { mode: 'number' }),
  budgetMaxPaise: bigint('budget_max_paise', { mode: 'number' }),
  neededBy: date('needed_by'),
  // Phase 8b — transcript + parse when the RFQ began as a voice recording.
  voiceMeta: jsonb('voice_meta'),
  // AMC Mart M2 (0024, STAGED): service | goods. Goods RFQs carry a Mart
  // category + goods_spec instead of a services category/template.
  kind: text('kind').default('service').notNull(),
  martCategorySlug: text('mart_category_slug'),
  goodsSpec: jsonb('goods_spec'),
  // open | quoted | accepted | expired | cancelled
  status: text('status').default('open').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  maxQuotes: integer('max_quotes').default(7).notNull(),
  quoteCount: integer('quote_count').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('rfqs_msme_status_idx').on(table.msmeId, table.status),
  index('rfqs_category_status_idx').on(table.categoryId, table.status),
])

export const rfqMatches = pgTable('rfq_matches', {
  rfqId: uuid('rfq_id').references(() => rfqs.id, { onDelete: 'cascade' }).notNull(),
  providerId: uuid('provider_id').references(() => providerProfiles.id, { onDelete: 'cascade' }).notNull(),
  notifiedAt: timestamp('notified_at', { withTimezone: true }).default(sql`now()`).notNull(),
  viewedAt: timestamp('viewed_at', { withTimezone: true }),
  // S0.4 quote-or-decline (0029): a decline is an active decision, never silence.
  declinedAt: timestamp('declined_at', { withTimezone: true }),
  declineReason: text('decline_reason'), // DECLINE_REASONS | window_lapsed
}, (table) => [
  primaryKey({ columns: [table.rfqId, table.providerId] }),
])

export const quotes = pgTable('quotes', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  rfqId: uuid('rfq_id').references(() => rfqs.id, { onDelete: 'cascade' }).notNull(),
  providerId: uuid('provider_id').references(() => providerProfiles.id, { onDelete: 'cascade' }).notNull(),
  pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
  deliveryDays: integer('delivery_days').notNull(),
  scope: text('scope').notNull(),
  message: text('message'),
  // Phase 4a — optional commercial terms (0018). NULL = not stated.
  gstIncluded: boolean('gst_included'),
  transportIncluded: boolean('transport_included'),
  validUntil: date('valid_until'),
  // CHECK 0..100 when not null (quotes_advance_percent_range)
  advancePercent: integer('advance_percent'),
  // AMC Mart M2 (0024, STAGED) — goods terms; all NULL on services quotes.
  // CHECK quotes_goods_terms_check: complete set + price_paise = unit × qty.
  unitPricePaise: bigint('unit_price_paise', { mode: 'number' }),
  qty: integer('qty'),
  gstRateBps: integer('gst_rate_bps'),
  hsnCode: text('hsn_code'),
  productId: uuid('product_id'),
  // submitted | withdrawn | accepted | declined | expired
  status: text('status').default('submitted').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (table) => [
  unique('quotes_rfq_provider_uniq').on(table.rfqId, table.providerId),
])

// Append-only lifecycle history for quotes (mirrors order_events); no updatedAt.
// Written alongside every quotes.status mutation — the status column is untouched.
export const quoteEvents = pgTable('quote_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  quoteId: uuid('quote_id').references(() => quotes.id, { onDelete: 'cascade' }).notNull(),
  // submitted | declined | withdrawn | accepted | expired | auto_declined
  eventType: text('event_type').notNull(),
  // acting user id, or 'system' for cron/payment-driven events
  actor: text('actor').default('system').notNull(),
  reason: text('reason'),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  index('quote_events_quote_idx').on(table.quoteId),
  index('quote_events_type_idx').on(table.eventType),
])
