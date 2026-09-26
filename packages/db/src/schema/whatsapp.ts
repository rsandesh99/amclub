import { pgTable, uuid, text, timestamp, jsonb, integer, bigint, boolean, index, check, primaryKey } from 'drizzle-orm/pg-core'
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
  // 0086 (ADR-030): Meta's business-scoped user id, the 72-hour free-entry window of a click-to-WhatsApp start, the first
  // referral (ad) it came from, and when the current user was bound (transcripts never show an earlier holder's messages)
  bsuid: text('bsuid'),
  entryWindowUntil: timestamp('entry_window_until', { withTimezone: true }),
  firstReferral: jsonb('first_referral'),
  boundAt: timestamp('bound_at', { withTimezone: true }),
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
  // 0086 (ADR-030) — the outbound ledger: one row per send, written BEFORE the vendor call under a unique idempotency key
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  notificationKind: text('notification_kind'),
  notificationId: uuid('notification_id'),
  runId: uuid('run_id'),
  idempotencyKey: text('idempotency_key'),
  templateLanguage: text('template_language'),
  category: text('category'), // utility | marketing | authentication | service
  errorCode: integer('error_code'),
  errorTitle: text('error_title'),
  billable: boolean('billable'),
  pricingCategory: text('pricing_category'),
  // 1/1000 paise (₹0.115 = 11 500), integers only (rule 6)
  costMillipaise: bigint('cost_millipaise', { mode: 'number' }),
  statusAt: timestamp('status_at', { withTimezone: true }),
  // W2: one speech-to-text transcript per voice note, cached
  transcript: text('transcript'),
  // retention: body / payload / media removed at this time unless legal_hold
  redactedAt: timestamp('redacted_at', { withTimezone: true }),
  legalHold: boolean('legal_hold').default(false).notNull(),
}, (table) => [
  index('wa_messages_conversation_created_idx').on(table.conversationId, table.createdAt),
  check('wa_messages_direction_check', sql`${table.direction} IN ('in', 'out')`),
])

// 0086 (ADR-030) — consent belongs to a phone and a purpose. Append-only events (the proof) + the current state,
// written together only by record_wa_consent() (service role).
export const waConsentEvents = pgTable('wa_consent_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  phoneE164: text('phone_e164').notNull(),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  purpose: text('purpose').notNull(), // transactional | assistant | marketing
  action: text('action').notNull(), // opt_in | opt_out
  source: text('source').notNull(),
  noticeVersion: text('notice_version'),
  keyword: text('keyword'),
  vendorMessageId: text('vendor_message_id'),
  locale: text('locale'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
})

export const waPhoneConsents = pgTable('wa_phone_consents', {
  phoneE164: text('phone_e164').notNull(),
  purpose: text('purpose').notNull(),
  status: text('status').notNull(), // opted_in | opted_out
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  lastEventId: uuid('last_event_id').references(() => waConsentEvents.id).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [primaryKey({ columns: [table.phoneE164, table.purpose] })])

// Delivery-driven suppression from error codes (not on WhatsApp, stopped marketing, blocked).
export const waSuppressions = pgTable('wa_suppressions', {
  phoneE164: text('phone_e164').primaryKey(),
  reason: text('reason').notNull(),
  errorCode: integer('error_code'),
  until: timestamp('until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
})

// The template registry mirrored from Meta (category, approval, rejection reason).
export const waTemplates = pgTable('wa_templates', {
  name: text('name').notNull(),
  language: text('language').notNull(),
  category: text('category'),
  status: text('status').default('unknown').notNull(),
  rejectionReason: text('rejection_reason'),
  metaTemplateId: text('meta_template_id'),
  components: jsonb('components'),
  quality: text('quality'),
  syncedAt: timestamp('synced_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [primaryKey({ columns: [table.name, table.language] })])

// Account-level webhooks (template status / category, phone quality, account updates), stored as received.
export const waAccountEvents = pgTable('wa_account_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  field: text('field').notNull(),
  entryId: text('entry_id'),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
})
