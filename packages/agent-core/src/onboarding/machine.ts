import {
  CAPABILITY_QUESTIONS,
  CAPABILITY_QUESTIONS_PER_CATEGORY,
  CATEGORY_SLUGS,
  ONBOARDING_MAX_CATEGORIES,
  ONBOARDING_MAX_DRAFTS,
  ONBOARDING_MAX_PHOTOS,
  gstinSchema,
  nextOnboardingStep,
  onboardingCategoryName,
  onboardingCopy,
  udyamSchema,
  type CategorySlug,
  type OnboardingAnswer,
  type OnboardingLocale,
  type OnboardingStep,
} from '@amclub/shared'

/**
 * The scripted interview (BUILD_PROMPTS S1.6) as a PURE state machine over
 * ONBOARDING_TRANSITIONS: `(session, inbound) → { state, replies, patch,
 * action }`. No I/O, no model — the runtime (apps/agent-runtime) loads the
 * session, transcribes audio, masks contact info, calls this, persists the
 * patch, sends the replies and performs the action (draft = the one model
 * call; confirm = the decision route; revise; cap hand-off). Lives in
 * agent-core so it is unit-tested (the runtime has no test runner); the
 * runtime re-exports it.
 *
 * Buttons are the primary input; typed equivalents (numbers, names, SKIP /
 * DONE) are accepted everywhere EXCEPT the draft confirmation, which is
 * button-payload only (`confirm:<runId>`): free text never confirms.
 */

export interface MachineSession {
  id: string
  state: OnboardingStep
  locale: OnboardingLocale
  answers: OnboardingAnswer[]
  photo_refs: string[]
  category_slugs: CategorySlug[]
  gstin: string | null
  udyam: string | null
  draft_run_id: string | null
  draft_count: number
  revise_pending: boolean
}

export interface MachineInbound {
  messageId: string
  kind: 'text' | 'audio' | 'image' | 'document' | 'button' | 'unknown'
  /** Text body — for audio, the transcript (already produced by the runtime); null when STT failed. */
  text: string | null
  buttonPayload: string | null
  /** wa-media object path for an image. */
  mediaRef: string | null
  transcriptVendor?: string | null
  /** The runtime masked contact info in `text` (stored on the answer). */
  redacted?: boolean
}

export type OutboundMsg =
  | { type: 'text'; text: string }
  | { type: 'buttons'; text: string; buttons: { id: string; title: string }[]; listLabel?: string }

export type MachineAction = 'draft' | 'confirm' | 'revise' | 'cap_handoff' | null

export interface MachinePatch {
  answers?: OnboardingAnswer[]
  photo_refs?: string[]
  category_slugs?: CategorySlug[]
  gstin?: string | null
  udyam?: string | null
  locale?: OnboardingLocale
  revise_pending?: boolean
}

export interface MachineResult {
  state: OnboardingStep
  /** Replies to send, in order (the prompt for the next step is included when the step advances). */
  replies: OutboundMsg[]
  patch: MachinePatch
  /** What the runtime must do after persisting: the model call, the decision route, … */
  action: MachineAction
  /** 'answered' | 'skipped' advanced the step; 'reprompt' stayed; 'noop' ignored the message. */
  outcome: 'answered' | 'skipped' | 'reprompt' | 'noop' | 'confirm' | 'revise'
  /** The answer appended by this turn, if any. */
  answer?: OnboardingAnswer
}

export const LANGUAGE_BUTTONS: { id: string; locale: OnboardingLocale; copyId: 'btn_lang_en' | 'btn_lang_hi' | 'btn_lang_te' }[] = [
  { id: 'lang:en', locale: 'en', copyId: 'btn_lang_en' },
  { id: 'lang:hi', locale: 'hi', copyId: 'btn_lang_hi' },
  { id: 'lang:te', locale: 'te', copyId: 'btn_lang_te' },
]

const LANGUAGE_WORDS: Record<string, OnboardingLocale> = {
  english: 'en', en: 'en', '1': 'en', अंग्रेज़ी: 'en', अंग्रेजी: 'en', ఇంగ్లీష్: 'en',
  hindi: 'hi', hi: 'hi', '2': 'hi', हिंदी: 'hi', हिन्दी: 'hi', హిందీ: 'hi',
  telugu: 'te', te: 'te', '3': 'te', तेलुगु: 'te', తెలుగు: 'te',
}
const SKIP_WORDS = new Set(['skip', 'no', 'none', 'nahi', 'nahin', 'नहीं', 'छोड़ें', 'లేదు', 'skip करें'])
const DONE_WORDS = new Set(['done', 'ok', 'finish', 'finished', 'complete', 'हो गया', 'पूरा', 'అయిపోయింది', 'పూర్తి'])
const MIN_ANSWER_CHARS = 3

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().normalize('NFKC')

function text(locale: OnboardingLocale, id: Parameters<typeof onboardingCopy>[0], params?: Record<string, string | number>): OutboundMsg {
  return { type: 'text', text: onboardingCopy(id, locale, params) }
}

function categoryButtons(session: MachineSession): OutboundMsg {
  const remaining = CATEGORY_SLUGS.filter((s) => !session.category_slugs.includes(s))
  const buttons = remaining.map((s) => ({ id: `cat:${s}`, title: onboardingCategoryName(s, session.locale) }))
  if (session.category_slugs.length > 0) buttons.push({ id: 'cat:done', title: onboardingCopy('btn_done', session.locale) })
  return { type: 'buttons', text: onboardingCopy('ask_categories', session.locale, { max: ONBOARDING_MAX_CATEGORIES }), buttons, listLabel: onboardingCopy('list_choose', session.locale) }
}

/** Where we are in the 3 × categories capability questions. */
export function capabilityProgress(session: MachineSession): { answered: number; total: number; category: CategorySlug | null; questionNo: number } {
  const answered = session.answers.filter((a) => a.step === 'capabilities').length
  const total = session.category_slugs.length * CAPABILITY_QUESTIONS_PER_CATEGORY
  const idx = Math.floor(answered / CAPABILITY_QUESTIONS_PER_CATEGORY)
  const category = session.category_slugs[idx] ?? null
  return { answered, total, category, questionNo: (answered % CAPABILITY_QUESTIONS_PER_CATEGORY) + 1 }
}

/** The prompt(s) to send when the session is AT `state` (welcome + language, the next question, …). */
export function promptFor(state: OnboardingStep, session: MachineSession, extra: { name?: string; link?: string } = {}): OutboundMsg[] {
  const l = session.locale
  switch (state) {
    case 'language':
      return [
        text(l, 'welcome', { name: extra.name ?? '' }),
        { type: 'buttons', text: onboardingCopy('ask_language', l), buttons: LANGUAGE_BUTTONS.map((b) => ({ id: b.id, title: onboardingCopy(b.copyId, l) })) },
      ]
    case 'business_name':
      return [text(l, 'ask_business_name')]
    case 'gstin':
      return [text(l, 'ask_gstin')]
    case 'udyam':
      return [{ type: 'buttons', text: onboardingCopy('ask_udyam', l), buttons: [{ id: 'udyam:skip', title: onboardingCopy('btn_skip', l) }] }]
    case 'categories':
      return [categoryButtons(session)]
    case 'capabilities': {
      const p = capabilityProgress(session)
      if (!p.category) return []
      const q = onboardingCopy(CAPABILITY_QUESTIONS[p.category][p.questionNo - 1]!, l)
      return [text(l, 'ask_capability', { category: onboardingCategoryName(p.category, l), n: p.answered + 1, total: p.total, question: q })]
    }
    case 'photos':
      return [{ type: 'buttons', text: onboardingCopy('ask_photos', l, { max: ONBOARDING_MAX_PHOTOS }), buttons: [{ id: 'photos:skip', title: onboardingCopy('btn_skip', l) }, { id: 'photos:done', title: onboardingCopy('btn_done', l) }] }]
    case 'drafting':
      return [text(l, 'drafting_wait')]
    case 'review':
      return session.draft_run_id ? [reviewButtons(session)] : []
    case 'handed_off':
      return [text(l, 'handoff', { link: extra.link ?? '' })]
    case 'failed':
      return [text(l, 'failed_continue_web', { link: extra.link ?? '' })]
    case 'abandoned':
      return [text(l, 'expired', { link: extra.link ?? '' })]
    default:
      return []
  }
}

export function reviewButtons(session: MachineSession): OutboundMsg {
  const l = session.locale
  return {
    type: 'buttons',
    text: onboardingCopy('draft_buttons_hint', l),
    buttons: [
      { id: `confirm:${session.draft_run_id}`, title: onboardingCopy('btn_confirm', l) },
      { id: `revise:${session.draft_run_id}`, title: onboardingCopy('btn_revise', l) },
    ],
  }
}

function answerOf(session: MachineSession, inbound: MachineInbound, step: OnboardingStep, textValue: string, extra: Partial<OnboardingAnswer> = {}): OnboardingAnswer {
  return {
    step,
    text: textValue.slice(0, 2000),
    wa_message_id: inbound.messageId,
    kind: inbound.kind === 'audio' ? 'audio' : inbound.kind === 'button' ? 'button' : 'text',
    ...(inbound.kind === 'audio' && inbound.transcriptVendor ? { transcript_vendor: inbound.transcriptVendor } : {}),
    redacted: inbound.redacted === true,
    ...extra,
  }
}

function advance(session: MachineSession, inbound: MachineInbound, event: 'answered' | 'skipped', patch: MachinePatch, answer?: OnboardingAnswer, pre: OutboundMsg[] = []): MachineResult {
  const next = nextOnboardingStep(session.state, event)
  if (!next) return { state: session.state, replies: pre, patch, action: null, outcome: 'noop' }
  const after: MachineSession = { ...session, ...patch, state: next, answers: patch.answers ?? session.answers } as MachineSession
  const replies = [...pre, ...promptFor(next, after)]
  return { state: next, replies, patch, action: next === 'drafting' ? 'draft' : null, outcome: event, ...(answer ? { answer } : {}) }
}

/**
 * One inbound message against the session. Pure. The runtime persists
 * `patch` + `state` and sends `replies`; `action` tells it what else to do.
 */
export function stepMachine(session: MachineSession, inbound: MachineInbound): MachineResult {
  const l = session.locale
  const body = norm(inbound.text)
  const payload = inbound.kind === 'button' ? (inbound.buttonPayload ?? '') : ''
  const stay = (replies: OutboundMsg[], patch: MachinePatch = {}): MachineResult => ({ state: session.state, replies, patch, action: null, outcome: 'reprompt' })

  switch (session.state) {
    case 'language': {
      const picked = payload.startsWith('lang:') ? (payload.slice(5) as OnboardingLocale) : LANGUAGE_WORDS[body]
      if (picked !== 'en' && picked !== 'hi' && picked !== 'te') return stay(promptFor('language', session).slice(1))
      const answer = answerOf(session, inbound, 'language', picked)
      return advance({ ...session, locale: picked }, inbound, 'answered', { locale: picked, answers: [...session.answers, answer] }, answer)
    }

    case 'business_name': {
      const value = (inbound.text ?? '').trim()
      if (inbound.kind !== 'text' && inbound.kind !== 'audio') return stay([text(l, 'bad_business_name')])
      if (value.length < 2 || value.length > 100) return stay([text(l, 'bad_business_name')])
      const answer = answerOf(session, inbound, 'business_name', value)
      return advance(session, inbound, 'answered', { answers: [...session.answers, answer] }, answer)
    }

    case 'gstin': {
      const value = (inbound.text ?? '').replace(/\s+/g, '').toUpperCase()
      if (!gstinSchema.safeParse(value).success) return stay([text(l, 'bad_gstin')])
      const answer = answerOf(session, inbound, 'gstin', value)
      return advance(session, inbound, 'answered', { gstin: value, answers: [...session.answers, answer] }, answer)
    }

    case 'udyam': {
      if (payload === 'udyam:skip' || SKIP_WORDS.has(body)) {
        return advance(session, inbound, 'skipped', { udyam: null })
      }
      const value = (inbound.text ?? '').replace(/\s+/g, '').toUpperCase()
      if (!udyamSchema.safeParse(value).success) return stay([text(l, 'bad_udyam')])
      const answer = answerOf(session, inbound, 'udyam', value)
      return advance(session, inbound, 'answered', { udyam: value, answers: [...session.answers, answer] }, answer)
    }

    case 'categories': {
      const remaining = CATEGORY_SLUGS.filter((s) => !session.category_slugs.includes(s))
      let slug: CategorySlug | 'done' | null = null
      if (payload === 'cat:done' || DONE_WORDS.has(body)) slug = 'done'
      else if (payload.startsWith('cat:')) slug = (CATEGORY_SLUGS as readonly string[]).includes(payload.slice(4)) ? (payload.slice(4) as CategorySlug) : null
      else if (/^\d+$/.test(body)) slug = remaining[Number(body) - 1] ?? (Number(body) === remaining.length + 1 && session.category_slugs.length > 0 ? 'done' : null)
      else if (body) slug = remaining.find((s) => [onboardingCategoryName(s, 'en'), onboardingCategoryName(s, 'hi'), onboardingCategoryName(s, 'te'), s].some((n) => norm(n) === body)) ?? null
      if (slug === 'done') {
        if (session.category_slugs.length === 0) return stay([text(l, 'categories_need_one'), categoryButtons(session)])
        const answer = answerOf(session, inbound, 'categories', session.category_slugs.join(','))
        return advance(session, inbound, 'answered', { answers: [...session.answers, answer] }, answer)
      }
      if (!slug || session.category_slugs.includes(slug)) return stay([categoryButtons(session)])
      const picked = [...session.category_slugs, slug]
      const after = { ...session, category_slugs: picked }
      if (picked.length >= ONBOARDING_MAX_CATEGORIES) {
        const answer = answerOf(session, inbound, 'categories', picked.join(','))
        return advance(after, inbound, 'answered', { category_slugs: picked, answers: [...session.answers, answer] }, answer, [text(l, 'categories_full', { max: ONBOARDING_MAX_CATEGORIES })])
      }
      return stay([text(l, 'categories_picked', { category: onboardingCategoryName(slug, l), n: picked.length, max: ONBOARDING_MAX_CATEGORIES }), categoryButtons(after)], { category_slugs: picked })
    }

    case 'capabilities': {
      const p = capabilityProgress(session)
      if (!p.category) return advance(session, inbound, 'answered', {})
      if (inbound.kind === 'audio' && inbound.text === null) return stay([text(l, 'voice_failed_type_instead')])
      if (inbound.kind !== 'text' && inbound.kind !== 'audio') return stay(promptFor('capabilities', session))
      const value = (inbound.text ?? '').trim()
      if (value.length < MIN_ANSWER_CHARS) return stay([text(l, 'answer_too_short')])
      const answer = answerOf(session, inbound, 'capabilities', value, { category_slug: p.category, question_no: p.questionNo })
      const answers = [...session.answers, answer]
      if (p.answered + 1 >= p.total) return advance(session, inbound, 'answered', { answers }, answer)
      return { state: session.state, replies: promptFor('capabilities', { ...session, answers }), patch: { answers }, action: null, outcome: 'reprompt', answer }
    }

    case 'photos': {
      if (payload === 'photos:skip' || payload === 'photos:done' || SKIP_WORDS.has(body) || DONE_WORDS.has(body)) {
        return advance(session, inbound, session.photo_refs.length === 0 ? 'skipped' : 'answered', {})
      }
      if (inbound.kind === 'image' && inbound.mediaRef) {
        const refs = [...session.photo_refs, inbound.mediaRef].slice(0, ONBOARDING_MAX_PHOTOS)
        if (refs.length >= ONBOARDING_MAX_PHOTOS) {
          return advance({ ...session, photo_refs: refs }, inbound, 'answered', { photo_refs: refs }, undefined, [text(l, 'photos_full', { max: ONBOARDING_MAX_PHOTOS })])
        }
        return stay([text(l, 'photo_received', { n: refs.length, max: ONBOARDING_MAX_PHOTOS })], { photo_refs: refs })
      }
      return stay(promptFor('photos', session))
    }

    case 'drafting':
      // The model call is in flight (or failed and the runtime will move us on); ignore chatter.
      return { state: session.state, replies: [], patch: {}, action: null, outcome: 'noop' }

    case 'review': {
      const runId = session.draft_run_id
      if (runId && payload === `confirm:${runId}`) {
        return { state: 'confirmed', replies: [], patch: {}, action: 'confirm', outcome: 'confirm' }
      }
      if (runId && payload === `revise:${runId}`) {
        if (session.draft_count >= ONBOARDING_MAX_DRAFTS) return { state: 'handed_off', replies: [], patch: {}, action: 'cap_handoff', outcome: 'revise' }
        return { state: 'review', replies: [text(l, 'revise_ask')], patch: { revise_pending: true }, action: 'revise', outcome: 'revise' }
      }
      if (session.revise_pending && (inbound.kind === 'text' || inbound.kind === 'audio')) {
        const value = (inbound.text ?? '').trim()
        if (value.length < MIN_ANSWER_CHARS) return stay([text(l, 'answer_too_short')])
        const answer = answerOf(session, inbound, 'review', value)
        const answers = [...session.answers, answer]
        const next = nextOnboardingStep('review', 'revise')!
        return { state: next, replies: promptFor(next, session), patch: { answers, revise_pending: false }, action: 'draft', outcome: 'answered', answer }
      }
      // Free text on review (a typed "yes", anything): re-send the buttons, never confirm.
      return stay([text(l, 'review_buttons_reminder'), ...(runId ? [reviewButtons(session)] : [])])
    }

    default:
      return { state: session.state, replies: [], patch: {}, action: null, outcome: 'noop' }
  }
}

/** The business name the provider gave (an answer, not a column). */
export function businessNameOf(session: Pick<MachineSession, 'answers'>): string | null {
  const a = session.answers.find((x) => x.step === 'business_name')
  return a?.text.trim() || null
}
