import { NextResponse } from 'next/server'
import { translationRouteGuard } from '@/lib/translations/route-guard'
import { listTranslatable } from '@/lib/translations/content'

/** GET /api/v1/partner/translations (E14 FR-14.3, dark) — my translatable copy: English, the live slots, the open drafts. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const g = await translationRouteGuard('partner/translations')
  if (!g.ok) return g.res
  return NextResponse.json(await listTranslatable(g.admin, g.providerId), { headers: { 'Cache-Control': 'private, no-store' } })
}
