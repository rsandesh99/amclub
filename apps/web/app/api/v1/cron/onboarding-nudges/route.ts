import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { verifyCron } from '@/lib/jobs/cron-auth'
import { runCronJob } from '@/lib/jobs/heartbeat'
import { runOnboardingNudges } from '@/lib/onboarding-v3'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Experience v3 E10 (FR-10.4, N27c) — hourly stall nudges for provider
 * applicants in the v3 wizard: at most 2 per draft (24 h apart), none after
 * submit. `onboarding_nudges (user_id, nudge_no)` makes a re-run a no-op.
 * A template through the notification dispatcher, never an agent.
 */
export async function GET(request: NextRequest) {
  if (!verifyCron(request)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  const admin = await createAdminClient()
  return runCronJob(admin, 'onboarding-nudges', () => runOnboardingNudges(admin))
}
