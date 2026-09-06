import {
  pgTable, uuid, text, integer, timestamp, jsonb, bigint, date, index,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users, msmeProfiles, providerProfiles } from './identity'
import { packages } from './catalog'
import { quotes } from './rfq'

// order_number default (generate_order_number()) is set in migration SQL
export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orderNumber: text('order_number').unique().notNull(),
  msmeId: uuid('msme_id').references(() => msmeProfiles.id).notNull(),
  providerId: uuid('provider_id').references(() => providerProfiles.id).notNull(),
  // package | quote
  source: text('source').notNull(),
  packageId: uuid('package_id').references(() => packages.id),
  quoteId: uuid('quote_id').references(() => quotes.id),
  title: text('title').notNull(),
  scopeSnapshot: jsonb('scope_snapshot').notNull(),
  pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
  discountPaise: bigint('discount_paise', { mode: 'number' }).default(0).notNull(),
  gstPaise: bigint('gst_paise', { mode: 'number' }).notNull(),
  totalPaise: bigint('total_paise', { mode: 'number' }).notNull(),
  commissionBps: integer('commission_bps').notNull(),
  commissionPaise: bigint('commission_paise', { mode: 'number' }).notNull(),
  providerEarningPaise: bigint('provider_earning_paise', { mode: 'number' }).notNull(),
  deliveryDays: integer('delivery_days').notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }),
  // §3.7 state machine — transitions enforced by API
  status: text('status').default('placed').notNull(),
  revisionUsed: integer('revision_used').default(0).notNull(),
  revisionMax: integer('revision_max'),
  cancelledReason: text('cancelled_reason'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  autoAcceptAt: timestamp('auto_accept_at', { withTimezone: true }),
  // LOCK 5 (§3.7) — set while an in_progress order is blocked on a government/
  // external portal. Display sub-state only; status stays in_progress.
  externalWaitSince: timestamp('external_wait_since', { withTimezone: true }),
  // S2.1 (0020) — 'service' | 'goods'. Default covers every services writer.
  kind: text('kind').default('service').notNull(),
  // AMC Mart (0022) — goods orders only: frozen line items
  // [{ product_id, name, unit, qty, tier_min_qty, tier_unit_price_paise,
  //    hsn_code, gst_rate_bps, line_taxable_paise, line_gst_paise }]
  // and the delivery/pickup snapshot. NULL on every services order.
  lineItems: jsonb('line_items'),
  deliverySnapshot: jsonb('delivery_snapshot'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('orders_msme_status_idx').on(table.msmeId, table.status),
  index('orders_provider_status_idx').on(table.providerId, table.status),
])

// Append-only audit timeline; no updatedAt
export const orderEvents = pgTable('order_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }).notNull(),
  actorId: uuid('actor_id').references(() => users.id),
  event: text('event').notNull(),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  index('order_events_order_idx').on(table.orderId),
])

export const orderMilestones = pgTable('order_milestones', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }).notNull(),
  title: text('title').notNull(),
  status: text('status').default('pending').notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  sort: integer('sort').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})

// No updatedAt — documents are immutable once uploaded
export const orderDocuments = pgTable('order_documents', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }).notNull(),
  uploadedBy: uuid('uploaded_by').references(() => users.id).notNull(),
  fileUrl: text('file_url').notNull(),
  fileName: text('file_name').notNull(),
  mime: text('mime').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  // requirement | deliverable | other
  kind: text('kind').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
})

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }).notNull(),
  razorpayOrderId: text('razorpay_order_id').unique(),
  razorpayPaymentId: text('razorpay_payment_id').unique(),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  method: text('method'),
  // created | authorized | captured | refunded | failed
  status: text('status').notNull(),
  webhookPayload: jsonb('webhook_payload'),
  idempotencyKey: text('idempotency_key').unique().notNull(),
  // §9.1 — TCS under GST Sec 52; readiness column, computed pre-live.
  tcsPaise: bigint('tcs_paise', { mode: 'number' }).default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})

// Order intent — frozen amounts locked at checkout; the webhook materialises the
// order from this row (checkout never creates the order). §2.5 webhook-as-truth.
export const checkoutSessions = pgTable('checkout_sessions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  razorpayOrderId: text('razorpay_order_id').unique(),
  msmeId: uuid('msme_id').references(() => msmeProfiles.id).notNull(),
  providerId: uuid('provider_id').references(() => providerProfiles.id).notNull(),
  source: text('source').notNull(),
  packageId: uuid('package_id').references(() => packages.id),
  quoteId: uuid('quote_id').references(() => quotes.id),
  title: text('title').notNull(),
  scopeSnapshot: jsonb('scope_snapshot').notNull(),
  pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
  discountPaise: bigint('discount_paise', { mode: 'number' }).default(0).notNull(),
  gstPaise: bigint('gst_paise', { mode: 'number' }).notNull(),
  totalPaise: bigint('total_paise', { mode: 'number' }).notNull(),
  commissionBps: integer('commission_bps').notNull(),
  commissionPaise: bigint('commission_paise', { mode: 'number' }).notNull(),
  providerEarningPaise: bigint('provider_earning_paise', { mode: 'number' }).notNull(),
  deliveryDays: integer('delivery_days').notNull(),
  revisionMax: integer('revision_max'),
  couponCode: text('coupon_code'),
  gstInvoice: jsonb('gst_invoice'),
  // S2.1 (0020) + AMC Mart (0022): same three goods columns as orders —
  // materialize_order copies them verbatim into the order row.
  kind: text('kind').default('service').notNull(),
  lineItems: jsonb('line_items'),
  deliverySnapshot: jsonb('delivery_snapshot'),
  idempotencyKey: text('idempotency_key').unique().notNull(),
  // created | materialized | failed | expired
  status: text('status').default('created').notNull(),
  orderId: uuid('order_id').references(() => orders.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (table) => [
  index('checkout_sessions_rzp_order_idx').on(table.razorpayOrderId),
  index('checkout_sessions_msme_idx').on(table.msmeId),
])

export const refunds = pgTable('refunds', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'cascade' }).notNull(),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  reason: text('reason'),
  razorpayRefundId: text('razorpay_refund_id').unique(),
  // pending | processed — 'pending' is inserted BEFORE the gateway call (0017)
  status: text('status').default('pending').notNull(),
  // Deterministic per order (rfnd_<order_id>); unique where not null (0017).
  idempotencyKey: text('idempotency_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})

export const payouts = pgTable('payouts', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  providerId: uuid('provider_id').references(() => providerProfiles.id).notNull(),
  orderId: uuid('order_id').references(() => orders.id).unique().notNull(),
  amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
  // scheduled | processing | paid | failed | held
  status: text('status').default('scheduled').notNull(),
  scheduledFor: date('scheduled_for'),
  razorpayTransferId: text('razorpay_transfer_id'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  // AMC Mart (0022) — TDS on goods vendor payments (§2): config-driven from
  // mart_settings.tds (CA sets rates), recorded per payout. NULL on services.
  tdsSection: text('tds_section'),
  tdsBps: integer('tds_bps'),
  tdsPaise: bigint('tds_paise', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})

export const disputes = pgTable('disputes', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  orderId: uuid('order_id').references(() => orders.id, { onDelete: 'cascade' }).unique().notNull(),
  raisedBy: uuid('raised_by').references(() => users.id).notNull(),
  reason: text('reason').notNull(),
  details: text('details'),
  // open | under_review | resolved
  status: text('status').default('open').notNull(),
  // refund_full | refund_partial | release
  resolution: text('resolution'),
  resolutionAmountPaise: bigint('resolution_amount_paise', { mode: 'number' }),
  resolvedBy: uuid('resolved_by').references(() => users.id),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
})
