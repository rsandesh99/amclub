import { pgTable, uuid, text, timestamp, jsonb, boolean, bigint, index, uniqueIndex, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './identity'
import { orders, disputes } from './orders'
import { agentRuns, aiDecisions } from './engagement'

// Party statements (0037, S1.7) — SPINE, not agent. One per party on an open
// dispute (unique (dispute_id, role)), contact-masked, ≤ 5 of the order's own
// documents, editable until a triage exists. Service-role writes after the
// party check; parties + admin read.
export const disputeStatements = pgTable('dispute_statements', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  disputeId: uuid('dispute_id').references(() => disputes.id, { onDelete: 'cascade' }).notNull(),
  orderId: uuid('order_id').references(() => orders.id).notNull(),
  authorUserId: uuid('author_user_id').references(() => users.id).notNull(),
  role: text('role').notNull(), // buyer | provider
  body: text('body').notNull(), // ≤ 2000 (CHECK), stored after redactContactInfo
  redacted: boolean('redacted').default(false).notNull(),
  documentIds: uuid('document_ids').array().default(sql`'{}'`).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('dispute_statements_party_uniq').on(table.disputeId, table.role),
  index('dispute_statements_dispute_idx').on(table.disputeId),
  check('dispute_statements_role_check', sql`${table.role} IN ('buyer', 'provider')`),
])

// Dispute triages (0037, S1.7) — agent-owned; mirrors payout_dossiers. One row
// per triage run: checks, the strict card, cost, then the founder's decision
// written once (trigger) by the EXISTING resolve route when passed a triage_id.
export const disputeTriages = pgTable('dispute_triages', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  disputeId: uuid('dispute_id').references(() => disputes.id).notNull(),
  orderId: uuid('order_id').references(() => orders.id).notNull(),
  runId: uuid('run_id').references(() => agentRuns.id),
  kind: text('kind').notNull(), // 'service' | 'goods'
  checks: jsonb('checks').notNull(), // TriageCheck[]
  triage: jsonb('triage').notNull(), // DisputeTriage (strict)
  modelCostPaise: bigint('model_cost_paise', { mode: 'number' }).default(0).notNull(),
  stub: boolean('stub').default(false).notNull(),
  decision: text('decision'), // 'refund_full' | 'refund_partial' | 'release' | null
  decidedBy: uuid('decided_by').references(() => users.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionId: uuid('decision_id').references(() => aiDecisions.id),
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  uniqueIndex('dispute_triages_dispute_run_uniq').on(table.disputeId, table.runId),
  index('dispute_triages_dispute_created_idx').on(table.disputeId, table.createdAt),
  check('dispute_triages_kind_check', sql`${table.kind} IN ('service', 'goods')`),
  check('dispute_triages_decision_check', sql`${table.decision} IS NULL OR ${table.decision} IN ('refund_full', 'refund_partial', 'release')`),
])
