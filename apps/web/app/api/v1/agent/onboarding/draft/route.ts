import { NextResponse } from 'next/server'
import { agentApiGate } from '@/lib/agent/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { onboardingDraftView } from '@/lib/agent/onboarding'

/**
 * GET /api/v1/agent/onboarding/draft (S1.6) — the wizard's prefill: the
 * user's latest session in confirmed / handed_off / failed. `draft` is present
 * ONLY when the provider confirmed it by button (a failed session still
 * returns the redacted answers so the wizard can prefill from them). Photo URLs
 * are 15-minute signed URLs from the private wa-media bucket. 404 when none.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const gate = agentApiGate()
  if (gate) return gate
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const admin = await createAdminClient()
  const view = await onboardingDraftView(admin, userId)
  if (!view) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(view, { headers: { 'Cache-Control': 'private, no-store' } })
}
