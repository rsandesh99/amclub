/**
 * AMC Mart — goods catalog + decision log (MART_DESIGN.md §4.2, §4.6).
 * ALL additive. Applied by migration 0022 (STAGED — not applied to prod during
 * the dark build; deploys together with the enabling release, §8.2).
 *
 * Sellers are providers (provider_profiles.sells_goods); goods orders are
 * orders (kind='goods', line_items). No second identity/order table exists.
 */
import {
  pgTable, uuid, text, boolean, integer, timestamp, jsonb, bigint, index, unique, check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users, providerProfiles } from './identity'

/** Per-category launch config: return window, commission, BIS block (§2). Seeded from MART_CATEGORY_SEED. */
export const martCategories = pgTable('mart_categories', {
  slug: text('slug').primaryKey(),
  nameI18n: jsonb('name_i18n').notNull(),
  returnWindowHours: integer('return_window_hours').default(48).notNull(),
  commissionBps: integer('commission_bps').default(500).notNull(),
  bisBlocked: boolean('bis_blocked').default(false).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  sortOrder: integer('sort_order'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})

/** Key/value config the CA / founder sets (e-way-bill threshold, TDS rates, auto-approve N). Admin-only. */
export const martSettings = pgTable('mart_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})

export const products = pgTable('products', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  sellerId: uuid('seller_id').references(() => providerProfiles.id, { onDelete: 'cascade' }).notNull(),
  categorySlug: text('category_slug').references(() => martCategories.slug).notNull(),
  name: text('name').notNull(),
  description: text('description'),
  brand: text('brand'),
  // [{ k, v }] — spec table rows (seller-confirmed)
  specs: jsonb('specs').default(sql`'[]'`).notNull(),
  // in_stock | lead_time — seller-declared, never inventory
  availability: text('availability').default('in_stock').notNull(),
  leadTimeDays: integer('lead_time_days'),
  // Denormalised min_qty=1 tier price, written by the API on every tier change;
  // lets the public catalog sort/filter by price without a join.
  listPricePaise: bigint('list_price_paise', { mode: 'number' }),
  hsnCode: text('hsn_code').notNull(),
  // basis points: 0 | 500 | 1200 | 1800 | 2800
  gstRateBps: integer('gst_rate_bps').notNull(),
  unit: text('unit').notNull(),
  // public-assets storage keys
  images: text('images').array().default(sql`'{}'`).notNull(),
  minOrderQty: integer('min_order_qty').default(1).notNull(),
  countryOfOrigin: text('country_of_origin').default('IN').notNull(),
  // draft | pending_approval | active | suspended  (packages/shared PRODUCT_STATUSES)
  status: text('status').default('draft').notNull(),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  // search_tsv is a GENERATED column in the migration (name + description + hsn)
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('products_seller_idx').on(table.sellerId),
  index('products_category_status_idx').on(table.categorySlug, table.status),
  index('products_status_price_idx').on(table.status, table.listPricePaise),
  check('products_availability_check', sql`${table.availability} IN ('in_stock', 'lead_time')`),
  check('products_status_check', sql`${table.status} IN ('draft', 'pending_approval', 'active', 'suspended')`),
  check('products_gst_rate_check', sql`${table.gstRateBps} IN (0, 500, 1200, 1800, 2800)`),
  check('products_hsn_check', sql`${table.hsnCode} ~ '^[0-9]{4}([0-9]{2})?([0-9]{2})?$'`),
])

/** Bulk pricing — the substrate of pools. min_qty=1 row is the list price. */
export const priceTiers = pgTable('price_tiers', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }).notNull(),
  minQty: integer('min_qty').notNull(),
  unitPricePaise: bigint('unit_price_paise', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (table) => [
  unique('price_tiers_product_min_qty_uniq').on(table.productId, table.minQty),
  check('price_tiers_min_qty_positive', sql`${table.minQty} > 0`),
  check('price_tiers_price_positive', sql`${table.unitPricePaise} > 0`),
])

/** Append-only (trigger + revoked grants + RLS read policies) — mirrors quote_events exactly. */
export const productEvents = pgTable('product_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }).notNull(),
  actorId: uuid('actor_id').references(() => users.id),
  // created | edited | submitted | activated | rejected | suspended | price_changed
  eventType: text('event_type').notNull(),
  // { before, after } on edits/price changes; { reason } on reject/suspend
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  index('product_events_product_idx').on(table.productId, table.createdAt),
])

/**
 * ai_decisions (§4.6) — append-only decision records for every AI output a
 * human confirms/corrects. Refs only, no PII blobs. Training corpus; cannot
 * be backfilled, hence M0.
 */
export const aiDecisions = pgTable('ai_decisions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  // catalog_draft | payout_dossier | extraction_correction
  feature: text('feature').notNull(),
  inputRefs: jsonb('input_refs').notNull(),
  proposed: jsonb('proposed').notNull(),
  final: jsonb('final').notNull(),
  correctedFields: text('corrected_fields').array().default(sql`'{}'`).notNull(),
  decidedBy: uuid('decided_by').references(() => users.id).notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }).default(sql`now()`).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  index('ai_decisions_feature_idx').on(table.feature, table.decidedAt),
])
