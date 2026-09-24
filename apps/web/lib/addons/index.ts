import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PackageAddonRow } from '@amclub/shared'
import { getAgentSetting } from '@/lib/agent/settings'

/**
 * E12a / ADR 019 — package add-ons. The switch is `addons_enabled` (default
 * off); every reader here is tolerant (switch off, table absent before 0065,
 * any error → no add-ons), so nothing a buyer sees changes while it is dark.
 */
export const ADDON_COLS = 'id, label_i18n, price_paise, days_delta, extra_revisions'

export async function addonsOn(admin: SupabaseClient): Promise<boolean> {
  try {
    return (await getAgentSetting(admin, 'addons_enabled')) === true
  } catch {
    return false
  }
}

/** The package's ACTIVE add-ons in display order (service role or public client). */
export async function activeAddonsFor(db: SupabaseClient, packageId: string): Promise<PackageAddonRow[]> {
  try {
    const { data, error } = await db
      .from('package_addons')
      .select(ADDON_COLS)
      .eq('package_id', packageId)
      .eq('active', true)
      .is('deleted_at', null)
      .order('sort')
      .order('created_at')
    if (error) return []
    return ((data ?? []) as PackageAddonRow[]).map((r) => ({ ...r, price_paise: Number(r.price_paise) }))
  } catch {
    return []
  }
}

/** For buyer surfaces: the add-ons to offer, or [] while the switch is off. */
export async function offeredAddons(admin: SupabaseClient, packageId: string): Promise<PackageAddonRow[]> {
  if (!(await addonsOn(admin))) return []
  return activeAddonsFor(admin, packageId)
}
