import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { contentTranslationApproveSchema } from '@amclub/shared'
import { translationRouteGuard } from '@/lib/translations/route-guard'
import { approveContentTranslation } from '@/lib/translations/content'
import { captureServerEvent } from '@/lib/analytics/server'

/**
 * POST /api/v1/partner/translations/[id]/approve (E14 FR-14.3) — the provider
 * approves one language of one field (optionally edited). The ONLY path that
 * writes a translated text where buyers see it; one ai_decisions row each.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await translationRouteGuard('partner/translations/approve')
  if (!g.ok) return g.res
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const parsed = contentTranslationApproveSchema.safeParse((await request.json().catch(() => ({}))) ?? {})
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 422 })
  const r = await approveContentTranslation(g.admin, { id, providerId: g.providerId, userId: g.userId, ...(parsed.data.text ? { text: parsed.data.text } : {}) })
  if (!r.ok) return NextResponse.json({ error: r.code, code: r.code }, { status: r.status })
  const { data } = await g.admin.from('content_translations').select('lang, draft_text, final_text').eq('id', id).maybeSingle()
  captureServerEvent(g.userId, 'content_translation_approved', { lang: data?.lang ?? null, edited: !!data && data.final_text !== data.draft_text, role: 'provider' })
  return NextResponse.json({ ok: true, decisionId: r.decisionId })
}
