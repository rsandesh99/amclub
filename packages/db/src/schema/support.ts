import { pgTable, uuid, text, timestamp, jsonb, boolean, integer, index, check, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './identity'
import { agentRuns, aiDecisions } from './engagement'
import { rfqs } from './rfq'
import { orders } from './orders'
import { waConversations } from './whatsapp'

// Support agent (0041, S2.3). A ticket is an escalation a human resolves;
// while it is open the agent stays quiet on that conversation / thread.
// `summary` / `suggested_next` are the model's OPS-FACING summary; the user
// only ever reads a template. One open ticket per (user, channel) — partial
// unique index in SQL. Service-role writes only; self + admin read.
export const supportTickets = pgTable('support_tickets', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').references(() => users.id).notNull(),
  role: text('role').notNull(), // buyer | provider
  channel: text('channel').notNull(), // whatsapp | web | mobile
  conversationId: uuid('conversation_id').references(() => waConversations.id, { onDelete: 'set null' }),
  threadId: uuid('thread_id').references((): AnyPgColumn => supportThreads.id, { onDelete: 'set null' }),
  orderId: uuid('order_id').references(() => orders.id),
  rfqId: uuid('rfq_id').references(() => rfqs.id),
  intent: text('intent'),
  reason: text('reason').notNull(),
  summary: text('summary'),
  suggestedNext: text('suggested_next'),
  status: text('status').default('open').notNull(), // SUPPORT_TICKET_STATUSES
  assignedTo: uuid('assigned_to').references(() => users.id),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: uuid('resolved_by').references(() => users.id),
  resolutionNote: text('resolution_note'),
  runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('support_tickets_status_created_idx').on(table.status, table.createdAt),
  index('support_tickets_user_created_idx').on(table.userId, table.createdAt),
  check('support_tickets_role_check', sql`${table.role} IN ('buyer', 'provider')`),
  check('support_tickets_channel_check', sql`${table.channel} IN ('whatsapp', 'web', 'mobile')`),
  check('support_tickets_status_check', sql`${table.status} IN ('open', 'in_progress', 'resolved')`),
])

// The web / mobile chat thread: intents + the unclear streak, never message text.
export const supportThreads = pgTable('support_threads', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').references(() => users.id).notNull(),
  role: text('role').notNull(),
  locale: text('locale').default('en').notNull(),
  lastIntents: jsonb('last_intents').default(sql`'[]'::jsonb`).notNull(),
  unclearStreak: integer('unclear_streak').default(0).notNull(),
  openTicketId: uuid('open_ticket_id').references((): AnyPgColumn => supportTickets.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('support_threads_user_idx').on(table.userId, table.createdAt),
  check('support_threads_role_check', sql`${table.role} IN ('buyer', 'provider')`),
])

// User text is stored contact-masked; assistant text is the rendered template; lookup_refs are ids only.
export const supportMessages = pgTable('support_messages', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  threadId: uuid('thread_id').references(() => supportThreads.id, { onDelete: 'cascade' }).notNull(),
  role: text('role').notNull(), // user | assistant | system
  body: text('body').notNull(),
  redacted: boolean('redacted').default(false).notNull(),
  intent: text('intent'),
  replyKey: text('reply_key'),
  lookupRefs: jsonb('lookup_refs'),
  runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  index('support_messages_thread_created_idx').on(table.threadId, table.createdAt),
  check('support_messages_role_check', sql`${table.role} IN ('user', 'assistant', 'system')`),
])

// The counterparty nudge ledger (spine): written by POST /orders/[id]/nudge and POST /rfq/[id]/nudge; the cap is a route check.
export const nudges = pgTable('nudges', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  subjectKind: text('subject_kind').notNull(), // order | rfq
  subjectId: uuid('subject_id').notNull(),
  fromUserId: uuid('from_user_id').references(() => users.id).notNull(),
  toUserId: uuid('to_user_id').references(() => users.id),
  runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  decisionId: uuid('decision_id').references(() => aiDecisions.id),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  index('nudges_subject_sender_created_idx').on(table.subjectKind, table.subjectId, table.fromUserId, table.createdAt),
  check('nudges_subject_kind_check', sql`${table.subjectKind} IN ('order', 'rfq')`),
])
