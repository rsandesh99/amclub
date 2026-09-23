import { pgTable, text, timestamp, jsonb, integer, bigint, check, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// Fair price ranges (0046, S3.2). AGGREGATES ONLY: no id column of any kind (no surrogate key, no provider / buyer /
// order / quote reference) — the unique key (category, specialization, scope, state, version) is the identity. Written
// nightly by cron/benchmark-compute through replace_price_benchmarks() (one transaction); any signed-in user reads;
// clients hold SELECT only. The formula is BENCHMARK_VERSION in @amclub/shared.
export const priceBenchmarks = pgTable('price_benchmarks', {
  categorySlug: text('category_slug').notNull(),
  specialization: text('specialization'), // always null in v1 (rfqs carry no specialization yet)
  scope: text('scope').notNull(), // 'state' | 'national'
  state: text('state'),
  unit: text('unit').default('job').notNull(),
  version: text('version').notNull(),
  sampleN: integer('sample_n').notNull(),
  providersN: integer('providers_n').notNull(),
  buyersN: integer('buyers_n').notNull(),
  p25Paise: bigint('p25_paise', { mode: 'number' }).notNull(),
  p50Paise: bigint('p50_paise', { mode: 'number' }).notNull(),
  p75Paise: bigint('p75_paise', { mode: 'number' }).notNull(),
  medianDeliveryDays: integer('median_delivery_days'),
  p25DeliveryDays: integer('p25_delivery_days'),
  p75DeliveryDays: integer('p75_delivery_days'),
  windowDays: integer('window_days').notNull(),
  notes: jsonb('notes'), // { computed_at, by_locale: { en: '…' } } — the cached benchmark_explain sentence
  computedAt: timestamp('computed_at', { withTimezone: true }).default(sql`now()`).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  uniqueIndex('price_benchmarks_key_uidx').on(table.categorySlug, sql`(COALESCE(${table.specialization}, ''))`, table.scope, sql`(COALESCE(${table.state}, ''))`, table.version),
  check('price_benchmarks_percentiles_check', sql`${table.p25Paise} > 0 AND ${table.p25Paise} <= ${table.p50Paise} AND ${table.p50Paise} <= ${table.p75Paise}`),
  check('price_benchmarks_scope_state_check', sql`(${table.scope} = 'state') = (${table.state} IS NOT NULL)`),
  check('price_benchmarks_gate_floor_check', sql`${table.sampleN} >= 30 AND ${table.providersN} >= 8 AND ${table.buyersN} >= 8`),
])
