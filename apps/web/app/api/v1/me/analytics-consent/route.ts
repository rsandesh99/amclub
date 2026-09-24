import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { ANALYTICS_NOTICE_VERSION, analyticsConsentBodySchema, currentConsentFromRecord } from '@amclub/shared'
import { getAuthedSupabase } from '@/lib/auth/request'
import { requireNotDelegated } from '@/lib/agent/scope'
import { createAdminClient } from '@/lib/supabase/server'
import { ANALYTICS_CONSENT_REQUIRED } from '@/lib/public-flags'

export const dynamic = 'force-dynamic'

/**
 * E17 (N36, gated on D-UX2) — a signed-in person's analytics choice, so it
 * follows them across devices (visitors keep the first-party cookie only).
 * 404 unless NEXT_PUBLIC_ANALYTICS_CONSENT_REQUIRED is on. The person's own
 * session only; never a delegated agent token. No analytics event is sent
 * about the choice itself — the consent rate is counted from these rows.
 */
export async function GET() {
  if (!ANALYTICS_CONSENT_REQUIRED) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = await createAdminClient()
  const { data } = await admin.from('users').select('analytics_consent').eq('id', userId).maybeSingle()
  return NextResponse.json({ choice: currentConsentFromRecord((data as { analytics_consent?: unknown } | null)?.analytics_consent), version: ANALYTICS_NOTICE_VERSION }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(request: NextRequest) {
  if (!ANALYTICS_CONSENT_REQUIRED) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const delegated = await requireNotDelegated('me/analytics-consent')
  if (delegated) return delegated
  const parsed = analyticsConsentBodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 422 })
  const admin = await createAdminClient()
  const record = { choice: parsed.data.choice, version: ANALYTICS_NOTICE_VERSION, at: new Date().toISOString() }
  const { error } = await admin.from('users').update({ analytics_consent: record }).eq('id', userId)
  if (error) return NextResponse.json({ error: 'save_failed' }, { status: 500 })
  return NextResponse.json(record)
}
