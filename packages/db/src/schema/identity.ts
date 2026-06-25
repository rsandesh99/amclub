import {
  pgTable, uuid, text, boolean, integer, timestamp, jsonb,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// auth.users FK is added via raw SQL in the migration (cross-schema reference)
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  phone: text('phone').unique().notNull(),
  email: text('email').unique(),
  fullName: text('full_name'),
  preferredLocale: text('preferred_locale').default('en').notNull(),
  roles: text('roles').array().default(sql`'{msme}'`).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})

export const msmeProfiles = pgTable('msme_profiles', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).unique().notNull(),
  businessName: text('business_name').notNull(),
  udyamNumber: text('udyam_number'),
  gstin: text('gstin'),
  udyamVerified: boolean('udyam_verified').default(false).notNull(),
  gstinVerified: boolean('gstin_verified').default(false).notNull(),
  sector: text('sector'),
  state: text('state').notNull(),
  city: text('city'),
  pincode: text('pincode'),
  employeeBand: text('employee_band'),
  membershipTier: text('membership_tier').default('free').notNull(),
  profileCompleteness: integer('profile_completeness').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
})

export const providerProfiles = pgTable('provider_profiles', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).unique().notNull(),
  legalName: text('legal_name').notNull(),
  displayName: text('display_name').notNull(),
  slug: text('slug').unique().notNull(),
  about: text('about'),
  logoUrl: text('logo_url'),
  gstin: text('gstin'),
  pan: text('pan'),
  state: text('state').notNull(),
  city: text('city'),
  languages: text('languages').array().default(sql`'{en}'`).notNull(),
  // pending_kyc | under_review | active | suspended | rejected
  status: text('status').default('pending_kyc').notNull(),
  avgRating: text('avg_rating').default('0.0').notNull(), // stored as text; cast numeric(2,1) in migration
  reviewCount: integer('review_count').default(0).notNull(),
  completedOrders: integer('completed_orders').default(0).notNull(),
  medianResponseMinutes: integer('median_response_minutes'),
  capacityPaused: boolean('capacity_paused').default(false).notNull(),
  topRated: boolean('top_rated').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
})

export const providerVerifications = pgTable('provider_verifications', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  providerId: uuid('provider_id').references(() => providerProfiles.id, { onDelete: 'cascade' }).notNull(),
  // gstin | pan | bank | icai | icsi | bar_council | msme_cert | ...
  kind: text('kind').notNull(),
  value: text('value').notNull(),
  documentUrl: text('document_url'),
  // pending | api_verified | manually_approved | rejected
  status: text('status').default('pending').notNull(),
  verifiedBy: uuid('verified_by').references(() => users.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  rejectionReason: text('rejection_reason'),
  apiResponse: jsonb('api_response'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})

export const providerBankAccounts = pgTable('provider_bank_accounts', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  providerId: uuid('provider_id').references(() => providerProfiles.id, { onDelete: 'cascade' }).unique().notNull(),
  accountNumberEnc: text('account_number_enc').notNull(), // pgcrypto-encrypted
  ifsc: text('ifsc').notNull(),
  accountHolder: text('account_holder').notNull(),
  pennyDropVerified: boolean('penny_drop_verified').default(false).notNull(),
  razorpayRouteAccountId: text('razorpay_route_account_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})
