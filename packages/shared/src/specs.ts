import { z } from 'zod'
import { i18nTextSchema, pickI18n } from './i18n-text'

/**
 * E15 FR-15.1 (F3) — typed specs.
 *
 * `mfgSpecSchema`: the optional manufacturing block of a job-work requirement
 * (`rfqs.details.mfg_spec`). `packageDeliverableSchema`: a package's "What
 * you'll get" row — typed `{ label_i18n, format }`, or the older free-text
 * string (prose stays the fallback; both render through `deliverableLabel`).
 */
export const MFG_PROCESSES = ['cnc_machining', 'sheet_metal', 'fabrication', 'casting', 'forging', 'injection_moulding', '3d_printing', 'other'] as const
export const MFG_INSPECTION = ['none', 'visual', 'dimensional_report', 'first_article', 'third_party'] as const
export const mfgSpecSchema = z.object({
  process: z.enum(MFG_PROCESSES).optional(),
  material: z.string().trim().max(80).optional(),
  tolerance: z.string().trim().max(40).optional(),
  finish: z.string().trim().max(80).optional(),
  inspection: z.enum(MFG_INSPECTION).optional(),
}).strict()
export type MfgSpec = z.infer<typeof mfgSpecSchema>

export const DELIVERABLE_FORMATS = ['pdf', 'xlsx', 'docx', 'certificate', 'filing_ack', 'registration', 'other'] as const
export const typedDeliverableSchema = z.object({ label_i18n: i18nTextSchema, format: z.enum(DELIVERABLE_FORMATS).optional() }).strict()
export const packageDeliverableSchema = z.union([z.string().trim().min(1).max(200), typedDeliverableSchema])
export type PackageDeliverable = z.infer<typeof packageDeliverableSchema>

/** The row's text in the reader's language (a typed row picks its slot; a string row is the provider's prose). */
export function deliverableLabel(d: unknown, locale: string): string | null {
  const p = packageDeliverableSchema.safeParse(d)
  if (!p.success) return null
  return typeof p.data === 'string' ? p.data : pickI18n(p.data.label_i18n, locale)
}
export function deliverableFormat(d: unknown): (typeof DELIVERABLE_FORMATS)[number] | null {
  const p = typedDeliverableSchema.safeParse(d)
  return p.success ? (p.data.format ?? null) : null
}
