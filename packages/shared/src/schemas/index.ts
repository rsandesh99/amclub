import { z } from 'zod'
import { ORDER_STATUSES, RFQ_STATUSES, QUOTE_STATUSES, PAYOUT_STATUSES } from '../state-machines'
import { CATEGORY_SLUGS } from '../categories'
import { SUPPORTED_LOCALES, PROVIDER_LANGUAGES } from '../locales'
import { goodsRfqSpecSchema, goodsQuoteTermsSchema } from '../mart/goods'

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

export const packageSchema = z.object({
  category_slug: z.enum(CATEGORY_SLUGS),
  title: z.string().min(5).max(200),
  scope_included: z.array(z.string().min(1)).min(1),
  scope_excluded: z.array(z.string().min(1)).optional(),
  deliverables: z.array(z.string().min(1)).min(1),
  /** Buyer-requirement prompts collected at checkout (free-text questions). */
  requirements: z.array(z.string().min(1)).max(15).optional(),
  price_paise: paiseSchema,
  discount_bps: z.number().int().min(0).max(9000).default(0),
  member_extra_discount_bps: z.number().int().min(0).max(5000).default(0),
  delivery_days: z.number().int().positive().max(365),
  revision_count: z.number().int().min(0).max(10).default(1),
  faqs: z
    .array(z.object({ question: z.string().min(1), answer: z.string().min(1) }))
    .max(10)
    .optional(),
  /** publish → 'active'; save draft → 'draft'. */
  status: z.enum(['draft', 'active']).default('active'),
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

/** /api/v1/rfq/voice-parse response body. */
export const voiceParseResponseSchema = z.object({
  transcript_english: z.string(),
  parse: voiceParseSchema,
  /** True when a vendor ran in stub mode (no API key) — clients show a hint. */
  stub: z.boolean(),
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
    // AMC Mart M2 — goods RFQ: a Mart category + a goods spec instead of a services template.
    mart_category_slug: z.string().min(1).max(60).optional(),
    goods_spec: goodsRfqSpecSchema.optional(),
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
})

export type QuoteInput = z.infer<typeof quoteSchema>

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
