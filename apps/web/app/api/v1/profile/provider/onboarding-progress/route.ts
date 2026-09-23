import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { onboardingProgressSchema } from '@amclub/shared'
import { getSessionUser } from '@/lib/auth/session'
import { isOnFor } from '@/lib/experiments'
import { recordOnboardingProgress } from '@/lib/onboarding-v3'

/**
 * POST /api/v1/profile/provider/onboarding-progress (PRD Experience v3 E10,
 * FR-10.4) — the v3 wizard saves the step it reached, so a stalled draft can
 * be nudged back to that exact step. Keyed to the caller; no other state.
 * 404 unless the `onboarding` experience is on for the caller.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isOnFor('onboarding', user.id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const parsed = onboardingProgressSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body', code: 'invalid_body' }, { status: 422 })
  await recordOnboardingProgress(user.id, parsed.data.step, parsed.data.categorySlug)
  return NextResponse.json({ ok: true })
}
