import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { MAX_ACTIVE_ADDONS, packageAddonInputSchema } from '@amclub/shared'
import { PARTNER_ADDON_COLS, addonWriteError, ownPackageForAddons } from '@/lib/addons/partner'
import { captureServerEvent } from '@/lib/analytics/server'

export const dynamic = 'force-dynamic'

/** E12a / ADR 019 — the provider's add-ons on one package (active and paused; deleted ones never). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const own = await ownPackageForAddons((await params).id, 'partner/packages/addons')
  if (own instanceof NextResponse) return own
  const { data } = await own.admin.from('package_addons').select(PARTNER_ADDON_COLS).eq('package_id', own.packageId).is('deleted_at', null).order('sort').order('created_at')
  return NextResponse.json({ addons: data ?? [], max: MAX_ACTIVE_ADDONS }, { headers: { 'Cache-Control': 'private, no-store' } })
}

/** Create one add-on. At most 3 active per package (the DB trigger is the final word → 409 addon_limit). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const own = await ownPackageForAddons((await params).id, 'partner/packages/addons')
  if (own instanceof NextResponse) return own
  const parsed = packageAddonInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_addon', details: parsed.error.flatten() }, { status: 422 })
  const { count } = await own.admin.from('package_addons').select('id', { count: 'exact', head: true }).eq('package_id', own.packageId).is('deleted_at', null)
  const { data, error } = await own.admin
    .from('package_addons')
    .insert({ package_id: own.packageId, ...parsed.data, sort: count ?? 0 })
    .select(PARTNER_ADDON_COLS)
    .single()
  const bad = addonWriteError(error)
  if (bad) return bad
  own.revalidate()
  captureServerEvent(own.userId, 'package_addon_saved', { created: true, active: parsed.data.active })
  return NextResponse.json({ addon: data }, { status: 201 })
}
