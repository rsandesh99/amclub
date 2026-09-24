import { pgTable, uuid, text, timestamp, jsonb, integer, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './identity'

// WhatsApp rails (0030, S0.5). One conversation per phone (E.164 digits, no
// '+'), bound to a user when the phone matches users.phone. Service-role
// writes only (runtime webhook + web dispatcher); admin/ops read.
// 0079 (audit M41): the binding holds only while users.phone IS this phone — the
// trigger users_phone_change_wa_unbind unbinds it (and revokes the WhatsApp grants
// given from the old number) when the phone changes; the runtime re-derives the
// owner on every inbound message.
export const waConversations = pgTable('wa_conversations', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  phoneE164: text('phone_e164').notNull().unique(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  locale: text('locale').default('en').notNull(),
  lastInboundAt: timestamp('last_inbound_at', { withTimezone: true }),
  lastOutboundAt: timestamp('last_outbound_at', { withTimezone: true }),
  windowOpenUntil: timestamp('window_open_until', { withTimezone: true }),
  lastHoldingReplyAt: timestamp('last_holding_reply_at', { withTimezone: true }),
  // 0036 (S1.6): the dispatcher's O(1) route to the active onboarding session (FK in SQL; no import cycle here).
  activeSessionId: uuid('active_session_id'),
  // S2.3 (0041) — the open support ticket (the agent stays quiet while set), the classifier's last intents, the unclear streak
  supportTicketId: uuid('support_ticket_id'),
  supportLastIntents: jsonb('support_last_intents').default(sql`'[]'::jsonb`).notNull(),
  supportUnclearStreak: integer('support_unclear_streak').default(0).notNull(),
  // S3.1 (0045) — the dispatcher's O(1) route to the buyer's active procurement session (FK in SQL; no import cycle here)
  procurementSessionId: uuid('procurement_session_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  index('wa_conversations_user_idx').on(table.userId),
])

// Every inbound/outbound message; idempotent on vendor_message_id (webhook
// replays are no-ops). Media bytes live in the private wa-media bucket.
export const waMessages = pgTable('wa_messages', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  conversationId: uuid('conversation_id').references(() => waConversations.id, { onDelete: 'cascade' }).notNull(),
  direction: text('direction').notNull(), // in | out
  vendorMessageId: text('vendor_message_id').unique(),
  kind: text('kind').notNull(), // text | audio | image | document | button | template | unknown
  body: text('body'),
  mediaRef: text('media_ref'),
  mime: text('mime'),
  templateName: text('template_name'),
  status: text('status').default('received').notNull(), // sent | delivered | read | failed | received | stub
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  // 0079 (audit M33): when the wa.inbound job finished. The webhook inserts NULL; the runtime's minute sweep
  // re-enqueues inbound rows still NULL after a minute. Default now(): every other writer's row counts as processed.
  processedAt: timestamp('processed_at', { withTimezone: true }).default(sql`now()`),
}, (table) => [
  index('wa_messages_conversation_created_idx').on(table.conversationId, table.createdAt),
  check('wa_messages_direction_check', sql`${table.direction} IN ('in', 'out')`),
])
