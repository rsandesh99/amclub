import { pgTable, uuid, text, timestamp, jsonb, integer, date, index, check, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users, msmeProfiles } from './identity'
import { agentRuns } from './engagement'
import { rfqs } from './rfq'
import { waConversations, waMessages } from './whatsapp'

// Buyer Procurement Agent (0045, S3.1; built dark). One session per buyer need the agent follows, from the draft to
// the closed request; the state machine is PROCUREMENT_SESSION_TRANSITIONS in @amclub/shared. One ACTIVE session per
// (user, rfq) — partial unique index. Service-role writes only (runtime + web routes after the session check); the
// buyer reads own, admin / ops read all; clients hold SELECT only.
export const procurementSessions = pgTable('procurement_sessions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').references(() => users.id).notNull(),
  msmeId: uuid('msme_id').references(() => msmeProfiles.id).notNull(),
  rfqId: uuid('rfq_id').references(() => rfqs.id),
  rootRunId: uuid('root_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  openRunId: uuid('open_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  conversationId: uuid('conversation_id').references(() => waConversations.id, { onDelete: 'set null' }),
  surface: text('surface').notNull(), // whatsapp | web | mobile
  state: text('state').default('drafting').notNull(), // PROCUREMENT_SESSION_STATES
  locale: text('locale').default('en').notNull(),
  title: text('title'),
  draft: jsonb('draft'),
  pending: jsonb('pending'),
  labels: jsonb('labels').default(sql`'{}'::jsonb`).notNull(),
  lastSeen: jsonb('last_seen').default(sql`'{}'::jsonb`).notNull(),
  proposalsToday: integer('proposals_today').default(0).notNull(),
  proposalsDate: date('proposals_date'),
  lastChaseAt: timestamp('last_chase_at', { withTimezone: true }),
  closeReason: text('close_reason'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('procurement_sessions_user_updated_idx').on(table.userId, table.updatedAt),
  index('procurement_sessions_state_idx').on(table.state).where(sql`${table.deletedAt} IS NULL`),
  uniqueIndex('procurement_sessions_active_user_rfq_uidx').on(table.userId, table.rfqId).where(sql`${table.rfqId} IS NOT NULL AND ${table.state} NOT IN ('closed', 'expired', 'failed') AND ${table.deletedAt} IS NULL`),
  check('procurement_sessions_surface_check', sql`${table.surface} IN ('whatsapp', 'web', 'mobile')`),
  check('procurement_sessions_state_check', sql`${table.state} IN ('drafting', 'awaiting_create', 'quality', 'live', 'quotes_in', 'chosen', 'closed', 'expired', 'failed')`),
  check('procurement_sessions_locale_check', sql`${table.locale} IN ('en', 'hi', 'te', 'ta')`),
])

// The thread the web mirror shows (WhatsApp + web turns). User bodies contact-masked; agent bodies = the rendered
// templates; `proposal` = refs only (run id, tool, status).
export const procurementTurns = pgTable('procurement_turns', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  sessionId: uuid('session_id').references(() => procurementSessions.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  role: text('role').notNull(), // user | agent | system
  surface: text('surface').notNull(),
  body: text('body'),
  waMessageId: uuid('wa_message_id').references(() => waMessages.id, { onDelete: 'set null' }),
  runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
  proposal: jsonb('proposal'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('procurement_turns_session_created_idx').on(table.sessionId, table.createdAt),
  index('procurement_turns_run_idx').on(table.runId).where(sql`${table.runId} IS NOT NULL`),
  check('procurement_turns_role_check', sql`${table.role} IN ('user', 'agent', 'system')`),
  check('procurement_turns_surface_check', sql`${table.surface} IN ('whatsapp', 'web', 'mobile')`),
])
