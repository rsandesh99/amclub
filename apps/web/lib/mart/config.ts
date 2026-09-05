import 'server-only'
import type { createAdminClient } from '@/lib/supabase/server'
import { createPublicClient } from '@/lib/supabase/server'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

export interface MartCategoryRow {
  slug: string
  name_i18n: { en: string; hi?: string; te?: string }
  return_window_hours: number
  commission_bps: number
  bis_blocked: boolean
  is_active: boolean
  sort_order: number | null
}

/** Public list of active, non-blocked Mart categories (anon client, RLS). */
export async function listMartCategories(): Promise<MartCategoryRow[]> {
  const { data } = await createPublicClient()
    .from('mart_categories')
    .select('slug, name_i18n, return_window_hours, commission_bps, bis_blocked, is_active, sort_order')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
  return (data ?? []) as MartCategoryRow[]
}

/** One category's config (service role — used by money + gate code paths). */
export async function getMartCategory(admin: Admin, slug: string): Promise<MartCategoryRow | null> {
  const { data } = await admin
    .from('mart_categories')
    .select('slug, name_i18n, return_window_hours, commission_bps, bis_blocked, is_active, sort_order')
    .eq('slug', slug)
    .maybeSingle()
  return (data as MartCategoryRow | null) ?? null
}

/** Config value from mart_settings; `fallback` when absent (never hardcode rates in code). */
export async function getMartSetting<T>(admin: Admin, key: string, fallback: T): Promise<T> {
  const { data } = await admin.from('mart_settings').select('value').eq('key', key).maybeSingle()
  return data ? (data.value as T) : fallback
}

export interface TdsConfig {
  section: string
  rate_bps: number
  threshold_paise: number
}

export async function getTdsConfig(admin: Admin): Promise<TdsConfig> {
  return getMartSetting<TdsConfig>(admin, 'tds', { section: '194C', rate_bps: 0, threshold_paise: 3_000_000 })
}

export async function getEwayBillThresholdPaise(admin: Admin): Promise<number> {
  const v = await getMartSetting<number | string>(admin, 'eway_bill_threshold_paise', 5_000_000)
  return Number(v)
}

export async function getAutoApproveAfterListings(admin: Admin): Promise<number> {
  const v = await getMartSetting<number | string>(admin, 'auto_approve_after_listings', 3)
  return Number(v)
}
