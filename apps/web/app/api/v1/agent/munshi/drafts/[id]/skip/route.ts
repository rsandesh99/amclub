import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { munshiRouteContext, MUNSHI_NO_STORE } from '@/lib/agent/munshi-route'
import { skipMunshiDraft } from '@/lib/agent/munshi'

/** POST /api/v1/agent/munshi/drafts/[id]/skip (S2.2) — decline the parked run (declined event + cancel) and mark the draft skipped. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await munshiRouteContext('POST /agent/munshi/drafts/[id]/skip')
  if (ctx.error) return ctx.error
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const via = request.headers.get('x-amc-surface') === 'mobile' ? 'mobile' : 'web'
  const r = await skipMunshiDraft(ctx.admin, { userId: ctx.userId, providerId: ctx.providerId, draftId: id, via })
  if (!r.ok) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ ok: true, status: r.status }, { headers: MUNSHI_NO_STORE })
}
