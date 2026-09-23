/**
 * Experience v3 E4 (PRD FR-4.1 / 4.5 / 4.6) — the tier group a package belongs
 * to, the government-dependency flag and the "Most chosen" label, for the
 * package page. Public reads through the anon client (RLS: active providers
 * only); the "Most chosen" counts use the admin client and return ONE tier
 * label, never order data.
 *
 * Every column read here arrived in migration 0050. Each read is separate and
 * error-tolerant, so code deployed ahead of the migration renders the page
 * exactly as before (no tiers, no government line).
 */
import 'server-only'
import {
  isGovtDependent,
  mostChosenTier,
  ORDER_UNCHOSEN_STATUSES,
  priceDisplay,
  storedCompareRowsSchema,
  storedCompareValuesSchema,
  packageTierSchema,
  tierRank,
  type CompareRow,
  type CompareValue,
  type PackageTier,
  type PriceDisplay,
} from '@amclub/shared'
import { createPublicClient, createAdminClient } from '@/lib/supabase/server'
import type { I18nText } from './types'

export interface TierOption {
  packageId: string
  slug: string
  tier: PackageTier
  titleI18n: I18nText
  idealForI18n: I18nText | null
  compareValues: Record<string, CompareValue>
  deliveryDays: number
  revisionCount: number
  display: PriceDisplay
  /** FR-4.5 per tier: the package override, else the category. */
  govtDependent: boolean
}

export interface PackageTiers {
  groupId: string
  titleI18n: I18nText
  compareRows: CompareRow[]
  tiers: TierOption[]
  mostChosen: PackageTier | null
}

export interface PackageExtras {
  tiers: PackageTiers | null
  govtDependent: boolean
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function mostChosenFor(tiers: TierOption[]): Promise<PackageTier | null> {
  if (!process.env['SUPABASE_SERVICE_ROLE_KEY']) return null
  try {
    const admin = await createAdminClient()
    const unchosen = `(${ORDER_UNCHOSEN_STATUSES.join(',')})`
    const counts = await Promise.all(
      tiers.map(async (t) => {
        const { count } = await admin
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .eq('package_id', t.packageId)
          .not('status', 'in', unchosen)
        return [t.tier, count ?? 0] as const
      }),
    )
    return mostChosenTier(Object.fromEntries(counts))
  } catch (e) {
    console.error('[mostChosenFor]', e)
    return null
  }
}

export async function getPackageExtras(pkg: { id: string; categorySlug: string }): Promise<PackageExtras> {
  const supabase = createPublicClient()
  const [own, cat] = await Promise.all([
    supabase.from('packages').select('group_id, govt_dependent_override').eq('id', pkg.id).maybeSingle(),
    pkg.categorySlug
      ? supabase.from('categories').select('govt_dependent').eq('slug', pkg.categorySlug).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  if (own.error || cat.error) return { tiers: null, govtDependent: false }
  const categoryGovt = (cat.data as any)?.govt_dependent as boolean | undefined
  const govtDependent = isGovtDependent(categoryGovt, (own.data as any)?.govt_dependent_override)

  const groupId = (own.data as any)?.group_id as string | null | undefined
  if (!groupId) return { tiers: null, govtDependent }

  const [{ data: group, error: gErr }, { data: rows, error: rErr }] = await Promise.all([
    supabase.from('package_groups').select('id, provider_id, title_i18n, compare_rows').eq('id', groupId).is('deleted_at', null).maybeSingle(),
    supabase
      .from('packages')
      .select('id, provider_id, slug, tier, title_i18n, price_paise, discount_bps, member_extra_discount_bps, delivery_days, revision_count, ideal_for_i18n, compare_values, govt_dependent_override')
      .eq('group_id', groupId)
      .eq('status', 'active')
      .is('deleted_at', null),
  ])
  if (gErr || rErr || !group) return { tiers: null, govtDependent }

  const compareRows = storedCompareRowsSchema.safeParse(group.compare_rows)
  const tiers: TierOption[] = []
  for (const r of (rows ?? []) as any[]) {
    // Only the group owner's packages (the 0050 trigger enforces it; checked again here).
    if (r.provider_id !== group.provider_id) continue
    const tier = packageTierSchema.safeParse(r.tier)
    if (!tier.success) continue
    const values = storedCompareValuesSchema.safeParse(r.compare_values ?? {})
    tiers.push({
      packageId: r.id,
      slug: r.slug,
      tier: tier.data,
      titleI18n: r.title_i18n,
      idealForI18n: r.ideal_for_i18n ?? null,
      compareValues: values.success ? values.data : {},
      deliveryDays: r.delivery_days,
      revisionCount: r.revision_count,
      display: priceDisplay({ pricePaise: Number(r.price_paise), discountBps: r.discount_bps, memberExtraDiscountBps: r.member_extra_discount_bps }),
      govtDependent: isGovtDependent(categoryGovt, r.govt_dependent_override),
    })
  }
  tiers.sort((a, b) => tierRank(a.tier) - tierRank(b.tier))
  // A group shows as tiers only while at least two of its packages are live
  // and the page's own package is one of them.
  if (tiers.length < 2 || !tiers.some((t) => t.packageId === pkg.id)) return { tiers: null, govtDependent }

  return {
    govtDependent,
    tiers: {
      groupId: group.id,
      titleI18n: group.title_i18n as I18nText,
      compareRows: compareRows.success ? compareRows.data : [],
      tiers,
      mostChosen: await mostChosenFor(tiers),
    },
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
