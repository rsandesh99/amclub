import { z } from 'zod'
import { ORDER_STATUSES, RFQ_STATUSES, QUOTE_STATUSES, PAYOUT_STATUSES } from '../state-machines'
import { CATEGORY_SLUGS } from '../categories'

// ── Primitives ────────────────────────────────────────────────────────────────

/** Paise (integer). All money in the system is in this unit. §2.4 */
export const paiseSchema = z.number().int().positive()

/** UUID v4 */
export const uuidSchema = z.string().uuid()

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

export const localeSchema = z.enum(['en', 'hi'])
export type Locale = z.infer<typeof localeSchema>

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
  languages: z.array(localeSchema).min(1),
  category_slugs: z.array(z.enum(CATEGORY_SLUGS)).min(1),
})

export type ProviderOnboardingInput = z.infer<typeof providerOnboardingSchema>

// ── Package (service listing) ─────────────────────────────────────────────────

export const packageStatusSchema = z.enum(['draft', 'active', 'paused', 'removed'])

export const packageSchema = z.object({
  category_slug: z.enum(CATEGORY_SLUGS),
  title: z.string().min(5).max(200),
  scope_included: z.array(z.string()).min(1),
  scope_excluded: z.array(z.string()).optional(),
  deliverables: z.array(z.string()).min(1),
  price_paise: paiseSchema,
  discount_bps: z.number().int().min(0).max(9000).default(0),
  member_extra_discount_bps: z.number().int().min(0).max(5000).default(0),
  delivery_days: z.number().int().positive().max(365),
  revision_count: z.number().int().min(0).max(10).default(1),
  faqs: z
    .array(z.object({ question: z.string(), answer: z.string() }))
    .max(10)
    .optional(),
})

export type PackageInput = z.infer<typeof packageSchema>

// ── RFQ ───────────────────────────────────────────────────────────────────────

export const rfqSchema = z.object({
  category_slug: z.enum(CATEGORY_SLUGS),
  title: z.string().min(10).max(200),
  details: z.record(z.string(), z.unknown()),
  budget_min_paise: paiseSchema.optional(),
  budget_max_paise: paiseSchema.optional(),
  needed_by: z.string().date().optional(),
})

export type RfqInput = z.infer<typeof rfqSchema>

export const quoteSchema = z.object({
  rfq_id: uuidSchema,
  price_paise: paiseSchema,
  delivery_days: z.number().int().positive().max(365),
  scope: z.string().min(20).max(2000),
  message: z.string().max(500).optional(),
})

export type QuoteInput = z.infer<typeof quoteSchema>

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
