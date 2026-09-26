import { z } from 'zod'
import { ORDER_STATUSES, RFQ_STATUSES, QUOTE_STATUSES, PAYOUT_STATUSES } from '../state-machines'
import { CATEGORY_SLUGS } from '../categories'
import { SUPPORTED_LOCALES, PROVIDER_LANGUAGES } from '../locales'
import { goodsRfqSpecSchema, goodsQuoteTermsSchema } from '../mart/goods'
import { quoteDeclineReasonSchema } from '../decline-message'
import { rfqMustHavesSchema } from '../rfq-v3'
import { quoteOptionsSchema } from '../quote-options-schema'

// ── Primitives ────────────────────────────────────────────────────────────────

/** Paise (integer). All money in the system is in this unit. §2.4 */
export const paiseSchema = z.number().int().positive()

/** UUID v4 */
export const uuidSchema = z.string().uuid()

/**
 * Order document kinds (S1.2). The closed set of values a client may send —
 * the value reaches a storage object key, so it must never be free text.
 * 'requirement' | 'deliverable' | 'other' are the services set (schema-comment
 * parity; web sends 'deliverable', the route defaults 'other').
 * 'delivery_photo' | 'dispatch_photo' are reserved for AMC Mart goods evidence.
 */
export const ORDER_DOCUMENT_KINDS = [
  'requirement',
  'deliverable',
  'other',
  'delivery_photo',
  'dispatch_photo',
  // Services evidence engine (S0.3): staged milestone proof photos.
  'milestone_photo',
] as const
export type OrderDocumentKind = (typeof ORDER_DOCUMENT_KINDS)[number]
export const orderDocumentKindSchema = z.enum(ORDER_DOCUMENT_KINDS)

/** Indian phone number — 10 digits, optional +91 prefix */
export const phoneSchema = z
  .string()
  .regex(/^(?:\+91)?[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number')

export const gstinSchema = z
  .string()
  .regex(
    /^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1}$/,
    'Enter a valid 15-character GSTIN',
  )

export const udyamSchema = z
  .string()
  .regex(/^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/, 'Enter a valid Udyam registration number')

// ── Auth ──────────────────────────────────────────────────────────────────────

export const otpSendSchema = z.object({
  phone: phoneSchema,
})

export const otpVerifySchema = z.object({
  phone: phoneSchema,
  otp: z.string().length(6, 'OTP must be 6 digits'),
})

// ── User / profile ────────────────────────────────────────────────────────────

// UI locale (app infrastructure) — derived from the single SUPPORTED_LOCALES.
export const localeSchema = z.enum(SUPPORTED_LOCALES)
export type Locale = z.infer<typeof localeSchema>

// Spoken languages a provider declares (product data) — SEPARATE list by
// founder decision; may diverge from the UI locale set (S3, call a).
export const providerLanguageSchema = z.enum(PROVIDER_LANGUAGES)

export const userRoleSchema = z.enum(['msme', 'provider', 'admin', 'ops'])
export type UserRole = z.infer<typeof userRoleSchema>

export const sectorSchema = z.enum(['manufacturing', 'trade', 'services'])
export const employeeBandSchema = z.enum(['1-9', '10-49', '50-249'])

export const msmeProfileSchema = z.object({
  business_name: z.string().min(2).max(200),
  udyam_number: udyamSchema.optional(),
  gstin: gstinSchema.optional(),
  sector: sectorSchema.optional(),
  state: z.string().min(2),
  city: z.string().optional(),
  pincode: z
    .string()
    .regex(/^\d{6}$/, 'Enter a valid 6-digit pincode')
    .optional(),
  employee_band: employeeBandSchema.optional(),
  preferred_locale: localeSchema.default('en'),
})

export type MsmeProfileInput = z.infer<typeof msmeProfileSchema>

export const providerOnboardingSchema = z.object({
  legal_name: z.string().min(2).max(200),
  display_name: z.string().min(2).max(100),
  about: z.string().max(2000).optional(),
  gstin: gstinSchema,
  pan: z
    .string()
    .regex(/^[A-Z]{5}\d{4}[A-Z]{1}$/, 'Enter a valid PAN')
    .optional(),
  state: z.string().min(2),
  city: z.string().min(2),
  languages: z.array(providerLanguageSchema).min(1),
  category_slugs: z.array(z.enum(CATEGORY_SLUGS)).min(1),
})

export type ProviderOnboardingInput = z.infer<typeof providerOnboardingSchema>

// ── Package (service listing) ─────────────────────────────────────────────────

export const packageStatusSchema = z.enum(['draft', 'active', 'paused', 'removed'])

/** Listing bounds — the ONE rule the partner routes enforce and the listing wizard shows inline. */
export const PACKAGE_MAX_DISCOUNT_BPS = 9000
export const PACKAGE_MAX_MEMBER_DISCOUNT_BPS = 5000
export const PACKAGE_MAX_DELIVERY_DAYS = 365
export const PACKAGE_MAX_REVISIONS = 10

export const packageSchema = z.object({
  category_slug: z.enum(CATEGORY_SLUGS),
  title: z.string().min(5).max(200),
  scope_included: z.array(z.string().min(1)).min(1),
  scope_excluded: z.array(z.string().min(1)).optional(),
  deliverables: z.array(z.string().min(1)).min(1),
  /** Buyer-requirement prompts collected at checkout (free-text questions). */
  requirements: z.array(z.string().min(1)).max(15).optional(),
  price_paise: paiseSchema,
  discount_bps: z.number().int().min(0).max(PACKAGE_MAX_DISCOUNT_BPS).default(0),
  member_extra_discount_bps: z.number().int().min(0).max(PACKAGE_MAX_MEMBER_DISCOUNT_BPS).default(0),
  delivery_days: z.number().int().positive().max(PACKAGE_MAX_DELIVERY_DAYS),
  revision_count: z.number().int().min(0).max(PACKAGE_MAX_REVISIONS).default(1),
  faqs: z
    .array(z.object({ question: z.string().min(1), answer: z.string().min(1) }))
    .max(10)
    .optional(),
  /** publish → 'active'; save draft → 'draft'. */
  status: z.enum(['draft', 'active']).default('active'),
  /** Experience v3 E2 — the level-2 service (a SPECIALIZATIONS slug of the
   *  category; the route checks membership). Absent = leave unchanged. */
  service_slug: z.string().regex(/^[a-z0-9-]{1,48}$/).nullable().optional(),
})

export type PackageInput = z.infer<typeof packageSchema>

// ── RFQ ───────────────────────────────────────────────────────────────────────

export const rfqAttachmentSchema = z.object({
  url: z.string(),
  name: z.string().max(200),
})

// ── Voice RFQ (Phase 8b) ──────────────────────────────────────────────────────

/** Structured parse of a spoken requirement — the LLM's contract. A value the
 *  model can't map confidently comes back null (+ uncertain), never a guess. */
export const voiceParseSchema = z.object({
  category_slug: z.enum(CATEGORY_SLUGS).nullable(),
  /** One of SPECIALIZATIONS[category_slug] (curated vocabulary) or null. */
  specialization: z.string().max(60).nullable(),
  /** 2-letter Indian state code (INDIAN_STATES) or null. */
  state: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  description_english: z.string().min(1).max(2000),
  /** BCP-47 code from the STT vendor, e.g. 'te-IN'; 'unknown' when undetected. */
  original_language: z.string().max(16),
  uncertain: z.boolean(),
})
export type VoiceParse = z.infer<typeof voiceParseSchema>

// ── Voice RFQ v2 (S1.8) — one clarifying question, one round ─────────────────

/** The ONE question the buyer hears after an uncertain / incomplete parse. `gap` echoes the rule's input. */
export const clarifyQuestionSchema = z
  .object({
    question: z.string().min(5).max(200),
    /** Template field name, or 'category' | 'state' | 'scope'. */
    gap: z.string().max(60),
    locale: z.string().max(16),
  })
  .strict()
export type ClarifyQuestion = z.infer<typeof clarifyQuestionSchema>

/** Round two: what the client sends back with the answer (multipart field `prior`, JSON). */
export const voiceParsePriorSchema = z.object({
  transcript_english: z.string().max(4000),
  parse: voiceParseSchema,
  question: clarifyQuestionSchema,
  answer_text: z.string().max(1000).optional(),
})
export type VoiceParsePrior = z.infer<typeof voiceParsePriorSchema>

/** Persisted inside rfqs.voice_meta when a clarify round happened (or was skipped). */
export const voiceMetaClarifySchema = z.object({
  question: z.string().max(200),
  gap: z.string().max(60),
  answer_transcript: z.string().max(2000),
  answered_by: z.enum(['voice', 'text', 'skipped']),
})
export type VoiceMetaClarify = z.infer<typeof voiceMetaClarifySchema>

/** /api/v1/rfq/voice-parse response body. */
export const voiceParseResponseSchema = z.object({
  transcript_english: z.string(),
  parse: voiceParseSchema,
  /** True when a vendor ran in stub mode (no API key) — clients show a hint. */
  stub: z.boolean(),
  /** S1.8 — present ONLY on round one, flag on + cohort, when the rule found a gap. Never with `prior`. */
  clarify: clarifyQuestionSchema
    .extend({
      /** data:audio/… when clarify_tts_enabled and a TTS key exist (≤ 400 KB), else null. */
      audio_data_url: z.string().max(400_000).nullable(),
      extraction_id: uuidSchema,
    })
    .optional(),
})
export type VoiceParseResponse = z.infer<typeof voiceParseResponseSchema>

/** Persisted on rfqs.voice_meta for quality review + training signal (§8b). */
export const voiceMetaSchema = z.object({
  transcript_english: z.string().max(4000),
  parse: voiceParseSchema,
  duration_ms: z.number().int().positive().max(60_000),
  /** Form fields the user corrected after the parse pre-filled them. */
  edited_fields: z.array(z.string().max(40)).max(20).default([]),
  vendor: z.object({
    stt: z.string().max(40),
    parser: z.string().max(80),
  }),
  /** S1.8 — the clarify round, when one happened (or was skipped). */
  clarify: voiceMetaClarifySchema.optional(),
  /** ADR-030 §5 — where the voice came from. 'whatsapp' content never enters the corpus or eval sets (lib/corpus). */
  channel: z.enum(['web', 'mobile', 'whatsapp']).optional(),
})
export type VoiceMeta = z.infer<typeof voiceMetaSchema>

export const RFQ_KINDS = ['service', 'goods'] as const
export type RfqKind = (typeof RFQ_KINDS)[number]

export const rfqSchema = z
  .object({
    /** Absent = 'service' — every existing client keeps working unchanged. */
    kind: z.enum(RFQ_KINDS).default('service'),
    category_slug: z.enum(CATEGORY_SLUGS).optional(),
    title: z.string().min(10).max(200),
    details: z.record(z.string(), z.unknown()),
    attachments: z.array(rfqAttachmentSchema).max(5).default([]),
    budget_min_paise: paiseSchema.optional(),
    budget_max_paise: paiseSchema.optional(),
    needed_by: z.string().date().optional(),
    /** Present only when the RFQ began as a voice recording (Phase 8b). */
    voice_meta: voiceMetaSchema.optional(),
    /** S1.8 — rfq_intake_extractions rows (clarify / document / drawing) this RFQ was prefilled from; the Create tap confirms them. */
    intake_extraction_ids: z.array(uuidSchema).max(4).default([]),
    // AMC Mart M2 — goods RFQ: a Mart category + a goods spec instead of a services template.
    mart_category_slug: z.string().min(1).max(60).optional(),
    goods_spec: goodsRfqSpecSchema.optional(),
    /** Experience v3 E6 (FR-6.4): shown to providers; never used by fan-out (D-PRD6). Absent = none. */
    must_haves: rfqMustHavesSchema.optional(),
  })
  .superRefine((d, ctx) => {
    if (d.kind === 'goods') {
      if (!d.mart_category_slug) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mart_category_slug'], message: 'Required for a goods request' })
      if (!d.goods_spec) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['goods_spec'], message: 'Required for a goods request' })
    } else if (!d.category_slug) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['category_slug'], message: 'Required' })
    }
  })

export type RfqInput = z.infer<typeof rfqSchema>

export const quoteSchema = z.object({
  rfq_id: uuidSchema,
  price_paise: paiseSchema,
  delivery_days: z.number().int().positive().max(365),
  scope: z.string().min(20).max(2000),
  message: z.string().max(500).optional(),
  // Phase 4b — optional commercial terms. Omitted = "not stated" (NULL); the
  // buyer sees a neutral "ask before deciding" hint, never a blank.
  gst_included: z.boolean().optional(),
  transport_included: z.boolean().optional(),
  /** ISO date (YYYY-MM-DD). */
  valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
  advance_percent: z.number().int().min(0).max(100).optional(),
  /** AMC Mart M2 — present on a goods RFQ; the server recomputes price_paise from it. */
  goods: goodsQuoteTermsSchema.optional(),
  /** S1.1 — the quote_extractions row the provider confirmed with this submit (omitted = typed by hand). */
  extraction_id: uuidSchema.optional(),
  /** S2.2 — the Munshi draft this submit came from (delegated run → `approved`; the provider's own composer → `edited`). */
  munshi_draft_id: uuidSchema.optional(),
  /** E12b / ADR 020 — Economy / Express beside this (Standard) price; services only, behind quote_options_enabled. */
  options: quoteOptionsSchema.optional(),
})

export type QuoteInput = z.infer<typeof quoteSchema>

/**
 * S1.3 — quote revision (PATCH /rfq/[id]/quote). A revision RESTATES every
 * field: a partial patch is ambiguous with "not stated" (= NULL terms), so the
 * body is the full quote minus the RFQ id and the S1.1 extraction link (a
 * revision is never a confirmation). `.strict()` so a stray `extraction_id`
 * or `rfq_id` is a 422, not silently dropped. Goods-terms rules are the same
 * as on submit; the server recomputes `price_paise` for goods on both paths.
 */
export const quoteRevisionSchema = quoteSchema.omit({ rfq_id: true, extraction_id: true, munshi_draft_id: true }).strict()
export type QuoteRevisionInput = z.infer<typeof quoteRevisionSchema>

/** `quotes.revision` counts submissions: 1 = the original, so at most two revisions. */
export const MAX_QUOTE_REVISIONS = 3

/** S1.2 — buyer declines one quote with a reason (chose_other is reserved for the system path). */
export const quoteDeclineSchema = z.object({
  reason: quoteDeclineReasonSchema,
  /** The buyer's private words (never shown to the provider; used to write the courteous note). */
  note: z.string().trim().max(200).optional(),
})
export type QuoteDeclineInput = z.infer<typeof quoteDeclineSchema>

export const quoteDeclineResponseSchema = z.object({
  quoteId: uuidSchema,
  status: z.literal('declined'),
  message_pending: z.boolean(),
})
export type QuoteDeclineResponse = z.infer<typeof quoteDeclineResponseSchema>

/** A message on a quote thread (pre-payment; server masks contact info). */
export const quoteMessageSchema = z.object({
  body: z.string().min(1).max(1000),
})

export type QuoteMessageInput = z.infer<typeof quoteMessageSchema>

// ── Order ─────────────────────────────────────────────────────────────────────

export const orderStatusSchema = z.enum(ORDER_STATUSES)
export const rfqStatusSchema = z.enum(RFQ_STATUSES)
export const quoteStatusSchema = z.enum(QUOTE_STATUSES)
export const payoutStatusSchema = z.enum(PAYOUT_STATUSES)

export const orderTransitionSchema = z.object({
  order_id: uuidSchema,
  to_status: orderStatusSchema,
  reason: z.string().max(500).optional(),
})

// ── Checkout ──────────────────────────────────────────────────────────────────

export const checkoutSchema = z.object({
  package_id: uuidSchema.optional(),
  quote_id: uuidSchema.optional(),
  coupon_code: z.string().max(50).optional(),
}).refine((d) => d.package_id ?? d.quote_id, {
  message: 'Either package_id or quote_id is required',
})

// ── Review ────────────────────────────────────────────────────────────────────

export const reviewSchema = z.object({
  order_id: uuidSchema,
  rating: z.number().int().min(1).max(5),
  text: z.string().min(10).max(2000).optional(),
})

export type ReviewInput = z.infer<typeof reviewSchema>
