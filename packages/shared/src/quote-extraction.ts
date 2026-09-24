import { z } from 'zod'
import { uuidSchema } from './schemas/index'
import { GST_RATE_BPS_OPTIONS } from './mart/catalog'
import { maskContactInfo } from './contact-mask'

/**
 * Quote extraction contract (BUILD_PROMPTS S1.1). A provider types or speaks a
 * quote in their own words; the `quote_extract@v1` prompt returns this object;
 * the SERVER clamps it (clampQuoteExtraction) and the provider confirms with
 * one Submit tap. Nothing here writes a quote: the only quote writer stays the
 * submit route, which records the confirmation in ai_decisions (feature
 * `quote_extraction`). Pure + zod only, shared by web, mobile, agent-core.
 */

export const QUOTE_EXTRACT_FIELDS = [
  'price',
  'unit_price',
  'delivery_days',
  'gst_included',
  'transport_included',
  'valid_until',
  'advance_percent',
  'gst_rate_bps',
  'hsn_code',
] as const
export type QuoteExtractField = (typeof QUOTE_EXTRACT_FIELDS)[number]
export const quoteExtractFieldSchema = z.enum(QUOTE_EXTRACT_FIELDS)

export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export const HSN_RE = /^\d{4}(?:\d{2})?(?:\d{2})?$/

export const quoteExtractionSchema = z.object({
  /** Services total in paise; null when per-unit / a range / conditional / absent. */
  price_paise: z.number().int().nonnegative().nullable(),
  /** Goods only (RFQ kind='goods'); else null. */
  unit_price_paise: z.number().int().nonnegative().nullable(),
  delivery_days: z.number().int().min(1).max(365).nullable(),
  /** "GST extra" → false; "inclusive of GST" → true; unsaid → null. */
  gst_included: z.boolean().nullable(),
  /** "transport at actuals" → false; "door delivery included" → true; unsaid → null. */
  transport_included: z.boolean().nullable(),
  /** Absolute ISO date; relative ("valid 7 days") resolved from the trusted `today`. */
  valid_until: z.string().regex(ISO_DATE_RE).nullable(),
  advance_percent: z.number().int().min(0).max(100).nullable(),
  /** Goods only; must be one of GST_RATE_BPS_OPTIONS after clamp. */
  gst_rate_bps: z.number().int().nullable(),
  /** Goods only. */
  hsn_code: z.string().regex(HSN_RE).nullable(),
  /** English, the provider's own words condensed; ranges / per-unit / conditions land here. */
  scope_summary: z.string().max(400),
  uncertain_fields: z.array(quoteExtractFieldSchema).max(QUOTE_EXTRACT_FIELDS.length),
})
export type QuoteExtraction = z.infer<typeof quoteExtractionSchema>

export const quoteExtractRequestSchema = z.object({
  text: z.string().trim().min(5).max(4000),
  source: z.enum(['typed', 'voice']).default('typed'),
})
export type QuoteExtractRequest = z.infer<typeof quoteExtractRequestSchema>

export const quoteExtractResponseSchema = z.object({
  extraction_id: uuidSchema,
  fields: quoteExtractionSchema,
  stub: z.boolean(),
})
export type QuoteExtractResponse = z.infer<typeof quoteExtractResponseSchema>

export type QuoteExtractKind = 'services' | 'goods'

// ── Stub producer (keyless / CI): schema-valid and visibly a stub ────────────

export function emptyExtraction(text: string): QuoteExtraction {
  return {
    price_paise: null,
    unit_price_paise: null,
    delivery_days: null,
    gst_included: null,
    transport_included: null,
    valid_until: null,
    advance_percent: null,
    gst_rate_bps: null,
    hsn_code: null,
    scope_summary: text.slice(0, 400),
    uncertain_fields: ['price', 'delivery_days'],
  }
}

// ── Contact-info scrub (the platform masks contact details pre-payment) ──────

/**
 * Remove (not mask) contact details from a model-drafted summary. Audit M30:
 * the same shared rule set as `redactContactInfo` (contact-mask.ts), with an
 * empty replacement and the whitespace tidied after.
 */
export function stripContactInfo(text: string): string {
  return maskContactInfo(text, { replacement: '' })
    .text.replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim()
}

// ── Server clamp (after the model, before storage) ───────────────────────────

export interface ClampContext {
  kind: QuoteExtractKind
  /** IST date, YYYY-MM-DD. */
  today: string
}

/**
 * Rules a model output can never override: kind-specific fields are forced
 * null, an off-slab GST rate is dropped, a past validity date is dropped (both
 * flagged uncertain), contact details are scrubbed from the summary, and the
 * uncertain list is deduplicated. Pure; the route stores the clamped object.
 */
export function clampQuoteExtraction(input: QuoteExtraction, ctx: ClampContext): QuoteExtraction {
  const out: QuoteExtraction = { ...input, uncertain_fields: [...input.uncertain_fields] }
  const flag = (k: QuoteExtractField) => {
    if (!out.uncertain_fields.includes(k)) out.uncertain_fields.push(k)
  }
  if (ctx.kind === 'services') {
    out.unit_price_paise = null
    out.gst_rate_bps = null
    out.hsn_code = null
  } else {
    // Goods: the server recomputes the total from qty × unit; a model total is never trusted.
    out.price_paise = null
  }
  if (out.gst_rate_bps != null && !(GST_RATE_BPS_OPTIONS as readonly number[]).includes(out.gst_rate_bps)) {
    out.gst_rate_bps = null
    flag('gst_rate_bps')
  }
  if (out.hsn_code != null && !HSN_RE.test(out.hsn_code)) {
    out.hsn_code = null
    flag('hsn_code')
  }
  if (out.valid_until != null && (!ISO_DATE_RE.test(out.valid_until) || out.valid_until < ctx.today)) {
    out.valid_until = null
    flag('valid_until')
  }
  if (out.price_paise === 0) out.price_paise = null
  if (out.unit_price_paise === 0) out.unit_price_paise = null
  out.scope_summary = stripContactInfo(out.scope_summary).slice(0, 400)
  out.uncertain_fields = [...new Set(out.uncertain_fields)]
  return out
}

// ── Edited-fields diff (the S1.1 success metric) ─────────────────────────────

export interface SubmittedQuoteTerms {
  price_paise?: number | null
  delivery_days?: number | null
  gst_included?: boolean | null
  transport_included?: boolean | null
  valid_until?: string | null
  advance_percent?: number | null
  goods?: { unit_price_paise?: number | null; gst_rate_bps?: number | null; hsn_code?: string | null } | null
}

/**
 * Which extracted fields the provider changed before submitting. null and
 * omitted count as equal. On a goods RFQ the services total is skipped (the
 * server computes it) and the goods terms are compared; on services the goods
 * fields are skipped.
 */
export function editedExtractFields(proposed: QuoteExtraction, final: SubmittedQuoteTerms, kind: QuoteExtractKind): QuoteExtractField[] {
  const n = (v: unknown) => (v === undefined ? null : v)
  const out: QuoteExtractField[] = []
  const cmp = (field: QuoteExtractField, a: unknown, b: unknown) => {
    if (n(a) !== n(b)) out.push(field)
  }
  if (kind === 'services') cmp('price', proposed.price_paise, final.price_paise)
  cmp('delivery_days', proposed.delivery_days, final.delivery_days)
  cmp('gst_included', proposed.gst_included, final.gst_included)
  cmp('transport_included', proposed.transport_included, final.transport_included)
  cmp('valid_until', proposed.valid_until, final.valid_until)
  cmp('advance_percent', proposed.advance_percent, final.advance_percent)
  if (kind === 'goods') {
    cmp('unit_price', proposed.unit_price_paise, final.goods?.unit_price_paise)
    cmp('gst_rate_bps', proposed.gst_rate_bps, final.goods?.gst_rate_bps)
    cmp('hsn_code', proposed.hsn_code, final.goods?.hsn_code)
  }
  return out
}
