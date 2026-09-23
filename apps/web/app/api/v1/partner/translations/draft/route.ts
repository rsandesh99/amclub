import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { contentTranslateRequestSchema } from '@amclub/shared'
import { translationRouteGuard } from '@/lib/translations/route-guard'
import { draftContentTranslations } from '@/lib/agent/content-translate'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'

/**
 * POST /api/v1/partner/translations/draft (E14 FR-14.3, dark) — draft one
 * language of one subject (a package's title + "Choose this if…", or the
 * profile's About). Drafts only: nothing a buyer sees changes until the
 * provider approves each one.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const g = await translationRouteGuard('partner/translations/draft')
  if (!g.ok) return g.res
  const parsed = contentTranslateRequestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 422 })
  // One paid call per field: the quote-extract burst budget, keyed to the provider.
  const rl = await enforce(limiters.quoteExtract, `ct:${g.providerId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const subjectId = parsed.data.subjectKind === 'profile' ? g.providerId : parsed.data.subjectId!
  const out = await draftContentTranslations(g.admin, { userId: g.userId, providerId: g.providerId, subjectKind: parsed.data.subjectKind, subjectId, lang: parsed.data.lang })
  if (!out) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(out)
}
