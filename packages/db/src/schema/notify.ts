import { pgTable, uuid, text, timestamp, jsonb, boolean, smallint, index, primaryKey } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './identity'
import { notifications } from './engagement'

// 0087 (ADR-030 §4–§6) — the notification outbox, preferences, reminder claims and DPDP requests. Server-written only;
// users read their own preferences, settings and requests.

export const notificationPreferences = pgTable('notification_preferences', {
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  category: text('category').notNull(),
  channel: text('channel').notNull(), // email | sms | whatsapp | push
  enabled: boolean('enabled').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.category, table.channel] })])

export const notificationSettings = pgTable('notification_settings', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  quietStartMin: smallint('quiet_start_min'),
  quietEndMin: smallint('quiet_end_min'),
  pausedUntil: timestamp('paused_until', { withTimezone: true }),
  digestLeads: boolean('digest_leads').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
})

export const notificationOutbox = pgTable('notification_outbox', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  notificationId: uuid('notification_id').references(() => notifications.id, { onDelete: 'set null' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }).notNull(),
  kind: text('kind').notNull(),
  channel: text('channel').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').default('queued').notNull(), // queued | sending | sent | failed | skipped | deferred | fallback
  attempts: smallint('attempts').default(0).notNull(),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).default(sql`now()`).notNull(),
  claimedUntil: timestamp('claimed_until', { withTimezone: true }),
  lastError: text('last_error'),
  detail: text('detail'),
  fallbackOf: uuid('fallback_of'),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [index('notification_outbox_user_idx').on(table.userId, table.createdAt)])

export const notificationReminders = pgTable('notification_reminders', {
  kind: text('kind').notNull(),
  entityId: uuid('entity_id').notNull(),
  stage: text('stage').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [primaryKey({ columns: [table.kind, table.entityId, table.stage] })])

export const dpdpRequests = pgTable('dpdp_requests', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  phoneE164: text('phone_e164'),
  kind: text('kind').notNull(), // access | correction | erasure | withdrawal | grievance | nomination
  source: text('source').notNull(), // web | mobile | whatsapp | email | admin
  status: text('status').default('open').notNull(), // open | in_progress | done | rejected
  details: text('details'),
  resolution: text('resolution'),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
})
