import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { bundleMilestonesSchema } from '@amclub/shared'
import { ownPackageFor } from '@/lib/addons/partner'
import { MILESTONE_COLS, bundlesOn } from '@/lib/bundles'
import { captureServerEvent } from '@/lib/analytics/server'

export const dynamic = 'force-dynamic'

/** E12c / ADR 021 — the provider's milestones on one package ([] = not a bundle). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const own = await ownPackageFor((await params).id, 'partner/packages/milestones', bundlesOn)
  if (own instanceof NextResponse) return own
  const { data } = await own.admin.from('bundle_milestones').select(MILESTONE_COLS).eq('package_id', own.packageId).order('seq')
  return NextResponse.json({ milestones: data ?? [] }, { headers: { 'Cache-Control': 'private, no-store' } })
}

const putSchema = z.object({ milestones: z.union([bundleMilestonesSchema, z.array(z.never()).length(0)]) }).strict()

/**
 * Replace the whole set (2–6 milestones; shares sum to 100 %; offsets strictly
 * increase; ≤ 92 days) — or [] to sell the package as a single order again.
 * Purchases already made keep their frozen plan; only new checkouts see this.
 */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const own = await ownPackageFor((await params).id, 'partner/packages/milestones', bundlesOn)
  if (own instanceof NextResponse) return own
  const parsed = putSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_milestones', details: parsed.error.flatten() }, { status: 422 })
  const { error: delErr } = await own.admin.from('bundle_milestones').delete().eq('package_id', own.packageId)
  if (delErr) return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  const rows = parsed.data.milestones.map((m, i) => ({ package_id: own.packageId, seq: i + 1, label_i18n: m.label_i18n, due_offset_days: m.due_offset_days, share_bps: m.share_bps }))
  if (rows.length) {
    const { error } = await own.admin.from('bundle_milestones').insert(rows)
    if (error) {
      console.error('[partner milestones]', error.message)
      return NextResponse.json({ error: 'save_failed' }, { status: 500 })
    }
  }
  own.revalidate()
  captureServerEvent(own.userId, 'bundle_milestones_saved', { n: rows.length })
  return NextResponse.json({ milestones: rows.map(({ package_id: _p, ...r }) => r) })
}
