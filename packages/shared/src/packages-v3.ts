import { z } from 'zod'

/**
 * Experience v3 E4 (PRD FR-4.1 / FR-4.5 / FR-4.6) — package tiers, the
 * government-dependency line and the "Most chosen" rule. ONE place for the
 * shapes the tier editor sends, the package page renders and the rig checks.
 */

export const PACKAGE_TIERS = ['basic', 'standard', 'premium'] as const
export type PackageTier = (typeof PACKAGE_TIERS)[number]
export const packageTierSchema = z.enum(PACKAGE_TIERS)

/** Display order of a tier (Basic first). */
export const tierRank = (t: PackageTier): number => PACKAGE_TIERS.indexOf(t)

export const COMPARE_ROWS_MAX = 12
export const IDEAL_FOR_MAX = 90
export const COMPARE_TEXT_MAX = 40

const i18nLine = (max: number) =>
  z.object({
    en: z.string().trim().min(1).max(max),
    hi: z.string().trim().max(max).optional(),
    te: z.string().trim().max(max).optional(),
    ta: z.string().trim().max(max).optional(),
  })

/** One row of the comparison matrix: a stable key + its label. */
export const compareRowSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,32}$/),
  labelI18n: i18nLine(60),
})
export type CompareRow = z.infer<typeof compareRowSchema>

/** A cell: included (✓), not included (—), or a short text ("3 days"). */
export const compareValueSchema = z.union([z.boolean(), z.string().trim().min(1).max(COMPARE_TEXT_MAX)])
export type CompareValue = z.infer<typeof compareValueSchema>

export const packageGroupTierInputSchema = z.object({
  packageId: z.string().uuid(),
  tier: packageTierSchema,
  /** "Choose this if…" (≤ 90 characters). */
  idealForI18n: i18nLine(IDEAL_FOR_MAX).nullable(),
  compareValues: z.record(z.string(), compareValueSchema),
})
export type PackageGroupTierInput = z.infer<typeof packageGroupTierInputSchema>

/** What the tier editor sends to POST /api/v1/partner/package-groups. */
export const packageGroupUpsertSchema = z
  .object({
    id: z.string().uuid().optional(),
    titleI18n: i18nLine(80),
    compareRows: z.array(compareRowSchema).max(COMPARE_ROWS_MAX),
    tiers: z.array(packageGroupTierInputSchema).min(2).max(3),
  })
  .superRefine((v, ctx) => {
    const rowKeys = new Set<string>()
    for (const r of v.compareRows) {
      if (rowKeys.has(r.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['compareRows'], message: 'duplicate_row' })
      rowKeys.add(r.key)
    }
    const tiers = new Set<string>()
    const pkgs = new Set<string>()
    for (const [i, t] of v.tiers.entries()) {
      if (tiers.has(t.tier)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tiers', i, 'tier'], message: 'duplicate_tier' })
      if (pkgs.has(t.packageId)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tiers', i, 'packageId'], message: 'duplicate_package' })
      tiers.add(t.tier)
      pkgs.add(t.packageId)
      for (const k of Object.keys(t.compareValues)) {
        if (!rowKeys.has(k)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tiers', i, 'compareValues', k], message: 'unknown_row' })
      }
    }
  })
export type PackageGroupUpsert = z.infer<typeof packageGroupUpsertSchema>

/** Stored compare_rows / compare_values are re-validated on read; bad data renders as no matrix. */
export const storedCompareRowsSchema = z.array(compareRowSchema).max(COMPARE_ROWS_MAX)
export const storedCompareValuesSchema = z.record(z.string(), compareValueSchema)

/**
 * FR-4.5 (N17): a package waits on a government portal when its own override
 * says so, else when its category does. `false` on the package wins.
 */
export function isGovtDependent(categoryGovtDependent: boolean | null | undefined, override: boolean | null | undefined): boolean {
  if (override === true || override === false) return override
  return categoryGovtDependent === true
}

/**
 * FR-4.6: "Most chosen" is computed from paid orders only, never set by the
 * provider. A tier earns it with at least half of the group's paid orders once
 * the group has at least MOST_CHOSEN_MIN_N of them. A tie never labels two.
 */
export const MOST_CHOSEN_MIN_N = 10
export function mostChosenTier(counts: Partial<Record<PackageTier, number>>): PackageTier | null {
  const entries = PACKAGE_TIERS.map((t) => [t, Math.max(0, Math.floor(counts[t] ?? 0))] as const)
  const n = entries.reduce((s, [, c]) => s + c, 0)
  if (n < MOST_CHOSEN_MIN_N) return null
  const winners = entries.filter(([, c]) => c * 2 >= n)
  return winners.length === 1 ? winners[0]![0] : null
}

/** Coarse order-value bucket for analytics (never the amount itself). */
export function totalBucket(totalPaise: number): string {
  const rupees = totalPaise / 100
  if (rupees < 1000) return 'lt_1k'
  if (rupees < 5000) return '1k_5k'
  if (rupees < 25000) return '5k_25k'
  if (rupees < 100000) return '25k_1l'
  return 'gte_1l'
}
