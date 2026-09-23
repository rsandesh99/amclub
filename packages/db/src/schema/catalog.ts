import {
  pgTable, uuid, text, boolean, integer, timestamp, jsonb, bigint, date,
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
  // Experience v3 N17 (0050): delivery waits on a government portal.
  govtDependent: boolean('govt_dependent').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})

export const providerCategories = pgTable('provider_categories', {
  providerId: uuid('provider_id').references(() => providerProfiles.id, { onDelete: 'cascade' }).notNull(),
  categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'cascade' }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.providerId, table.categoryId] }),
])

// Experience v3 N14 (0050): up to three packages of one provider shown as
// Basic / Standard / Premium with a comparison matrix (≤ 12 rows). Writes go
// through /api/v1/partner/package-groups (service role) only.
export const packageGroups = pgTable('package_groups', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  providerId: uuid('provider_id').references(() => providerProfiles.id, { onDelete: 'cascade' }).notNull(),
  categoryId: uuid('category_id').references(() => categories.id).notNull(),
  serviceSlug: text('service_slug'),
  titleI18n: jsonb('title_i18n').notNull(),
  compareRows: jsonb('compare_rows').default(sql`'[]'::jsonb`).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('package_groups_provider_idx').on(table.providerId),
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
  // Experience v3 N14 / N17 (0050): tier group membership, the "Choose this
  // if…" line, per-row comparison values, and the government override.
  groupId: uuid('group_id').references(() => packageGroups.id, { onDelete: 'set null' }),
  // basic | standard | premium
  tier: text('tier'),
  idealForI18n: jsonb('ideal_for_i18n'),
  compareValues: jsonb('compare_values'),
  govtDependentOverride: boolean('govt_dependent_override'),
  // Experience v3 E2 (0051): the level-2 service (shared SPECIALIZATIONS slug).
  serviceSlug: text('service_slug'),
  // E14 N32b (0061): which i18n slots are approved machine translations ({ title: { te: 'machine_approved' } }).
  i18nSources: jsonb('i18n_sources'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('packages_category_status_idx').on(table.categoryId, table.status),
  index('packages_provider_idx').on(table.providerId),
  unique('packages_provider_slug_uniq').on(table.providerId, table.slug),
  check('packages_price_positive', sql`${table.pricePaise} > 0`),
])

// Experience v3 E2 N6 (0051): "Did you find what you need?" — service role
// writes only; no client reads.
// E12a / ADR 019 (0065) — up to 3 active priced extras per package (trigger
// package_addons_limit). Public reads active rows of active packages; the
// provider reads their own; no client writes (the partner routes use the
// service role).
export const packageAddons = pgTable('package_addons', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  packageId: uuid('package_id').notNull().references(() => packages.id, { onDelete: 'cascade' }),
  labelI18n: jsonb('label_i18n').notNull(),
  pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
  daysDelta: integer('days_delta').default(0).notNull(),
  extraRevisions: integer('extra_revisions').default(0).notNull(),
  active: boolean('active').default(true).notNull(),
  sort: integer('sort').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [
  index('package_addons_package_idx').on(t.packageId).where(sql`deleted_at IS NULL`),
  check('package_addons_price_positive', sql`price_paise > 0`),
  check('package_addons_days_delta', sql`days_delta BETWEEN -30 AND 30`),
  check('package_addons_extra_revisions', sql`extra_revisions BETWEEN 0 AND 5`),
])

// E12c / ADR 021 (0067) — a package is a bundle when it has 2..6 milestones (shares sum to 10,000 bps, ≤ 92 days).
export const bundleMilestones = pgTable('bundle_milestones', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  packageId: uuid('package_id').notNull().references(() => packages.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  labelI18n: jsonb('label_i18n').notNull(),
  dueOffsetDays: integer('due_offset_days').notNull(),
  shareBps: integer('share_bps').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [unique('bundle_milestones_package_id_seq_key').on(t.packageId, t.seq)])

export const searchFeedback = pgTable('search_feedback', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id'),
  query: text('query'),
  filters: jsonb('filters').default(sql`'{}'::jsonb`).notNull(),
  resultIds: uuid('result_ids').array().default(sql`'{}'`).notNull(),
  helpful: boolean('helpful').notNull(),
  // not_relevant | too_expensive | too_slow | not_in_my_state
  reason: text('reason'),
  surface: text('surface').default('web').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})

// Experience v3 E2b N8 (0052): the last 20 provider / package pages a
// signed-in buyer opened. Owner-only RLS.
export const recentViews = pgTable('recent_views', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').notNull(),
  // provider | package
  kind: text('kind').notNull(),
  refId: uuid('ref_id').notNull(),
  viewedAt: timestamp('viewed_at', { withTimezone: true }).default(sql`now()`).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (table) => [
  unique('recent_views_user_ref_uniq').on(table.userId, table.kind, table.refId),
])

// Experience v3 E11 N29 (0056): daily views per provider profile / package — the
// top of the provider funnel. Written only by bump_view_count() (service role)
// from the rate-limited beacon; a provider reads only their own rows (RLS).
export const viewCountsDaily = pgTable('view_counts_daily', {
  subjectKind: text('subject_kind').notNull(),
  subjectId: uuid('subject_id').notNull(),
  providerId: uuid('provider_id').notNull(),
  day: date('day').notNull(),
  views: integer('views').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [primaryKey({ columns: [table.subjectKind, table.subjectId, table.day] })])
