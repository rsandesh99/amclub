import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { searchFeedbackSchema } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests, clientIp } from '@/lib/rate-limit'
import { captureServerEvent } from '@/lib/analytics/server'
import { isOnForEveryone } from '@/lib/experiments'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Experience v3 E2 FR-2.6 (N6) — "Did you find what you need?". Signed-out
 * buyers may answer (user_id null). Stored service-role only; no client ever
 * reads search_feedback. Per-IP limited.
 */
export async function POST(request: NextRequest) {
  if (!isOnForEveryone('search')) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const rl = await enforce(limiters.publicIp, `search-feedback:${clientIp(request)}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)
  const parsed = searchFeedbackSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 422 })
  const { userId } = await getAuthedSupabase()
  const d = parsed.data
  const admin = await createAdminClient()
  const { error } = await admin.from('search_feedback').insert({
    user_id: userId ?? null,
    query: d.query,
    filters: d.filters,
    result_ids: d.resultIds,
    helpful: d.helpful,
    reason: d.reason,
    surface: d.surface,
  })
  if (error) return NextResponse.json({ error: 'feedback_unavailable' }, { status: 503 })
  captureServerEvent(userId ?? 'anonymous', 'search_feedback_stored', { helpful: d.helpful, reason: d.reason, results: d.resultIds.length })
  return NextResponse.json({ ok: true }, { status: 201, headers: { 'Cache-Control': 'private, no-store' } })
}
