import 'server-only'
import { onboardingNudgeDue, stepsLeft, type OnboardingV3Step } from '@amclub/shared'
import { createAdminClient } from '@/lib/supabase/server'
import { createNotification } from '@/lib/notifications/create'
import { captureServerEvent } from '@/lib/analytics/server'
import { isOnFor } from '@/lib/experiments'

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * PRD Experience v3 E10 (FR-10.4, N27c) — where each applicant is in the v3
 * wizard, and the stall nudge: one template after 24 h untouched, a second
 * after another 24 h, never after submit. Service role only; every row is
 * keyed to the caller's own user id.
 */
export async function recordOnboardingProgress(userId: string, step: OnboardingV3Step, categorySlug?: string): Promise<void> {
  const admin = await createAdminClient()
  await admin
    .from('provider_onboarding_progress')
    .upsert({ user_id: userId, step, ...(categorySlug ? { category_slug: categorySlug } : {}), submitted_at: null, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
}

/** POST /profile/provider — the draft is done; no more nudges. */
export async function markOnboardingSubmitted(admin: Admin, userId: string): Promise<void> {
  const { error } = await admin.from('provider_onboarding_progress').update({ submitted_at: new Date().toISOString() }).eq('user_id', userId)
  if (error) console.error('[onboarding-v3] mark submitted:', error.message)
}

const STEP_LABEL: Record<OnboardingV3Step, { en: string; hi: string; te: string; ta: string }> = {
  contact: { en: 'Contact', hi: 'संपर्क', te: 'సంప్రదింపు', ta: 'தொடர்பு' },
  business: { en: 'Business', hi: 'व्यवसाय', te: 'వ్యాపారం', ta: 'வணிகம்' },
  credentials_bank: { en: 'Credentials & bank', hi: 'क्रेडेंशियल और बैंक', te: 'క్రెడెన్షియల్స్ & బ్యాంక్', ta: 'சான்றுகள் & வங்கி' },
  review: { en: 'Review & submit', hi: 'समीक्षा और सबमिट', te: 'సమీక్ష & సమర్పణ', ta: 'மதிப்பாய்வு & சமர்ப்பிப்பு' },
}

export interface NudgeRun { considered: number; sent: number }

/**
 * Hourly. Drafts untouched ≥ 24 h (submitted_at null) whose applicant has the
 * `onboarding` experience on get the due nudge: the (user_id, nudge_no) row is
 * claimed first, and only a claim this run won notifies — in-app plus the
 * `onboarding_stalled` WhatsApp template, which the dispatcher sends only to
 * providers who opted in. Deep link: the exact step.
 */
export async function runOnboardingNudges(admin: Admin, now: Date = new Date()): Promise<NudgeRun> {
  const cutoff = new Date(now.getTime() - 24 * 3600 * 1000).toISOString()
  const { data } = await admin
    .from('provider_onboarding_progress')
    .select('user_id, step, updated_at, submitted_at')
    .is('submitted_at', null)
    .lte('updated_at', cutoff)
    .limit(1000)
  const rows = (data ?? []) as { user_id: string; step: OnboardingV3Step; updated_at: string; submitted_at: string | null }[]
  const live = rows.filter((r) => isOnFor('onboarding', r.user_id))
  if (live.length === 0) return { considered: 0, sent: 0 }
  const ids = live.map((r) => r.user_id)
  const [{ data: sent }, { data: profiles }] = await Promise.all([
    admin.from('onboarding_nudges').select('user_id, sent_at').in('user_id', ids),
    // Someone who already submitted through another path (e.g. the old wizard) is not stalled.
    admin.from('provider_profiles').select('user_id, status').in('user_id', ids),
  ])
  const done = new Set((profiles ?? []).filter((p) => p.status !== 'pending_kyc' && p.status !== 'rejected').map((p) => p.user_id as string))
  const nudgesBy = new Map<string, { sentAt: string }[]>()
  for (const n of sent ?? []) nudgesBy.set(n.user_id as string, [...(nudgesBy.get(n.user_id as string) ?? []), { sentAt: n.sent_at as string }])

  let count = 0
  for (const r of live) {
    if (done.has(r.user_id)) continue
    const due = onboardingNudgeDue({ updatedAt: r.updated_at, submittedAt: r.submitted_at }, nudgesBy.get(r.user_id) ?? [], now)
    if (!due) continue
    const { data: claimed } = await admin
      .from('onboarding_nudges')
      .upsert({ user_id: r.user_id, nudge_no: due, step: r.step }, { onConflict: 'user_id,nudge_no', ignoreDuplicates: true })
      .select('user_id')
    if (!claimed || claimed.length === 0) continue
    const left = stepsLeft(r.step)
    const label = STEP_LABEL[r.step]
    await createNotification(admin, {
      userId: r.user_id,
      kind: 'onboarding_stalled',
      titleI18n: {
        en: `Your AMClub profile is ${left} ${left === 1 ? 'step' : 'steps'} from done`,
        hi: `आपकी AMClub प्रोफ़ाइल पूरी होने में ${left} कदम बाकी हैं`,
        te: `మీ AMClub ప్రొఫైల్ పూర్తి కావడానికి ${left} దశలు మిగిలి ఉన్నాయి`,
        ta: `உங்கள் AMClub சுயவிவரம் முடிய ${left} படிகள் உள்ளன`,
      },
      bodyI18n: { en: `Pick up at “${label.en}”.`, hi: `“${label.hi}” से आगे बढ़ें।`, te: `“${label.te}” నుండి కొనసాగించండి.`, ta: `“${label.ta}” இலிருந்து தொடருங்கள்.` },
      link: `/partner/onboarding?step=${r.step}`,
      channels: ['whatsapp'],
    })
    if (due === 1) captureServerEvent(r.user_id, 'onboarding_abandoned', { step: r.step })
    captureServerEvent(r.user_id, 'onboarding_nudge_sent', { step: r.step })
    count++
  }
  return { considered: live.length, sent: count }
}
