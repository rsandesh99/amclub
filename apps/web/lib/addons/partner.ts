import 'server-only'
import { NextResponse } from 'next/server'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { revalidateCatalog } from '@/lib/catalog/revalidate'
import { addonsOn } from './index'

type Admin = Awaited<ReturnType<typeof createAdminClient>>
export interface OwnedPackage {
  admin: Admin
  userId: string
  packageId: string
  revalidate: () => void
}

/**
 * E12a / ADR 019 — the guard every partner add-on route runs first:
 * switch off → 404; no session → 401; a delegated agent token → 403 (add-ons
 * are money the provider sets by hand); not the caller's package → 404.
 * Writes then go through the service role (clients hold no write grant).
 */
export async function ownPackageForAddons(packageId: string, route: string): Promise<OwnedPackage | NextResponse> {
  const admin = await createAdminClient()
  if (!(await addonsOn(admin))) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated(route)
  if (delegated) return delegated
  if (!/^[0-9a-f-]{36}$/i.test(packageId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { data } = await admin
    .from('packages')
    .select('id, slug, deleted_at, category:categories(slug), provider:provider_profiles!inner(user_id, slug)')
    .eq('id', packageId)
    .maybeSingle()
  const row = data as { id: string; slug: string; deleted_at: string | null; category: { slug: string } | null; provider: { user_id: string; slug: string } } | null
  if (!row || row.deleted_at || row.provider?.user_id !== userId) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return {
    admin,
    userId,
    packageId,
    revalidate: () =>
      revalidateCatalog({
        ...(row.category?.slug ? { categorySlug: row.category.slug } : {}),
        providerSlug: row.provider.slug,
        packageSlug: row.slug,
      }),
  }
}

export const PARTNER_ADDON_COLS = 'id, label_i18n, price_paise, days_delta, extra_revisions, active, sort, created_at'

/** The trigger's "at most 3 active" (check_violation) → 409 addon_limit. */
export function addonWriteError(e: { code?: string; message?: string } | null): NextResponse | null {
  if (!e) return null
  if (e.code === '23514' && (e.message ?? '').includes('addon_limit')) return NextResponse.json({ error: 'addon_limit' }, { status: 409 })
  if (e.code === '23514') return NextResponse.json({ error: 'invalid_addon' }, { status: 422 })
  console.error('[partner addons]', e.message)
  return NextResponse.json({ error: 'save_failed' }, { status: 500 })
}
