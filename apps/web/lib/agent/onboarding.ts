import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ONBOARDING_TERMINAL_STEPS,
  onboardingDraftSchema,
  toOnboardingLocale,
  type OnboardingAnswer,
  type OnboardingDraft,
  type OnboardingDraftView,
  type OnboardingStep,
} from '@amclub/shared'
import { AGENT_ENABLED } from '@/lib/flags'
import { getAgentSetting, isAgentEnabledForUser } from '@/lib/agent/settings'

/**
 * S1.6 — web-side helpers for the Onboarding agent. The web owns: the start
 * route (creates the session + enqueues the runtime job), the draft read the
 * wizard prefills from, the profile-submit link (the ONLY draft → profile
 * link), the partner-dashboard suggested listings and the admin view. It never
 * runs the interview and never writes provider_profiles from a draft — the
 * wizard's existing route does that under the user's own session.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const WA_MEDIA_BUCKET = process.env['WA_MEDIA_BUCKET'] ?? 'wa-media'
export const ONBOARDING_PHOTO_URL_TTL_SEC = 15 * 60

/** AGENT_ENABLED + agents_enabled.onboarding + cohort — for THIS user. */
export async function isOnboardingEnabledFor(admin: SupabaseClient, userId: string): Promise<boolean> {
  if (!AGENT_ENABLED) return false
  return isAgentEnabledForUser(admin, 'onboarding', userId)
}

export async function getOnboardingTtlHours(admin: SupabaseClient): Promise<number> {
  const v = await getAgentSetting(admin, 'onboarding_session_ttl_hours')
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 168 ? v : 72
}

export interface OnboardingSessionRow {
  id: string
  user_id: string
  state: OnboardingStep
  locale: string
  surface: string
  answers: OnboardingAnswer[] | null
  photo_refs: string[] | null
  category_slugs: string[] | null
  gstin: string | null
  udyam: string | null
  draft: unknown
  draft_run_id: string | null
  draft_decision_id: string | null
  draft_count: number
  confirmed_at: string | null
  handed_off_at: string | null
  provider_id: string | null
  expires_at: string
  failure: string | null
  created_at: string
}

const COLS = 'id, user_id, state, locale, surface, answers, photo_refs, category_slugs, gstin, udyam, draft, draft_run_id, draft_decision_id, draft_count, confirmed_at, handed_off_at, provider_id, expires_at, failure, created_at'
const TERMINAL_IN = `(${ONBOARDING_TERMINAL_STEPS.map((s) => `"${s}"`).join(',')})`

/** The user's active (non-terminal) session, if any. */
export async function activeOnboardingSession(admin: SupabaseClient, userId: string): Promise<Pick<OnboardingSessionRow, 'id' | 'state' | 'expires_at'> | null> {
  const { data } = await admin
    .from('onboarding_sessions')
    .select('id, state, expires_at')
    .eq('user_id', userId)
    .not('state', 'in', TERMINAL_IN)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle()
  return (data as any) ?? null
}

/** The latest session the wizard may consume: confirmed / handed_off (draft) or failed (answers only). */
export async function latestConsumableSession(admin: SupabaseClient, userId: string): Promise<OnboardingSessionRow | null> {
  const { data } = await admin
    .from('onboarding_sessions')
    .select(COLS)
    .eq('user_id', userId)
    .in('state', ['confirmed', 'handed_off', 'failed'])
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as any) ?? null
}

/** The latest session in ANY state (admin view). */
export async function latestOnboardingSession(admin: SupabaseClient, userId: string): Promise<OnboardingSessionRow | null> {
  const { data } = await admin.from('onboarding_sessions').select(COLS).eq('user_id', userId).is('deleted_at', null).order('created_at', { ascending: false }).limit(1).maybeSingle()
  return (data as any) ?? null
}

export async function signedPhotoUrls(admin: SupabaseClient, refs: string[] | null | undefined): Promise<string[]> {
  const out: string[] = []
  for (const ref of refs ?? []) {
    const { data } = await admin.storage.from(WA_MEDIA_BUCKET).createSignedUrl(ref, ONBOARDING_PHOTO_URL_TTL_SEC)
    if (data?.signedUrl) out.push(data.signedUrl)
  }
  return out
}

/** Only the redacted text and its position — never the raw message row. */
export function redactedAnswers(answers: OnboardingAnswer[] | null | undefined): OnboardingDraftView['answers'] {
  return (answers ?? []).map((a) => ({
    step: a.step,
    text: a.text,
    kind: a.kind,
    redacted: a.redacted,
    ...(a.category_slug ? { category_slug: a.category_slug } : {}),
    ...(a.question_no ? { question_no: a.question_no } : {}),
  }))
}

/** The confirmed draft (schema-checked again on read) or null. */
export function confirmedDraftOf(s: OnboardingSessionRow): OnboardingDraft | null {
  if (!s.draft_decision_id || !s.draft) return null
  const r = onboardingDraftSchema.safeParse(s.draft)
  return r.success ? r.data : null
}

/** GET /api/v1/agent/onboarding/draft — the wizard's prefill view (+ the GSTIN the provider typed, unverified). */
export async function onboardingDraftView(admin: SupabaseClient, userId: string): Promise<(OnboardingDraftView & { gstin: string | null }) | null> {
  const s = await latestConsumableSession(admin, userId)
  if (!s) return null
  return {
    sessionId: s.id,
    state: s.state,
    locale: toOnboardingLocale(s.locale),
    draft: confirmedDraftOf(s),
    answers: redactedAnswers(s.answers),
    photoUrls: await signedPhotoUrls(admin, s.photo_refs),
    decisionId: s.draft_decision_id,
    confirmedAt: s.confirmed_at,
    handedOffAt: s.handed_off_at,
    gstin: s.gstin,
  }
}

/** The admin queue's view: the latest session with redacted answers, transcripts, signed photos, the draft (any) and the decision id. */
export async function onboardingAdminView(admin: SupabaseClient, userId: string) {
  const s = await latestOnboardingSession(admin, userId)
  if (!s) return null
  const answers = redactedAnswers(s.answers)
  const draftParsed = s.draft ? onboardingDraftSchema.safeParse(s.draft) : null
  return {
    session: {
      id: s.id,
      state: s.state,
      locale: toOnboardingLocale(s.locale),
      surface: s.surface,
      createdAt: s.created_at,
      expiresAt: s.expires_at,
      confirmedAt: s.confirmed_at,
      handedOffAt: s.handed_off_at,
      failure: s.failure,
      categorySlugs: s.category_slugs ?? [],
      // Never the numbers (the provider route hides gstin/pan the same way) — only whether they were given.
      gstinGiven: !!s.gstin,
      udyamGiven: !!s.udyam,
      draftCount: s.draft_count,
      providerLinked: !!s.provider_id,
    },
    answers,
    transcripts: (s.answers ?? []).filter((a) => a.kind === 'audio').map((a) => ({ step: a.step, text: a.text, vendor: a.transcript_vendor ?? null, category_slug: a.category_slug ?? null, question_no: a.question_no ?? null })),
    photoUrls: await signedPhotoUrls(admin, s.photo_refs),
    draft: draftParsed?.success ? draftParsed.data : null,
    draftConfirmed: !!s.draft_decision_id,
    decisionId: s.draft_decision_id,
  }
}
