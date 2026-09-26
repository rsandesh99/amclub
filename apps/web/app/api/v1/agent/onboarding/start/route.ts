import { NextResponse } from 'next/server'
import type { OnboardingStartResponse } from '@amclub/shared'
import { agentApiGate } from '@/lib/agent/gate'
import { getAuthedSupabase } from '@/lib/auth/request'
import { createAdminClient } from '@/lib/supabase/server'
import { enforce, limiters, tooManyRequests } from '@/lib/rate-limit'
import { activeOnboardingSession, getOnboardingTtlHours, isOnboardingEnabledFor } from '@/lib/agent/onboarding'
import { enqueueRuntimeJob } from '@/lib/agent/runtime-client'
import { captureServerEvent } from '@/lib/analytics/server'
import { env } from '@/lib/env'
import { requireNotDelegated } from '@/lib/agent/scope'

/**
 * POST /api/v1/agent/onboarding/start (S1.6) — "Finish on WhatsApp" from the
 * provider wizard. Creates the interview session (surface whatsapp, TTL from
 * agent_settings) and enqueues the runtime's start turn. An active WhatsApp
 * grant is NOT required here: the reply tells the user to send START (opt-in)
 * and then JOIN, which attaches this session to their conversation. 404 while
 * the flag/agent/cohort are off; 409 when a session is already active.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function POST() {
  const gate = agentApiGate()
  if (gate) return gate
  // Audit wave 3: no agent tool wraps this route, so a delegated agent token is refused.
  const delegated = await requireNotDelegated('POST /agent/onboarding/start')
  if (delegated) return delegated
  const { userId } = await getAuthedSupabase()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const rl = await enforce(limiters.authed, `onboarding-start:${userId}`)
  if (!rl.ok) return tooManyRequests(rl.retryAfter)

  const admin = await createAdminClient()
  if (!(await isOnboardingEnabledFor(admin, userId))) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // A provider-role user, or a user with no provider profile yet (msme signing up as a provider).
  // An approved / under-review provider must not re-run onboarding (the wizard page rule).
  const [{ data: u }, { data: profile }] = await Promise.all([
    admin.from('users').select('roles, preferred_locale').eq('id', userId).maybeSingle(),
    admin.from('provider_profiles').select('id, status').eq('user_id', userId).maybeSingle(),
  ])
  const roles = ((u as { roles?: string[] } | null)?.roles ?? []) as string[]
  if (profile && (profile as { status: string }).status !== 'rejected' && (profile as { status: string }).status !== 'pending_kyc') {
    return NextResponse.json({ error: 'already_provider' }, { status: 409 })
  }
  if (!roles.includes('provider') && profile) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const existing = await activeOnboardingSession(admin, userId)
  const needsOptIn = async () => {
    const { data: g } = await admin.from('agent_grants').select('id').eq('user_id', userId).eq('channel', 'whatsapp').is('revoked_at', null).limit(1)
    return !(Array.isArray(g) && g.length > 0)
  }
  if (existing) {
    return NextResponse.json({ error: 'session_active', sessionId: existing.id, state: existing.state, whatsappNumber: env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? null, needsOptIn: await needsOptIn() }, { status: 409, headers: NO_STORE })
  }

  const ttl = await getOnboardingTtlHours(admin)
  const pl = (u as { preferred_locale?: string } | null)?.preferred_locale
  const locale = pl === 'hi' || pl === 'te' ? pl : 'en'
  const { data: created, error } = await admin
    .from('onboarding_sessions')
    .insert({ user_id: userId, surface: 'whatsapp', locale, state: 'language', expires_at: new Date(Date.now() + ttl * 3600 * 1000).toISOString() })
    .select('id')
    .single()
  if (error || !created) {
    // The partial unique index refuses a second active session (race with JOIN).
    if ((error as { code?: string } | null)?.code === '23505') {
      const again = await activeOnboardingSession(admin, userId)
      return NextResponse.json({ error: 'session_active', sessionId: again?.id ?? null, needsOptIn: await needsOptIn() }, { status: 409, headers: NO_STORE })
    }
    console.error('[agent/onboarding/start]', error?.message)
    return NextResponse.json({ error: 'session_create_failed' }, { status: 500 })
  }
  const sessionId = (created as { id: string }).id
  const job = await enqueueRuntimeJob('onboarding', { kind: 'start', sessionId }, { userId, persona: 'provider' })
  captureServerEvent(userId, 'onboarding_wa_started', { session_id: sessionId, surface: 'web', enqueued: job.ok })
  const body: OnboardingStartResponse = { sessionId, whatsappNumber: env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? null, needsOptIn: await needsOptIn(), enqueued: job.ok }
  return NextResponse.json(body, { status: 201, headers: NO_STORE })
}
