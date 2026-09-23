/**
 * Experience v3 E4 (FR-4.1) — the provider's tier groups: read for the editor
 * and written by POST/DELETE /api/v1/partner/package-groups. Service role,
 * always scoped to the caller's OWN provider id (resolved from the session by
 * the route). Package prices are never touched here — a group only arranges
 * existing packages; checkout still prices each package on its own.
 */
import 'server-only'
import {
  priceDisplay,
  storedCompareRowsSchema,
  storedCompareValuesSchema,
  packageTierSchema,
  tierRank,
  type CompareRow,
  type CompareValue,
  type PackageGroupUpsert,
  type PackageTier,
  type PriceDisplay,
} from '@amclub/shared'
import type { createAdminClient } from '@/lib/supabase/server'
import type { I18nText } from './types'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

export interface EditorPackage {
  id: string
  titleI18n: I18nText
  categoryId: string
  categorySlug: string
  status: string
  deliveryDays: number
  display: PriceDisplay
  groupId: string | null
  tier: PackageTier | null
  idealForI18n: I18nText | null
  compareValues: Record<string, CompareValue>
}

export interface EditorGroup {
  id: string
  titleI18n: I18nText
  categoryId: string
  compareRows: CompareRow[]
  packageIds: string[]
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function loadTierEditor(admin: Admin, providerId: string): Promise<{ groups: EditorGroup[]; packages: EditorPackage[] }> {
  const [{ data: pkgs, error: pErr }, { data: groups, error: gErr }] = await Promise.all([
    admin
      .from('packages')
      .select('id, title_i18n, category_id, status, delivery_days, price_paise, discount_bps, member_extra_discount_bps, group_id, tier, ideal_for_i18n, compare_values, category:categories(slug)')
      .eq('provider_id', providerId)
      .is('deleted_at', null)
      .neq('status', 'removed')
      .order('price_paise', { ascending: true }),
    admin.from('package_groups').select('id, title_i18n, category_id, compare_rows').eq('provider_id', providerId).is('deleted_at', null).order('created_at', { ascending: true }),
  ])
  if (pErr || gErr) throw new Error('tier_editor_unavailable')
  const packages: EditorPackage[] = ((pkgs ?? []) as any[]).map((p) => {
    const tier = packageTierSchema.safeParse(p.tier)
    const values = storedCompareValuesSchema.safeParse(p.compare_values ?? {})
    return {
      id: p.id,
      titleI18n: p.title_i18n,
      categoryId: p.category_id,
      categorySlug: p.category?.slug ?? '',
      status: p.status,
      deliveryDays: p.delivery_days,
      display: priceDisplay({ pricePaise: Number(p.price_paise), discountBps: p.discount_bps, memberExtraDiscountBps: p.member_extra_discount_bps }),
      groupId: p.group_id ?? null,
      tier: tier.success ? tier.data : null,
      idealForI18n: p.ideal_for_i18n ?? null,
      compareValues: values.success ? values.data : {},
    }
  })
  return {
    packages,
    groups: ((groups ?? []) as any[]).map((g) => {
      const rows = storedCompareRowsSchema.safeParse(g.compare_rows)
      return {
        id: g.id,
        titleI18n: g.title_i18n,
        categoryId: g.category_id,
        compareRows: rows.success ? rows.data : [],
        packageIds: packages
          .filter((p) => p.groupId === g.id && p.tier)
          .sort((a, b) => tierRank(a.tier!) - tierRank(b.tier!))
          .map((p) => p.id),
      }
    }),
  }
}

export type SaveGroupResult =
  | { ok: true; groupId: string; packageSlugs: string[] }
  | { ok: false; status: 404 | 409 | 422 | 503; error: string }

export async function saveTierGroup(admin: Admin, providerId: string, input: PackageGroupUpsert): Promise<SaveGroupResult> {
  const ids = input.tiers.map((t) => t.packageId)
  const { data: rows, error } = await admin
    .from('packages')
    .select('id, slug, category_id, status, group_id')
    .eq('provider_id', providerId)
    .is('deleted_at', null)
    .in('id', ids)
  if (error) return { ok: false, status: 503, error: 'tier_editor_unavailable' }
  const found = (rows ?? []) as { id: string; slug: string; category_id: string; status: string; group_id: string | null }[]
  // Another provider's package (or a removed one) is simply "not found".
  if (found.length !== ids.length || found.some((r) => r.status === 'removed')) return { ok: false, status: 404, error: 'package_not_found' }
  const categoryId = found[0]!.category_id
  if (found.some((r) => r.category_id !== categoryId)) return { ok: false, status: 422, error: 'mixed_categories' }
  if (found.some((r) => r.group_id && r.group_id !== input.id)) return { ok: false, status: 409, error: 'package_in_other_group' }

  let groupId = input.id
  if (groupId) {
    const { data: g } = await admin.from('package_groups').select('id').eq('id', groupId).eq('provider_id', providerId).is('deleted_at', null).maybeSingle()
    if (!g) return { ok: false, status: 404, error: 'group_not_found' }
    const { error: uErr } = await admin
      .from('package_groups')
      .update({ title_i18n: input.titleI18n, compare_rows: input.compareRows, category_id: categoryId })
      .eq('id', groupId)
    if (uErr) return { ok: false, status: 503, error: 'tier_editor_unavailable' }
  } else {
    const { data: g, error: iErr } = await admin
      .from('package_groups')
      .insert({ provider_id: providerId, category_id: categoryId, title_i18n: input.titleI18n, compare_rows: input.compareRows })
      .select('id')
      .single()
    if (iErr || !g) return { ok: false, status: 503, error: 'tier_editor_unavailable' }
    groupId = g.id as string
  }

  // Release members that left the group, then free every tier slot before
  // re-assigning (the (group_id, tier) index is unique). Re-running a save
  // after a partial failure converges on the same state.
  const inList = `(${ids.join(',')})`
  const { error: rErr } = await admin
    .from('packages')
    .update({ group_id: null, tier: null, ideal_for_i18n: null, compare_values: null })
    .eq('group_id', groupId)
    .not('id', 'in', inList)
  if (rErr) return { ok: false, status: 503, error: 'tier_editor_unavailable' }
  const { error: fErr } = await admin.from('packages').update({ tier: null }).eq('group_id', groupId)
  if (fErr) return { ok: false, status: 503, error: 'tier_editor_unavailable' }
  for (const t of input.tiers) {
    const { error: sErr } = await admin
      .from('packages')
      .update({ group_id: groupId, tier: t.tier, ideal_for_i18n: t.idealForI18n, compare_values: t.compareValues })
      .eq('id', t.packageId)
      .eq('provider_id', providerId)
    if (sErr) return { ok: false, status: 503, error: 'tier_editor_unavailable' }
  }
  return { ok: true, groupId: groupId!, packageSlugs: found.map((r) => r.slug) }
}

export async function deleteTierGroup(admin: Admin, providerId: string, groupId: string): Promise<boolean> {
  const { data: g } = await admin.from('package_groups').select('id').eq('id', groupId).eq('provider_id', providerId).is('deleted_at', null).maybeSingle()
  if (!g) return false
  await admin.from('packages').update({ group_id: null, tier: null, ideal_for_i18n: null, compare_values: null }).eq('group_id', groupId).eq('provider_id', providerId)
  await admin.from('package_groups').update({ deleted_at: new Date().toISOString() }).eq('id', groupId)
  return true
}
/* eslint-enable @typescript-eslint/no-explicit-any */
