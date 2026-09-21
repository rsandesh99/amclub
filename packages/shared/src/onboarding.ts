import { z } from 'zod'
import { CATEGORY_SLUGS, type CategorySlug } from './categories'
import { PROVIDER_LANGUAGES } from './locales'
import { uuidSchema } from './schemas/index'

/**
 * Onboarding agent contract (BUILD_PROMPTS S1.6). A provider who signed up by
 * phone OTP finishes onboarding on WhatsApp through a SCRIPTED interview: the
 * steps are code (this state machine), the model is called ONCE at the end to
 * turn the transcript into a profile draft plus up to three listing drafts,
 * and the provider confirms the draft with a WhatsApp BUTTON (the tap is the
 * confirmation, recorded as one ai_decisions row, feature `onboarding`, tool
 * `confirm_onboarding_draft`). The wizard on web/mobile then consumes the
 * confirmed draft; it still owns legal acceptance, the paid GSTIN/bank
 * verification and the profile write. The agent never verifies, never writes
 * provider_profiles, never activates.
 *
 * Zero runtime deps except zod (like the rest of @amclub/shared) so the
 * runtime, the web routes, the rig and the eval agree byte-for-byte.
 */

// ── Steps and transitions ─────────────────────────────────────────────────────

export const ONBOARDING_STEPS = [
  'language',
  'business_name',
  'gstin',
  'udyam',
  'categories',
  'capabilities',
  'photos',
  'drafting',
  'review',
  'confirmed',
  'handed_off',
  'abandoned',
  'failed',
] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]
export const onboardingSessionStateSchema = z.enum(ONBOARDING_STEPS)

/** Terminal states: the session is over; the dispatcher clears active_session_id. */
export const ONBOARDING_TERMINAL_STEPS: readonly OnboardingStep[] = ['handed_off', 'abandoned', 'failed']

/** Steps at which the provider is still being interviewed (expiry applies). */
export const ONBOARDING_ACTIVE_STEPS: readonly OnboardingStep[] = [
  'language', 'business_name', 'gstin', 'udyam', 'categories', 'capabilities', 'photos', 'drafting', 'review',
]

const LINEAR: Partial<Record<OnboardingStep, OnboardingStep>> = {
  language: 'business_name',
  business_name: 'gstin',
  gstin: 'udyam',
  udyam: 'categories',
  categories: 'capabilities',
  capabilities: 'photos',
  photos: 'drafting',
  drafting: 'review',
}

/** Steps a provider may skip (optional answers): Udyam and the workshop photos. */
export const ONBOARDING_SKIPPABLE_STEPS: readonly OnboardingStep[] = ['udyam', 'photos']

/**
 * The transition map. Linear edges, the two skip edges (same successor), the
 * review loop (revise → drafting; confirm → confirmed; cap reached → handed_off
 * without a confirmation), abandoned/failed from any active step, and
 * `confirmed → handed_off` as the ONLY exit from confirmed (it can never go back).
 */
export const ONBOARDING_TRANSITIONS: Record<OnboardingStep, readonly OnboardingStep[]> = {
  language: ['business_name', 'abandoned', 'failed'],
  business_name: ['gstin', 'abandoned', 'failed'],
  gstin: ['udyam', 'abandoned', 'failed'],
  udyam: ['categories', 'abandoned', 'failed'],
  categories: ['capabilities', 'abandoned', 'failed'],
  capabilities: ['photos', 'abandoned', 'failed'],
  photos: ['drafting', 'abandoned', 'failed'],
  drafting: ['review', 'failed', 'abandoned'],
  review: ['confirmed', 'drafting', 'handed_off', 'abandoned', 'failed'],
  confirmed: ['handed_off'],
  handed_off: [],
  abandoned: [],
  failed: [],
}

export type OnboardingEvent = 'answered' | 'skipped' | 'revise' | 'confirm' | 'expire' | 'error'

export function isOnboardingTerminal(step: OnboardingStep): boolean {
  return ONBOARDING_TERMINAL_STEPS.includes(step)
}

export function isValidOnboardingTransition(from: OnboardingStep, to: OnboardingStep): boolean {
  return ONBOARDING_TRANSITIONS[from].includes(to)
}

/**
 * The successor for an event, or null when the event is not valid at this step
 * (a terminal step answers null to everything). `skipped` is honoured only on
 * the skippable steps; `expire`/`error` are valid from any active step.
 */
export function nextOnboardingStep(current: OnboardingStep, event: OnboardingEvent): OnboardingStep | null {
  if (isOnboardingTerminal(current)) return null
  switch (event) {
    case 'answered':
      if (current === 'confirmed') return 'handed_off'
      return LINEAR[current] ?? null
    case 'skipped':
      return ONBOARDING_SKIPPABLE_STEPS.includes(current) ? (LINEAR[current] ?? null) : null
    case 'revise':
      return current === 'review' ? 'drafting' : null
    case 'confirm':
      return current === 'review' ? 'confirmed' : null
    case 'expire':
      return current === 'confirmed' ? null : 'abandoned'
    case 'error':
      return current === 'confirmed' ? null : 'failed'
    default:
      return null
  }
}

// ── Interview constants ───────────────────────────────────────────────────────

export const CAPABILITY_QUESTIONS_PER_CATEGORY = 3
/** At most three categories in the WhatsApp interview (the wizard allows five). */
export const ONBOARDING_MAX_CATEGORIES = 3
export const ONBOARDING_MAX_PHOTOS = 5
/** Two model drafts per session; a further revise hands off with the last draft. */
export const ONBOARDING_MAX_DRAFTS = 2
export const ONBOARDING_LOCALES = ['en', 'hi', 'te'] as const
export type OnboardingLocale = (typeof ONBOARDING_LOCALES)[number]
export const onboardingLocaleSchema = z.enum(ONBOARDING_LOCALES)

export function toOnboardingLocale(v: unknown): OnboardingLocale {
  return v === 'hi' || v === 'te' ? v : 'en'
}

/**
 * Capability questions per category — i18n KEYS into the interview copy
 * (`packages/shared/src/onboarding-copy.ts`), not copy: next-intl does not
 * exist in the runtime, so the runtime renders from that table.
 */
export type CapabilityQuestionKey = `cap.${CategorySlug}.1` | `cap.${CategorySlug}.2` | `cap.${CategorySlug}.3`
export const CAPABILITY_QUESTIONS: Record<CategorySlug, readonly [CapabilityQuestionKey, CapabilityQuestionKey, CapabilityQuestionKey]> = {
  'company-registrations': ['cap.company-registrations.1', 'cap.company-registrations.2', 'cap.company-registrations.3'],
  'tax-accounting': ['cap.tax-accounting.1', 'cap.tax-accounting.2', 'cap.tax-accounting.3'],
  legal: ['cap.legal.1', 'cap.legal.2', 'cap.legal.3'],
  'hr-staffing': ['cap.hr-staffing.1', 'cap.hr-staffing.2', 'cap.hr-staffing.3'],
  'finance-facilitation': ['cap.finance-facilitation.1', 'cap.finance-facilitation.2', 'cap.finance-facilitation.3'],
  'digital-marketing': ['cap.digital-marketing.1', 'cap.digital-marketing.2', 'cap.digital-marketing.3'],
  'web-tech': ['cap.web-tech.1', 'cap.web-tech.2', 'cap.web-tech.3'],
  'government-licensing': ['cap.government-licensing.1', 'cap.government-licensing.2', 'cap.government-licensing.3'],
}

// ── Stored answer ─────────────────────────────────────────────────────────────

/** One stored interview answer (onboarding_sessions.answers[]). Text is stored AFTER contact masking. */
export const onboardingAnswerSchema = z.object({
  step: onboardingSessionStateSchema,
  text: z.string().max(2000),
  wa_message_id: uuidSchema,
  kind: z.enum(['text', 'audio', 'button']),
  /** STT vendor tag when the answer came from a voice note. */
  transcript_vendor: z.string().optional(),
  /** `redactContactInfo` masked something in this answer. */
  redacted: z.boolean(),
  /** For capability answers: which category the question belonged to. */
  category_slug: z.enum(CATEGORY_SLUGS).optional(),
  /** For capability answers: 1..3 within the category. */
  question_no: z.number().int().min(1).max(3).optional(),
})
export type OnboardingAnswer = z.infer<typeof onboardingAnswerSchema>

// ── The draft (model output; strict) ──────────────────────────────────────────
// NO status / verified / approved / gstin_verified / rating keys: `.strict()` on
// every object rejects anything the model adds, so an injected "verified: true"
// can never reach the draft, the wizard or the admin queue.

export const onboardingDraftProfileSchema = z
  .object({
    display_name: z.string().min(2).max(100).nullable(),
    legal_name: z.string().min(2).max(200).nullable(),
    about: z.string().max(2000).nullable(),
    city: z.string().max(80).nullable(),
    state: z.string().max(40).nullable(),
    languages: z.array(z.enum(PROVIDER_LANGUAGES)).max(6),
    category_slugs: z.array(z.enum(CATEGORY_SLUGS)).max(3),
  })
  .strict()

export const onboardingDraftPackageSchema = z
  .object({
    category_slug: z.enum(CATEGORY_SLUGS),
    title: z.string().min(5).max(200),
    scope_included: z.array(z.string().min(1)).min(1).max(8),
    deliverables: z.array(z.string().min(1)).min(1).max(8),
    /** null unless the provider STATED a number — the model never invents money. */
    price_paise: z.number().int().positive().nullable(),
    delivery_days: z.number().int().min(1).max(365).nullable(),
  })
  .strict()

export const onboardingDraftSchema = z
  .object({
    profile: onboardingDraftProfileSchema,
    packages: z.array(onboardingDraftPackageSchema).max(3),
    /** Dotted paths the model was unsure about, e.g. `packages.0.price_paise`, `about`. */
    uncertain_fields: z.array(z.string().max(60)).max(12),
  })
  .strict()
export type OnboardingDraft = z.infer<typeof onboardingDraftSchema>
export type OnboardingDraftPackage = z.infer<typeof onboardingDraftPackageSchema>

// ── Capability facts (ARCHITECTURE §10) ───────────────────────────────────────

export const CAPABILITY_FACT_MAX_LEN = 300

export interface CapabilityFact {
  category_slug: CategorySlug
  fact: string
  locale: OnboardingLocale
}

/**
 * The provider_capability_facts rows a CONFIRMED draft yields: one per
 * `scope_included` line and per `deliverables` line, per package, deduped
 * (case/whitespace-insensitive), each ≤ 300 chars. Written only with the
 * confirming ai_decisions row as provenance; read by nobody before S2.2.
 */
export function capabilityFactsFromDraft(draft: OnboardingDraft, locale: OnboardingLocale): CapabilityFact[] {
  const seen = new Set<string>()
  const out: CapabilityFact[] = []
  for (const p of draft.packages) {
    for (const line of [...p.scope_included, ...p.deliverables]) {
      const fact = line.trim().replace(/\s+/g, ' ').slice(0, CAPABILITY_FACT_MAX_LEN)
      if (!fact) continue
      const key = `${p.category_slug}|${fact.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ category_slug: p.category_slug, fact, locale })
    }
  }
  return out
}

// ── Web contracts ─────────────────────────────────────────────────────────────

/** POST /api/v1/agent/onboarding/start reply. */
export interface OnboardingStartResponse {
  sessionId: string
  /** E.164 digits for the wa.me link, or null when the platform number is not configured. */
  whatsappNumber: string | null
  /** True when the user has no active WhatsApp grant yet (they must send START first, then JOIN). */
  needsOptIn: boolean
  /** Whether the runtime job was enqueued (false when the runtime is not configured — the JOIN keyword still works). */
  enqueued: boolean
}

/** GET /api/v1/agent/onboarding/draft reply (also the partner-dashboard / admin view). */
export interface OnboardingDraftView {
  sessionId: string
  state: OnboardingStep
  locale: OnboardingLocale
  /** The confirmed draft; null unless the session was confirmed by button. */
  draft: OnboardingDraft | null
  /** Redacted answer texts only (never the raw message). */
  answers: Array<Pick<OnboardingAnswer, 'step' | 'text' | 'kind' | 'redacted' | 'category_slug' | 'question_no'>>
  /** 15-minute signed URLs for the workshop photos. */
  photoUrls: string[]
  decisionId: string | null
  confirmedAt: string | null
  handedOffAt: string | null
}
