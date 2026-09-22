import { pgTable, uuid, text, timestamp, jsonb, boolean, bigint, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './identity'
import { rfqs } from './rfq'
import { aiDecisions } from './engagement'

// RFQ intake extractions (0038, S1.8) — agent-owned. One row per intake result
// the buyer was shown: the ONE clarifying question ('clarify'), a photo /
// text-PDF extraction ('document'), or a deterministic STEP / DXF summary
// ('drawing', model NULL). input_refs are references only; proposed is the
// schema-validated result. The Create tap on POST /api/v1/rfq links rows
// (rfq_id) and writes ONE ai_decisions row (feature rfq_intake) → decision_id.
export const rfqIntakeExtractions = pgTable('rfq_intake_extractions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid('user_id').references(() => users.id).notNull(),
  kind: text('kind').notNull(), // 'clarify' | 'document' | 'drawing'
  inputRefs: jsonb('input_refs').notNull(), // { attachment_path?, mime?, name?, audio_duration_ms?, transcript_chars?, gap? }
  proposed: jsonb('proposed').notNull(), // ClarifyQuestion | DocumentExtract | DrawingSummary
  model: text('model'),
  stub: boolean('stub').default(false).notNull(),
  costEstPaise: bigint('cost_est_paise', { mode: 'number' }),
  rfqId: uuid('rfq_id').references(() => rfqs.id),
  decisionId: uuid('decision_id').references(() => aiDecisions.id),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('rfq_intake_extractions_user_created_idx').on(table.userId, table.createdAt),
  index('rfq_intake_extractions_rfq_idx').on(table.rfqId),
  check('rfq_intake_extractions_kind_check', sql`${table.kind} IN ('clarify', 'document', 'drawing')`),
])
