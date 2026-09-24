import { z } from 'zod'
import type { DrawingSummary } from './intake'
import type { RfqMustHaves } from './rfq-v3'

/**
 * E15 FR-15.5 (F10) — shadow predictions: a model (rules first) predicts, the
 * prediction is logged, the real outcome resolves it, and the error is measured
 * — shown to nobody but the admin console. A feature ships only when its
 * measured error is acceptable. `recordShadow` / `resolveShadow`
 * (apps/web/lib/shadow) are the only writers; each feature is switched on by
 * `agent_settings.shadow_<feature>_enabled` (default off). Subject ids only —
 * never personal data. Kept 24 months.
 */
export const SHADOW_FEATURES = ['cad_price_band', 'provider_fit'] as const
export type ShadowFeature = (typeof SHADOW_FEATURES)[number]
export const SHADOW_MODEL_VERSION: Record<ShadowFeature, string> = { cad_price_band: 'cad-band-rules-v1', provider_fit: 'fit-rules-v1' }
export const SHADOW_RETENTION_MONTHS = 24

// ── F3 — typed CAD features (deterministic, from the shared drawings/ parse; never a model) ──────────────
export const cadFeaturesSchema = z.object({
  format: z.enum(['step', 'dxf']),
  units: z.string().max(16).nullable(),
  bbox_mm: z.tuple([z.number(), z.number(), z.number()]).nullable(),
  hole_estimate: z.number().int().nonnegative().nullable(),
  counts: z.record(z.string(), z.number().int().nonnegative()),
}).strict()
export type CadFeatures = z.infer<typeof cadFeaturesSchema>

export function cadFeaturesFromDrawing(s: DrawingSummary): CadFeatures {
  return { format: s.format, units: s.units, bbox_mm: s.bbox_mm, hole_estimate: s.hole_estimate, counts: s.counts }
}

// ── The CAD price band (rules v1): size class × hole complexity. A baseline to beat, never shown. ───────
const BAND_BASE_PAISE = { small: 2_000_00, medium: 8_000_00, large: 25_000_00, unknown: 6_000_00 } as const
export function cadPriceBand(f: CadFeatures): { lowPaise: number; highPaise: number; basis: { sizeClass: keyof typeof BAND_BASE_PAISE; holes: number } } {
  const [x, y, z] = f.bbox_mm ?? [0, 0, 0]
  const volume = Math.abs(x * y * z)
  const sizeClass: keyof typeof BAND_BASE_PAISE = !f.bbox_mm ? 'unknown' : volume < 1e5 ? 'small' : volume < 1e7 ? 'medium' : 'large'
  const holes = Math.min(f.hole_estimate ?? 0, 40)
  const mid = BAND_BASE_PAISE[sizeClass] * (1 + 0.05 * holes)
  const round = (p: number) => Math.round(p / 100_00) * 100_00 // whole ₹100
  return { lowPaise: round(mid * 0.7), highPaise: round(mid * 1.4), basis: { sizeClass, holes } }
}
/** 0 inside the band; outside, the distance to the nearest edge as a share of the actual price. */
export function cadBandError(band: { lowPaise: number; highPaise: number }, actualPaise: number): number {
  if (actualPaise <= 0) return 1
  if (actualPaise >= band.lowPaise && actualPaise <= band.highPaise) return 0
  const edge = actualPaise < band.lowPaise ? band.lowPaise : band.highPaise
  return Math.round((Math.abs(edge - actualPaise) / actualPaise) * 1000) / 1000
}

// ── Provider fit % (rules v1): what fan-out already knows beyond "in category, in state". ───────────────
export interface FitInput {
  providerLanguages: readonly string[]
  providerCredentials: readonly string[]
  mustHaves: RfqMustHaves | null
  completedOrders: number
  avgRating: number | null
  reviewCount: number
  nextAvailableOn: string | null
  todayIst: string
}
export function providerFitRules(i: FitInput): { fitPct: number; reasons: string[] } {
  let fit = 40 // matched = in category and in state
  const reasons = ['category_state']
  const langs = i.mustHaves?.languages ?? []
  if (langs.length === 0 || langs.some((l) => i.providerLanguages.includes(l))) { fit += 15; reasons.push('language') }
  const creds = i.mustHaves?.credentials ?? []
  if (creds.length === 0 || creds.every((c) => i.providerCredentials.includes(c))) { fit += 15; reasons.push('credentials') }
  if (i.completedOrders >= 5) { fit += 10; reasons.push('track_record') }
  if (i.avgRating !== null && i.reviewCount >= 3 && i.avgRating >= 4.5) { fit += 10; reasons.push('rating') }
  if (!i.nextAvailableOn || i.nextAvailableOn <= addDays(i.todayIst, 3)) { fit += 10; reasons.push('available') }
  return { fitPct: Math.min(100, fit), reasons }
}
/** |predicted − outcome|, outcome 1 when the provider quoted (the fit's claim), else 0. */
export function fitError(fitPct: number, actual: { quoted: boolean }): number {
  return Math.round(Math.abs(fitPct / 100 - (actual.quoted ? 1 : 0)) * 1000) / 1000
}
function addDays(isoDay: string, n: number): string {
  return new Date(Date.parse(`${isoDay}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
}

/** Weekly error buckets for the admin console (IST weeks, newest first). */
export function weeklyShadowReport(rows: readonly { created_at: string; resolved_at: string | null; error: number | null }[], nowIso: string, weeks = 8): { weekStart: string; predicted: number; resolved: number; meanError: number | null }[] {
  const now = Date.parse(nowIso)
  const out: { weekStart: string; predicted: number; resolved: number; meanError: number | null }[] = []
  for (let w = 0; w < weeks; w++) {
    const end = now - w * 7 * 86_400_000
    const start = end - 7 * 86_400_000
    const inWeek = rows.filter((r) => { const t = Date.parse(r.created_at); return t > start && t <= end })
    const errs = inWeek.filter((r) => r.resolved_at && r.error !== null).map((r) => Number(r.error))
    out.push({ weekStart: new Date(start + 5.5 * 3600e3).toISOString().slice(0, 10), predicted: inWeek.length, resolved: errs.length, meanError: errs.length ? Math.round((errs.reduce((a, b) => a + b, 0) / errs.length) * 1000) / 1000 : null })
  }
  return out
}
