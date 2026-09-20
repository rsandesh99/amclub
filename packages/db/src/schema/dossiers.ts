import { pgTable, uuid, text, timestamp, jsonb, bigint, index, uniqueIndex, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './identity'
import { orders, payouts, orderDocuments } from './orders'
import { providerProfiles } from './identity'
import { agentRuns, aiDecisions } from './engagement'

// Payout dossiers (0031, S1.4). One row per Payout-Evidence agent run on a
// held payout: deterministic checks, vision findings, anomalies and the RULE
// recommendation; then the founder's decision (written ONCE — trigger
// payout_dossiers_decision_once). Service-role writes only (runtime + the two
// decision routes); admin/ops read. Approve never lives here alone: it is the
// founder's tap on the release route, which also closes the dossier.
export const payoutDossiers = pgTable('payout_dossiers', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orderId: uuid('order_id').references(() => orders.id).notNull(),
  payoutId: uuid('payout_id').references(() => payouts.id),
  runId: uuid('run_id').references(() => agentRuns.id),
  kind: text('kind').notNull(), // 'service' | 'goods'
  checks: jsonb('checks').notNull(), // DossierCheck[]
  anomalies: text('anomalies').array().default(sql`'{}'`).notNull(),
  photoFindings: jsonb('photo_findings').default(sql`'[]'::jsonb`).notNull(), // PhotoFinding[]
  recommendation: text('recommendation').notNull(), // 'approve' | 'hold'
  rationale: text('rationale').array().default(sql`'{}'`).notNull(),
  modelCostPaise: bigint('model_cost_paise', { mode: 'number' }).default(0).notNull(),
  decision: text('decision'), // 'approve' | 'hold' | null (pending)
  decisionNote: text('decision_note'),
  decidedBy: uuid('decided_by').references(() => users.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionId: uuid('decision_id').references(() => aiDecisions.id),
  // Founder notification sent once per dossier (idempotent notify route).
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  uniqueIndex('payout_dossiers_order_run_uniq').on(table.orderId, table.runId),
  index('payout_dossiers_order_idx').on(table.orderId),
  index('payout_dossiers_created_idx').on(table.createdAt),
  check('payout_dossiers_kind_check', sql`${table.kind} IN ('service', 'goods')`),
  check('payout_dossiers_recommendation_check', sql`${table.recommendation} IN ('approve', 'hold')`),
  check('payout_dossiers_decision_check', sql`${table.decision} IS NULL OR ${table.decision} IN ('approve', 'hold')`),
])

// dHash per evidence photo (0031). Agent-owned telemetry: lets the dossier
// agent detect a photo re-used across a provider's orders. Admin read only.
export const evidencePhotoHashes = pgTable('evidence_photo_hashes', {
  docId: uuid('doc_id').primaryKey().references(() => orderDocuments.id, { onDelete: 'cascade' }),
  orderId: uuid('order_id').references(() => orders.id).notNull(),
  providerId: uuid('provider_id').references(() => providerProfiles.id).notNull(),
  dhash: text('dhash').notNull(), // 16 hex chars (64-bit)
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  index('evidence_photo_hashes_provider_dhash_idx').on(table.providerId, table.dhash),
])
