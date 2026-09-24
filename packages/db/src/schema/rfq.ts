import {
  pgTable, uuid, text, integer, timestamp, jsonb, bigint, date, boolean,
  index, unique, uniqueIndex, primaryKey,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { msmeProfiles, providerProfiles } from './identity'
import { categories } from './catalog'

export const rfqs = pgTable('rfqs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  msmeId: uuid('msme_id').references(() => msmeProfiles.id, { onDelete: 'cascade' }).notNull(),
  // Nullable since 0024 for kind='goods' only (CHECK rfqs_kind_shape_check).
  categoryId: uuid('category_id').references(() => categories.id),
  title: text('title').notNull(),
  details: jsonb('details').notNull(),
  attachments: jsonb('attachments').default(sql`'[]'::jsonb`).notNull(),
  budgetMinPaise: bigint('budget_min_paise', { mode: 'number' }),
  budgetMaxPaise: bigint('budget_max_paise', { mode: 'number' }),
  neededBy: date('needed_by'),
  // Phase 8b — transcript + parse when the RFQ began as a voice recording.
  voiceMeta: jsonb('voice_meta'),
  // AMC Mart M2 (0024, STAGED): service | goods. Goods RFQs carry a Mart
  // category + goods_spec instead of a services category/template.
  kind: text('kind').default('service').notNull(),
  martCategorySlug: text('mart_category_slug'),
  goodsSpec: jsonb('goods_spec'),
  // S1.2 (0033) — one-slot pointer cache { hash, locale, pointers, model, stub, created_at }.
  comparePointers: jsonb('compare_pointers'),
  comparePointersAt: timestamp('compare_pointers_at', { withTimezone: true }),
  // S1.5 (0035) — two-phase create. fanout_at NULL + status open = DEFERRED (derived, never a status);
  // backfilled to created_at for every pre-0035 row. releaseDeferredRfq is the only writer of fanout_at.
  fanoutAt: timestamp('fanout_at', { withTimezone: true }),
  qualityReport: jsonb('quality_report'), // RfqQualityReport the buyer saw
  qualityCheckedAt: timestamp('quality_checked_at', { withTimezone: true }),
  qualityDecision: text('quality_decision'), // answered | sent_as_is | auto_released | skipped (CHECK)
  qualityDecisionAt: timestamp('quality_decision_at', { withTimezone: true }),
  qualityDecisionId: uuid('quality_decision_id'), // FK → ai_decisions in SQL
  // Experience v3 E6 (0053) — { credentials, languages, onSite, inStateOnly }; shown to providers, not used by fan-out.
  mustHaves: jsonb('must_haves'),
  // E15 F3 (0062): typed CAD features from the deterministic STEP / DXF parse — never a model.
  cadFeatures: jsonb('cad_features'),
  // open | quoted | accepted | expired | cancelled
  status: text('status').default('open').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  maxQuotes: integer('max_quotes').default(7).notNull(),
  quoteCount: integer('quote_count').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('rfqs_msme_status_idx').on(table.msmeId, table.status),
  index('rfqs_category_status_idx').on(table.categoryId, table.status),
])

export const rfqMatches = pgTable('rfq_matches', {
  rfqId: uuid('rfq_id').references(() => rfqs.id, { onDelete: 'cascade' }).notNull(),
  providerId: uuid('provider_id').references(() => providerProfiles.id, { onDelete: 'cascade' }).notNull(),
  notifiedAt: timestamp('notified_at', { withTimezone: true }).default(sql`now()`).notNull(),
  viewedAt: timestamp('viewed_at', { withTimezone: true }),
  // S0.4 quote-or-decline (0029): a decline is an active decision, never silence.
  declinedAt: timestamp('declined_at', { withTimezone: true }),
  declineReason: text('decline_reason'), // DECLINE_REASONS | window_lapsed
}, (table) => [
  primaryKey({ columns: [table.rfqId, table.providerId] }),
])

export const quotes = pgTable('quotes', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  rfqId: uuid('rfq_id').references(() => rfqs.id, { onDelete: 'cascade' }).notNull(),
  providerId: uuid('provider_id').references(() => providerProfiles.id, { onDelete: 'cascade' }).notNull(),
  pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
  deliveryDays: integer('delivery_days').notNull(),
  scope: text('scope').notNull(),
  message: text('message'),
  // Phase 4a — optional commercial terms (0018). NULL = not stated.
  gstIncluded: boolean('gst_included'),
  transportIncluded: boolean('transport_included'),
  validUntil: date('valid_until'),
  // CHECK 0..100 when not null (quotes_advance_percent_range)
  advancePercent: integer('advance_percent'),
  // AMC Mart M2 (0024, STAGED) — goods terms; all NULL on services quotes.
  // CHECK quotes_goods_terms_check: complete set + price_paise = unit × qty.
  unitPricePaise: bigint('unit_price_paise', { mode: 'number' }),
  qty: integer('qty'),
  gstRateBps: integer('gst_rate_bps'),
  hsnCode: text('hsn_code'),
  productId: uuid('product_id'),
  // S1.1 (0032) — the confirmed quote_extractions row (FK in SQL; no import here to avoid a cycle).
  extractionId: uuid('extraction_id'),
  extractionConfirmedAt: timestamp('extraction_confirmed_at', { withTimezone: true }),
  // S1.2 (0033) — buyer decline: reason (QUOTE_DECLINE_REASONS ∪ another_quote_accepted), the
  // buyer's private note (column-privilege-hidden from clients), the delivered message.
  declineReason: text('decline_reason'),
  declineNote: text('decline_note'),
  declineMessage: text('decline_message'),
  declineMessageLocale: text('decline_message_locale'),
  declinedBy: text('declined_by'), // buyer | system
  declinedAt: timestamp('declined_at', { withTimezone: true }),
  declineDecisionId: uuid('decline_decision_id'), // FK → ai_decisions in SQL
  // S1.3 (0034) — in-place revision: counts submissions (1 = original, max 3); optimistic lock key.
  revision: integer('revision').default(1).notNull(),
  revisedAt: timestamp('revised_at', { withTimezone: true }),
  // S2.2 (0040) — the Munshi draft this quote came from; FK → munshi_drafts in SQL (circular import avoided here).
  munshiDraftId: uuid('munshi_draft_id'),
  // E12b / ADR 020 (0066) — the option the buyer paid for (NULL = Standard); FK → quote_options in SQL.
  selectedOptionId: uuid('selected_option_id'),
  // Audit M44 / L9 (0077) — the S3.4 group member this quote was written for (unique; FK → service_pool_members in
  // SQL). Set only by the pool close; never client-readable.
  poolMemberId: uuid('pool_member_id'),
  // submitted | withdrawn | accepted | declined | expired
  status: text('status').default('submitted').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (table) => [
  unique('quotes_rfq_provider_uniq').on(table.rfqId, table.providerId),
])

// Append-only lifecycle history for quotes (mirrors order_events); no updatedAt.
// Written alongside every quotes.status mutation — the status column is untouched.
export const quoteEvents = pgTable('quote_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  quoteId: uuid('quote_id').references(() => quotes.id, { onDelete: 'cascade' }).notNull(),
  // submitted | declined | withdrawn | accepted | expired | auto_declined | match_declined | revised | lost (0058, one per quote)
  eventType: text('event_type').notNull(),
  // acting user id, or 'system' for cron/payment-driven events
  actor: text('actor').default('system').notNull(),
  reason: text('reason'),
  payload: jsonb('payload'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
}, (table) => [
  index('quote_events_quote_idx').on(table.quoteId),
  index('quote_events_type_idx').on(table.eventType),
  // E7 (0058) — one loss label per quote.
  uniqueIndex('quote_events_lost_once').on(table.quoteId).where(sql`${table.eventType} = 'lost'`),
])

// S1.3 (0034) — RFQ clarification threads: a matched provider asks, the buyer
// answers in place; every matched provider reads the whole thread (the API
// never returns provider_id to a provider). Soft-deleted per §2.5 rule 4.
// "In clarification" is derived (rfqIsActive + open questions), never a status.
export const rfqClarifications = pgTable('rfq_clarifications', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  rfqId: uuid('rfq_id').references(() => rfqs.id, { onDelete: 'cascade' }).notNull(),
  providerId: uuid('provider_id').references(() => providerProfiles.id).notNull(),
  question: text('question').notNull(), // ≤ 500 (CHECK), stored after redactContactInfo
  questionRedacted: boolean('question_redacted').default(false).notNull(),
  answer: text('answer'), // ≤ 1000 (CHECK), stored after redactContactInfo
  answerRedacted: boolean('answer_redacted').default(false).notNull(),
  askedAt: timestamp('asked_at', { withTimezone: true }).default(sql`now()`).notNull(),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  answeredBy: uuid('answered_by'), // FK → users in SQL
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`).notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('rfq_clarifications_rfq_asked_idx').on(table.rfqId, table.askedAt),
])

// Experience v3 E6 (0053) — "documents you'll likely need" per category (+ service).
// Public read; only rows with reviewed_at are shown (content review gate).
export const serviceDocumentRequirements = pgTable('service_document_requirements', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  categorySlug: text('category_slug').notNull(),
  serviceSlug: text('service_slug'),
  docKey: text('doc_key').notNull(),
  labelI18n: jsonb('label_i18n').notNull(),
  required: boolean('required').default(false).notNull(),
  noteI18n: jsonb('note_i18n'),
  sortOrder: integer('sort_order').default(0).notNull(),
  reviewedBy: uuid('reviewed_by'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
})

// Experience v3 E6 N38 (0053) — median first-quote minutes per category × buyer state (90 days).
export const quoteSlaStats = pgTable('quote_sla_stats', {
  categorySlug: text('category_slug').notNull(),
  state: text('state').notNull(),
  medianMinutes: integer('median_minutes'),
  n: integer('n').default(0).notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).default(sql`now()`).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (table) => [
  primaryKey({ columns: [table.categorySlug, table.state] }),
])

// E12b / ADR 020 (0066) — Economy / Express per quote revision (the quote row is Standard). Immutable rows;
// service role only.
export const quoteOptions = pgTable('quote_options', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  quoteId: uuid('quote_id').references(() => quotes.id, { onDelete: 'cascade' }).notNull(),
  revision: integer('revision').notNull(),
  label: text('label').notNull(), // economy | express
  pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
  deliveryDays: integer('delivery_days').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('quote_options_quote_id_revision_label_key').on(table.quoteId, table.revision, table.label),
  index('quote_options_quote_idx').on(table.quoteId, table.revision),
])

// S3.4 / ADR 024 (0071) — demand aggregation for services. Group requests of buyers' own open RFQs, a provider's
// volume-tier offer (immutable tiers), and the close's per-member claim → ordinary quote. All service role only;
// FK → ai_decisions (members.decision_id) is in SQL.
export const servicePools = pgTable('service_pools', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  categoryId: uuid('category_id').references(() => categories.id).notNull(),
  serviceSlug: text('service_slug').notNull(),
  state: text('state').notNull(),
  status: text('status').default('forming').notNull(), // SERVICE_POOL_STATUSES (CHECK)
  minMembers: integer('min_members').notNull(),
  maxMembers: integer('max_members').notNull(),
  formBy: timestamp('form_by', { withTimezone: true }).notNull(),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  closesAt: timestamp('closes_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  cancelledReason: text('cancelled_reason'),
  // Audit L9 (0077) — the close's per-pool lease (compare-and-set; NULL or past = free).
  closeLeaseUntil: timestamp('close_lease_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('service_pools_live_key_uq').on(table.categoryId, table.serviceSlug, table.state).where(sql`status IN ('forming', 'open', 'closing')`),
  index('service_pools_status_idx').on(table.status, table.closesAt),
])

export const servicePoolOffers = pgTable('service_pool_offers', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  poolId: uuid('pool_id').references(() => servicePools.id, { onDelete: 'cascade' }).notNull(),
  providerId: uuid('provider_id').references(() => providerProfiles.id, { onDelete: 'cascade' }).notNull(),
  status: text('status').default('active').notNull(), // active | withdrawn
  deliveryDays: integer('delivery_days').notNull(),
  scope: text('scope').notNull(),
  message: text('message'),
  gstIncluded: boolean('gst_included').notNull(),
  transportIncluded: boolean('transport_included'),
  validUntil: date('valid_until').notNull(),
  advancePercent: integer('advance_percent'),
  achievedCount: integer('achieved_count'),
  achievedMinMembers: integer('achieved_min_members'),
  achievedPricePaise: bigint('achieved_price_paise', { mode: 'number' }),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('service_pool_offers_one_active_uq').on(table.poolId, table.providerId).where(sql`status = 'active'`),
  index('service_pool_offers_provider_idx').on(table.providerId, table.createdAt),
])

export const servicePoolOfferTiers = pgTable('service_pool_offer_tiers', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  offerId: uuid('offer_id').references(() => servicePoolOffers.id, { onDelete: 'cascade' }).notNull(),
  minMembers: integer('min_members').notNull(),
  pricePaise: bigint('price_paise', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('service_pool_offer_tiers_offer_id_min_members_key').on(table.offerId, table.minMembers),
])

export const servicePoolMembers = pgTable('service_pool_members', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  poolId: uuid('pool_id').references(() => servicePools.id, { onDelete: 'cascade' }).notNull(),
  rfqId: uuid('rfq_id').references(() => rfqs.id, { onDelete: 'cascade' }).notNull(),
  msmeId: uuid('msme_id').references(() => msmeProfiles.id, { onDelete: 'cascade' }).notNull(),
  status: text('status').default('invited').notNull(), // POOL_MEMBER_STATUSES (CHECK)
  joinedAt: timestamp('joined_at', { withTimezone: true }),
  decisionId: uuid('decision_id'),
  committedOfferId: uuid('committed_offer_id').references(() => servicePoolOffers.id, { onDelete: 'set null' }),
  committedAt: timestamp('committed_at', { withTimezone: true }),
  claimState: text('claim_state'), // claimed | skipped
  claimOfferId: uuid('claim_offer_id').references(() => servicePoolOffers.id, { onDelete: 'set null' }),
  skipReason: text('skip_reason'),
  quoteId: uuid('quote_id').references(() => quotes.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('service_pool_members_pool_id_rfq_id_key').on(table.poolId, table.rfqId),
  unique('service_pool_members_pool_id_msme_id_key').on(table.poolId, table.msmeId),
  uniqueIndex('service_pool_members_live_rfq_uq').on(table.rfqId).where(sql`status IN ('invited', 'joined')`),
  index('service_pool_members_msme_idx').on(table.msmeId, table.createdAt),
])

export const servicePoolEvents = pgTable('service_pool_events', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  poolId: uuid('pool_id').references(() => servicePools.id, { onDelete: 'cascade' }).notNull(),
  kind: text('kind').notNull(), // POOL_EVENT_KINDS (CHECK)
  actorUserId: uuid('actor_user_id'),
  payload: jsonb('payload').default(sql`'{}'::jsonb`).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('service_pool_events_pool_idx').on(table.poolId, table.createdAt),
])
