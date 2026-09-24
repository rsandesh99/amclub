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
  // §9.2 — seller | buyer | split (0025, staged)
  returnFreightPayer: text('return_freight_payer').default('seller').notNull(),
  // E16 N43 (0069, staged) — "Not returnable"; the CA-reviewed §17(5) ITC flag.
  returnable: boolean('returnable').default(true).notNull(),
  itcEligible: boolean('itc_eligible').default(true).notNull(),
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
  // E16 N40 (0069, staged) — { key: value } validated per category (mart_category_attributes)
  attributes: jsonb('attributes').default(sql`'{}'`).notNull(),
  // E16 N41 — seller opt-in promises (ships_48h | return_shipping_covered | gst_invoice_24h)
  promises: text('promises').array().default(sql`'{}'`).notNull(),
  // E16 N42 — a sample = an ordinary goods order of qty 1 at this price; NULL = no samples
  samplePricePaise: bigint('sample_price_paise', { mode: 'number' }),
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

/** E16 N40 (0069, staged) — typed attributes per category; public read, admin-owned config. */
export const martCategoryAttributes = pgTable('mart_category_attributes', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  categorySlug: text('category_slug').references(() => martCategories.slug, { onDelete: 'cascade' }).notNull(),
  key: text('key').notNull(),
  labelI18n: jsonb('label_i18n').notNull(),
  // text | number | enum | bool
  type: text('type').notNull(),
  unit: text('unit'),
  options: jsonb('options'),
  facetable: boolean('facetable').default(false).notNull(),
  required: boolean('required').default(false).notNull(),
  sort: integer('sort').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  unique('mart_category_attributes_category_slug_key_key').on(table.categorySlug, table.key),
  check('mart_category_attributes_type_check', sql`${table.type} IN ('text', 'number', 'enum', 'bool')`),
])

/** E16 N41 (0069, staged) — one row per measured promise breach; service role only. */
export const martPromiseBreaches = pgTable('mart_promise_breaches', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orderId: uuid('order_id').notNull(),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
  sellerId: uuid('seller_id').references(() => providerProfiles.id, { onDelete: 'cascade' }).notNull(),
  promise: text('promise').notNull(),
  measuredAt: timestamp('measured_at', { withTimezone: true }).default(sql`now()`).notNull(),
  detail: jsonb('detail').default(sql`'{}'`).notNull(),
}, (table) => [
  unique('mart_promise_breaches_order_id_product_id_promise_key').on(table.orderId, table.productId, table.promise),
  index('mart_promise_breaches_product_idx').on(table.productId, table.promise, table.measuredAt),
])

/** E16 N44 (0069, staged) — the buyer's opt-in reorder reminder; owner reads, API writes. */
export const martReorderReminders = pgTable('mart_reorder_reminders', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'cascade' }).notNull(),
  intervalDays: integer('interval_days').notNull(),
  nextAt: timestamp('next_at', { withTimezone: true }).notNull(),
  active: boolean('active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  unique('mart_reorder_reminders_user_id_product_id_key').on(table.userId, table.productId),
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

// ai_decisions moved to schema/engagement.ts — migration 0027 LIFTS it out of
// the staged Mart 0022 into an always-applied table (the ONE confirmation ledger
// for Mart + runtime agents; gains run_id/tool). Import `aiDecisions` from there.

// ── M1 — group-buy pools (§4.4). Applied by migration 0023 (STAGED). ─────────

export const pools = pgTable('pools', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),
  categorySlug: text('category_slug').references(() => martCategories.slug).notNull(),
  spec: jsonb('spec'),
  title: text('title').notNull(),
  unit: text('unit').notNull(),
  targetQty: integer('target_qty').notNull(),
  minQty: integer('min_qty').notNull(),
  unitPricePaise: bigint('unit_price_paise', { mode: 'number' }).notNull(),
  closesAt: timestamp('closes_at', { withTimezone: true }).notNull(),
  // draft | open | closed_met | closed_unmet | ordered | fulfilled | cancelled
  status: text('status').default('draft').notNull(),
  sellerId: uuid('seller_id').references(() => providerProfiles.id, { onDelete: 'set null' }),
  createdBy: uuid('created_by').references(() => users.id),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  rationale: jsonb('rationale').default(sql`'{}'`).notNull(),
  cardI18n: jsonb('card_i18n'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('pools_status_closes_idx').on(table.status, table.closesAt),
  index('pools_product_idx').on(table.productId),
  index('pools_seller_idx').on(table.sellerId),
  check('pools_status_check', sql`${table.status} IN ('draft','open','closed_met','closed_unmet','ordered','fulfilled','cancelled')`),
  check('pools_qty_check', sql`${table.targetQty} > 0 AND ${table.minQty} > 0 AND ${table.minQty} <= ${table.targetQty}`),
  check('pools_price_check', sql`${table.unitPricePaise} > 0`),
])

export const poolMembers = pgTable('pool_members', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  poolId: uuid('pool_id').references(() => pools.id, { onDelete: 'cascade' }).notNull(),
  msmeId: uuid('msme_id').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  qty: integer('qty').notNull(),
  // blocked | captured | released | failed
  paymentState: text('payment_state').default('blocked').notNull(),
  deliverySnapshot: jsonb('delivery_snapshot').notNull(),
  gstInvoice: jsonb('gst_invoice'),
  checkoutSessionId: uuid('checkout_session_id'),
  orderId: uuid('order_id'),
  payBy: timestamp('pay_by', { withTimezone: true }),
  pspRef: text('psp_ref'),
  committedAt: timestamp('committed_at', { withTimezone: true }).default(sql`now()`).notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  failedAt: timestamp('failed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (table) => [
  index('pool_members_pool_idx').on(table.poolId, table.paymentState),
  index('pool_members_msme_idx').on(table.msmeId),
  unique('pool_members_pool_msme_uniq').on(table.poolId, table.msmeId),
  check('pool_members_qty_check', sql`${table.qty} > 0`),
  check('pool_members_state_check', sql`${table.paymentState} IN ('blocked','captured','released','failed')`),
])

/** Append-only (trigger + revoked grants + read-only policies) — quote_events regime. */
export const poolEvents = pgTable('pool_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  poolId: uuid('pool_id').references(() => pools.id, { onDelete: 'cascade' }).notNull(),
  memberId: uuid('member_id').references(() => poolMembers.id, { onDelete: 'set null' }),
  actorId: uuid('actor_id').references(() => users.id),
  eventType: text('event_type').notNull(),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  index('pool_events_pool_idx').on(table.poolId, table.createdAt),
])
