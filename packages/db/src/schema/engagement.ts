import {
  pgTable, uuid, text, boolean, integer, timestamp, jsonb, bigint,
  unique, primaryKey, check, index,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users, msmeProfiles, providerProfiles } from './identity'
import { categories } from './catalog'
import { orders } from './orders'

export const reviews = pgTable('reviews', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }).unique().notNull(),
  msmeId: uuid('msme_id').references(() => msmeProfiles.id).notNull(),
  providerId: uuid('provider_id').references(() => providerProfiles.id).notNull(),
  rating: integer('rating').notNull(),
  text: text('text'),
  providerReply: text('provider_reply'),
  // published | flagged | removed
  status: text('status').default('published').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (table) => [
  check('reviews_rating_range', sql`${table.rating} between 1 and 5`),
])

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  // order | quote
  contextType: text('context_type').notNull(),
  contextId: uuid('context_id').notNull(),
  msmeId: uuid('msme_id').references(() => msmeProfiles.id).notNull(),
  providerId: uuid('provider_id').references(() => providerProfiles.id).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (table) => [
  unique('conversations_context_uniq').on(table.contextType, table.contextId),
])

// No updatedAt — messages are immutable; only redacted flag changes
export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }).notNull(),
  senderId: uuid('sender_id').references(() => users.id).notNull(),
  body: text('body').notNull(),
  attachments: jsonb('attachments').default(sql`'[]'::jsonb`).notNull(),
  redacted: boolean('redacted').default(false).notNull(),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
})

export const savedProviders = pgTable('saved_providers', {
  msmeId: uuid('msme_id').references(() => msmeProfiles.id, { onDelete: 'cascade' }).notNull(),
  providerId: uuid('provider_id').references(() => providerProfiles.id, { onDelete: 'cascade' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  primaryKey({ columns: [table.msmeId, table.providerId] }),
])

export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  kind: text('kind').notNull(),
  titleI18n: jsonb('title_i18n').notNull(),
  bodyI18n: jsonb('body_i18n').notNull(),
  link: text('link'),
  channels: text('channels').array().default(sql`'{}'`).notNull(),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
})

export const coupons = pgTable('coupons', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  code: text('code').unique().notNull(),
  // percent | fixed
  kind: text('kind').notNull(),
  valueBps: integer('value_bps').notNull(),
  maxDiscountPaise: bigint('max_discount_paise', { mode: 'number' }),
  categoryId: uuid('category_id').references(() => categories.id),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
  validTo: timestamp('valid_to', { withTimezone: true }).notNull(),
  usageLimit: integer('usage_limit'),
  usedCount: integer('used_count').default(0).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})

export const couponRedemptions = pgTable('coupon_redemptions', {
  couponId: uuid('coupon_id').references(() => coupons.id).notNull(),
  orderId: uuid('order_id').references(() => orders.id).notNull(),
  msmeId: uuid('msme_id').references(() => msmeProfiles.id).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  primaryKey({ columns: [table.couponId, table.orderId] }),
])

export const invoices = pgTable('invoices', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }).notNull(),
  number: text('number').unique().notNull(),
  // buyer_invoice | commission_invoice
  kind: text('kind').notNull(),
  pdfUrl: text('pdf_url'),
  gstinSnapshot: jsonb('gstin_snapshot'),
  totals: jsonb('totals').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
})

// Append-only; no updatedAt. ip stored as text (Drizzle has no native inet type)
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  actorId: uuid('actor_id').references(() => users.id),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  ip: text('ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
})

// Append-only AI telemetry (Phase 8b v1.1) — one row per model call. Written
// via service role only; RLS enabled with no policies. cost_est_paise is an
// estimate (env-driven rates); raw vendor usage lives in meta.
export const aiInvocations = pgTable('ai_invocations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  feature: text('feature').notNull(),
  step: text('step').notNull(), // 'stt' | 'parse'
  vendor: text('vendor').notNull(),
  status: text('status').notNull(), // 'ok' | 'error' | 'stub'
  latencyMs: integer('latency_ms').notNull(),
  costEstPaise: bigint('cost_est_paise', { mode: 'number' }),
  inputBytes: integer('input_bytes'),
  outputChars: integer('output_chars'),
  requestId: text('request_id'),
  error: text('error'),
  meta: jsonb('meta'),
  // H0 (0026): routing attribution + token counts; all nullable.
  runId: uuid('run_id'),
  taskClass: text('task_class'), // AGENT_TASK_CLASSES
  tier: text('tier'), // AGENT_TIERS
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  index('ai_invocations_feature_created_idx').on(table.feature, table.createdAt),
  index('ai_invocations_status_created_idx').on(table.status, table.createdAt),
])

// H0 agent groundwork (0026, ADR-008). One run per agent task per user;
// status per AGENT_RUN_TRANSITIONS. Service-role writes only; self + admin read.
export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  persona: text('persona').notNull(), // AGENT_PERSONAS
  status: text('status').default('running').notNull(), // AGENT_RUN_STATUSES
  surface: text('surface').notNull(), // 'web' | 'mobile' | 'whatsapp' | 'phone'
  subjectType: text('subject_type'),
  subjectId: uuid('subject_id'),
  costEstPaise: bigint('cost_est_paise', { mode: 'number' }).default(0).notNull(),
  inputTokens: integer('input_tokens').default(0).notNull(),
  outputTokens: integer('output_tokens').default(0).notNull(),
  error: text('error'),
  meta: jsonb('meta'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [
  index('agent_runs_user_created_idx').on(table.userId, table.createdAt),
  check('agent_runs_persona_check', sql`${table.persona} IN ('buyer', 'provider', 'ops')`),
  check('agent_runs_status_check', sql`${table.status} IN ('running', 'awaiting_confirmation', 'completed', 'failed', 'cancelled')`),
])

// Append-only trace of a run (trigger + REVOKE like order_events).
export const agentEvents = pgTable('agent_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'cascade' }).notNull(),
  kind: text('kind').notNull(), // AGENT_EVENT_KINDS
  tool: text('tool'), // AGENT_TOOLS name for tool_* / confirmation_* events
  actor: text('actor').default('agent').notNull(), // 'agent' | 'user' | 'system'
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  index('agent_events_run_created_idx').on(table.runId, table.createdAt),
  check('agent_events_actor_check', sql`${table.actor} IN ('agent', 'user', 'system')`),
])

export const cmsBanners = pgTable('cms_banners', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  slot: text('slot').notNull(),
  // 'image' | 'hero'. Hero banners render styled copy instead of an image.
  variant: text('variant').default('image').notNull(),
  imageUrl: text('image_url'), // required only for variant='image'
  link: text('link'),
  // Hero-variant content (editable from /admin/cms — no code change). i18n {en,hi}.
  headline: jsonb('headline'),
  subline: jsonb('subline'),
  ctaLabel: jsonb('cta_label'),
  ctaHref: text('cta_href'),
  discountPct: integer('discount_pct'),
  locale: text('locale'),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})
