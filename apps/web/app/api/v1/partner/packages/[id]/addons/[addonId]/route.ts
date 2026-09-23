import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { packageAddonPatchSchema } from '@amclub/shared'
import { PARTNER_ADDON_COLS, addonWriteError, ownPackageForAddons } from '@/lib/addons/partner'
import { captureServerEvent } from '@/lib/analytics/server'

export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string; addonId: string }> }

/**
 * E12a / ADR 019 — edit or pause / resume one add-on. A change reaches only
 * checkouts that start after it: a session already created keeps its frozen
 * snapshot, and a buyer whose selection changed underneath gets 409
 * addon_changed at checkout, never a silent new price.
 */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { id, addonId } = await params
  const own = await ownPackageForAddons(id, 'partner/packages/addons')
  if (own instanceof NextResponse) return own
  const parsed = packageAddonPatchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success || Object.keys(parsed.data).length === 0) return NextResponse.json({ error: 'invalid_addon' }, { status: 422 })
  const { data, error } = await own.admin
    .from('package_addons')
    .update(parsed.data)
    .eq('id', addonId)
    .eq('package_id', own.packageId)
    .is('deleted_at', null)
    .select(PARTNER_ADDON_COLS)
    .maybeSingle()
  const bad = addonWriteError(error)
  if (bad) return bad
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  own.revalidate()
  captureServerEvent(own.userId, 'package_addon_saved', { created: false, active: (data as { active: boolean }).active })
  return NextResponse.json({ addon: data })
}

/** Remove (soft delete: never shown again; paid orders keep their snapshot). */
export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const { id, addonId } = await params
  const own = await ownPackageForAddons(id, 'partner/packages/addons')
  if (own instanceof NextResponse) return own
  const { data, error } = await own.admin
    .from('package_addons')
    .update({ active: false, deleted_at: new Date().toISOString() })
    .eq('id', addonId)
    .eq('package_id', own.packageId)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle()
  const bad = addonWriteError(error)
  if (bad) return bad
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  own.revalidate()
  return NextResponse.json({ ok: true })
}
