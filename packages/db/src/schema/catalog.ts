import {
  pgTable, uuid, text, boolean, integer, timestamp, jsonb, bigint,
  index, unique, primaryKey, customType, check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { providerProfiles } from './identity'

// tsvector custom type (trigger-maintained, GIN-indexed)
const tsvector = customType<{ data: string }>({
  dataType() { return 'tsvector' },
})

export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  parentId: uuid('parent_id').references((): AnyPgColumn => categories.id),
  slug: text('slug').unique().notNull(),
  nameI18n: jsonb('name_i18n').notNull(),
  descriptionI18n: jsonb('description_i18n'),
  icon: text('icon'),
  commissionBps: integer('commission_bps').default(1000).notNull(),
  requiredCredentials: text('required_credentials').array().default(sql`'{}'`).notNull(),
  rfqTemplate: jsonb('rfq_template'),
  sortOrder: integer('sort_order'),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})

export const providerCategories = pgTable('provider_categories', {
  providerId: uuid('provider_id').references(() => providerProfiles.id, { onDelete: 'cascade' }).notNull(),
  categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'cascade' }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.providerId, table.categoryId] }),
])

export const packages = pgTable('packages', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  providerId: uuid('provider_id').references(() => providerProfiles.id, { onDelete: 'cascade' }).notNull(),
  categoryId: uuid('category_id').references(() => categories.id).notNull(),
  slug: text('slug').notNull(),
  titleI18n: jsonb('title_i18n').notNull(),
  scopeIncluded: jsonb('scope_included').notNull(),
  scopeExcluded: jsonb('scope_excluded'),
  deliverables: jsonb('deliverables').notNull(),
  requirementsTemplate: jsonb('requirements_template'),
  pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
  discountBps: integer('discount_bps').default(0).notNull(),
  memberExtraDiscountBps: integer('member_extra_discount_bps').default(0).notNull(),
  deliveryDays: integer('delivery_days').notNull(),
  revisionCount: integer('revision_count').default(1).notNull(),
  faqs: jsonb('faqs'),
  // draft | active | paused | removed
  status: text('status').default('active').notNull(),
  searchTsv: tsvector('search_tsv'), // trigger-maintained; GIN index added in migration
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('packages_category_status_idx').on(table.categoryId, table.status),
  index('packages_provider_idx').on(table.providerId),
  unique('packages_provider_slug_uniq').on(table.providerId, table.slug),
  check('packages_price_positive', sql`${table.pricePaise} > 0`),
])
