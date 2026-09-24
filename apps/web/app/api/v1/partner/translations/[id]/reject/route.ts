import { NextResponse } from 'next/server'
import { translationRouteGuard } from '@/lib/translations/route-guard'
import { rejectContentTranslation } from '@/lib/translations/content'

/** POST /api/v1/partner/translations/[id]/reject (E14 FR-14.3) — discard a draft; nothing is written anywhere a buyer sees. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await translationRouteGuard('partner/translations/reject')
  if (!g.ok) return g.res
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const ok = await rejectContentTranslation(g.admin, { id, providerId: g.providerId })
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not_a_draft' }, { status: 409 })
}
