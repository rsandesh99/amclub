import { pgTable, uuid, text, integer, timestamp, date, index, primaryKey, unique } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { msmeProfiles, users } from './identity'
import { orders } from './orders'

// Experience v3 E9b (0054; FR-9.5, N45 / F7; gated by D-PRD5, dark behind
// agent_settings.obligations_enabled). The buyer's licences, what a provider
// recorded on a registration order, the once-per-threshold reminder ledger and
// the obligations checklist rules (only CA-reviewed rows are readable).

export const buyerLicences = pgTable('buyer_licences', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  msmeId: uuid('msme_id').references(() => msmeProfiles.id).notNull(),
  licenceType: text('licence_type').notNull(),
  licenceNumber: text('licence_number'),
  issuedOn: date('issued_on'),
  expiresOn: date('expires_on'),
  authority: text('authority'),
  certificatePath: text('certificate_path'),
  // manual | order
  source: text('source').default('manual').notNull(),
  orderId: uuid('order_id').references(() => orders.id),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('buyer_licences_msme_idx').on(table.msmeId),
  index('buyer_licences_expiry_idx').on(table.expiresOn),
])

export const orderLicenceFacts = pgTable('order_licence_facts', {
  orderId: uuid('order_id').primaryKey().references(() => orders.id),
  licenceType: text('licence_type').notNull(),
  licenceNumber: text('licence_number').notNull(),
  issuedOn: date('issued_on'),
  expiresOn: date('expires_on'),
  authority: text('authority'),
  recordedBy: uuid('recorded_by').references(() => users.id).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
})

export const licenceReminders = pgTable('licence_reminders', {
  licenceId: uuid('licence_id').references(() => buyerLicences.id).notNull(),
  thresholdDays: integer('threshold_days').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).default(sql`now()`).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [primaryKey({ columns: [table.licenceId, table.thresholdDays] })])

export const obligationRules = pgTable('obligation_rules', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  activity: text('activity'),
  state: text('state'),
  sizeBand: text('size_band'),
  licenceType: text('licence_type').notNull(),
  categorySlug: text('category_slug').notNull(),
  sourceUrl: text('source_url').notNull(),
  reviewedBy: text('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [unique('obligation_rules_uniq').on(table.activity, table.state, table.sizeBand, table.licenceType)])
