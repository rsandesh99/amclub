import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { extractRuntimeCredential, verifyRuntimeCredential } from '@amclub/agent-core'
import { growthNudgeLine, growthNudgeSchema, pickLocale } from '@amclub/shared'
import { agentApiGate } from '@/lib/agent/gate'
import { createAdminClient } from '@/lib/supabase/server'
import { createNotification } from '@/lib/notifications/create'
import { env } from '@/lib/env'

/**
 * POST /api/v1/agent/munshi/growth (S2.4) — the runtime's weekly growth job asks the web for ONE in-app notification
 * (kind munshi_growth) carrying the nudge it picked. Runtime credential REQUIRED (persona provider); the runtime keeps
 * the once-a-week guard (munshi_provider_state.last_growth_at) and sends WhatsApp itself. Fixed copy in every locale;
 * a category name is read from the platform's own category list.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const bodySchema = z.object({ nudge: growthNudgeSchema }).strict()
const LINK = { profile_field: '/partner/profile', category_demand: '/partner/profile', score_tip: '/partner', score_rise: '/partner' } as const

export async function POST(request: NextRequest) {
  const gate = agentApiGate()
  if (gate) return gate
  const secret = env.AGENT_RUNTIME_SECRET
  if (!secret) return NextResponse.json({ error: 'agent_not_configured' }, { status: 503 })
  const cred = extractRuntimeCredential(request.headers.get('authorization'))
  const claims = cred ? verifyRuntimeCredential(secret, cred) : null
  if (!claims || claims.persona !== 'provider') return NextResponse.json({ error: 'invalid_runtime_credential' }, { status: 401 })
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const n = parsed.data.nudge
  const admin = await createAdminClient()
  let names: Record<string, string> = {}
  if (n.kind === 'category_demand') {
    const { data: cat } = await admin.from('categories').select('name_i18n').eq('slug', n.category_slug).maybeSingle()
    if (!cat) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const i18n = (cat as { name_i18n: { en: string; hi?: string; te?: string } }).name_i18n
    names = Object.fromEntries(['en', 'hi', 'te'].map((l) => [l, pickLocale(i18n, l)]))
  }
  await createNotification(admin, {
    userId: claims.userId,
    kind: 'munshi_growth',
    // the notification i18n is en / hi / te (a Tamil reader gets English, as every other notification kind)
    titleI18n: { en: 'A tip from Munshi', hi: 'मुंशी की एक सलाह', te: 'మున్షీ నుండి ఒక సూచన' },
    bodyI18n: { en: growthNudgeLine(n, 'en', names['en'] ?? null), hi: growthNudgeLine(n, 'hi', names['hi'] ?? null), te: growthNudgeLine(n, 'te', names['te'] ?? null) },
    link: LINK[n.kind],
  })
  return NextResponse.json({ ok: true })
}
