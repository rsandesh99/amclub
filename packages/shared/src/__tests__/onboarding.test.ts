import { describe, expect, it } from 'vitest'
import {
  AGENT_NAMES,
  CAPABILITY_QUESTIONS,
  CAPABILITY_QUESTIONS_PER_CATEGORY,
  CATEGORY_SLUGS,
  ONBOARDING_ACTIVE_STEPS,
  ONBOARDING_STEPS,
  ONBOARDING_TERMINAL_STEPS,
  ONBOARDING_TRANSITIONS,
  agentTool,
  capabilityFactsFromDraft,
  isValidOnboardingTransition,
  nextOnboardingStep,
  onboardingAnswerSchema,
  onboardingCopy,
  onboardingCopyIds,
  onboardingDraftSchema,
  parseAgentSetting,
  type OnboardingDraft,
  type OnboardingStep,
} from '../index'

const DRAFT: OnboardingDraft = {
  profile: { display_name: 'Sri Lakshmi Tax Services', legal_name: 'Sri Lakshmi Tax Services', about: 'GST and ITR filing for traders in Vijayawada.', city: 'Vijayawada', state: 'AP', languages: ['te', 'en'], category_slugs: ['tax-accounting'] },
  packages: [
    { category_slug: 'tax-accounting', title: 'Monthly GST filing', scope_included: ['GSTR-1 and GSTR-3B every month', ' 2A/2B reconciliation '], deliverables: ['Filed returns with acknowledgements', 'GSTR-1 and GSTR-3B every month'], price_paise: 250000, delivery_days: 5 },
  ],
  uncertain_fields: [],
}

describe('onboarding state machine', () => {
  it('every step has a defined successor set and every successor is a known step', () => {
    for (const step of ONBOARDING_STEPS) {
      const next = ONBOARDING_TRANSITIONS[step]
      expect(Array.isArray(next), step).toBe(true)
      for (const n of next) expect(ONBOARDING_STEPS).toContain(n)
    }
    expect(Object.keys(ONBOARDING_TRANSITIONS).sort()).toEqual([...ONBOARDING_STEPS].sort())
  })

  it('abandoned / failed / handed_off are terminal', () => {
    for (const t of ONBOARDING_TERMINAL_STEPS) {
      expect(ONBOARDING_TRANSITIONS[t]).toEqual([])
      for (const ev of ['answered', 'skipped', 'revise', 'confirm', 'expire', 'error'] as const) expect(nextOnboardingStep(t, ev)).toBeNull()
    }
  })

  it('confirmed can only go to handed_off and never back', () => {
    expect(ONBOARDING_TRANSITIONS.confirmed).toEqual(['handed_off'])
    expect(nextOnboardingStep('confirmed', 'answered')).toBe('handed_off')
    expect(nextOnboardingStep('confirmed', 'revise')).toBeNull()
    expect(nextOnboardingStep('confirmed', 'expire')).toBeNull()
    expect(nextOnboardingStep('confirmed', 'error')).toBeNull()
    expect(isValidOnboardingTransition('confirmed', 'review')).toBe(false)
  })

  it('walks the linear interview on answered', () => {
    const order: OnboardingStep[] = ['language', 'business_name', 'gstin', 'udyam', 'categories', 'capabilities', 'photos', 'drafting', 'review']
    for (let i = 0; i < order.length - 1; i++) expect(nextOnboardingStep(order[i]!, 'answered')).toBe(order[i + 1])
  })

  it('skip is honoured only on udyam and photos', () => {
    expect(nextOnboardingStep('udyam', 'skipped')).toBe('categories')
    expect(nextOnboardingStep('photos', 'skipped')).toBe('drafting')
    for (const s of ['language', 'business_name', 'gstin', 'categories', 'capabilities', 'review'] as const) expect(nextOnboardingStep(s, 'skipped')).toBeNull()
  })

  it('review loops back to drafting on revise and forward on confirm; nowhere else', () => {
    expect(nextOnboardingStep('review', 'revise')).toBe('drafting')
    expect(nextOnboardingStep('review', 'confirm')).toBe('confirmed')
    expect(nextOnboardingStep('photos', 'confirm')).toBeNull()
    expect(nextOnboardingStep('drafting', 'revise')).toBeNull()
    // The cap hand-off (two drafts, another revise) is a legal edge without a confirmation.
    expect(isValidOnboardingTransition('review', 'handed_off')).toBe(true)
  })

  it('expire and error are valid from every active step', () => {
    for (const s of ONBOARDING_ACTIVE_STEPS) {
      expect(nextOnboardingStep(s, 'expire')).toBe('abandoned')
      expect(nextOnboardingStep(s, 'error')).toBe('failed')
    }
  })
})

describe('onboarding draft schema (strict)', () => {
  it('accepts a well-formed draft', () => {
    expect(onboardingDraftSchema.safeParse(DRAFT).success).toBe(true)
  })

  it('rejects verification / approval / status keys the model might add', () => {
    for (const extra of [{ verified: true }, { status: 'active' }, { approved: true }, { gstin_verified: true }, { rating: 5 }]) {
      expect(onboardingDraftSchema.safeParse({ ...DRAFT, ...extra }).success, JSON.stringify(extra)).toBe(false)
      expect(onboardingDraftSchema.safeParse({ ...DRAFT, profile: { ...DRAFT.profile, ...extra } }).success, `profile ${JSON.stringify(extra)}`).toBe(false)
      expect(onboardingDraftSchema.safeParse({ ...DRAFT, packages: [{ ...DRAFT.packages[0], ...extra }] }).success, `package ${JSON.stringify(extra)}`).toBe(false)
    }
  })

  it('caps packages at three, categories at three, and refuses invented money (must be positive int or null)', () => {
    expect(onboardingDraftSchema.safeParse({ ...DRAFT, packages: [DRAFT.packages[0], DRAFT.packages[0], DRAFT.packages[0], DRAFT.packages[0]] }).success).toBe(false)
    expect(onboardingDraftSchema.safeParse({ ...DRAFT, profile: { ...DRAFT.profile, category_slugs: ['legal', 'web-tech', 'hr-staffing', 'tax-accounting'] } }).success).toBe(false)
    expect(onboardingDraftSchema.safeParse({ ...DRAFT, packages: [{ ...DRAFT.packages[0], price_paise: 12.5 }] }).success).toBe(false)
    expect(onboardingDraftSchema.safeParse({ ...DRAFT, packages: [{ ...DRAFT.packages[0], price_paise: null, delivery_days: null }] }).success).toBe(true)
  })

  it('an answer row validates and carries the redacted flag', () => {
    expect(onboardingAnswerSchema.safeParse({ step: 'capabilities', text: 'GST filing', wa_message_id: '00000000-0000-0000-0000-000000000000', kind: 'audio', transcript_vendor: 'stub', redacted: false, category_slug: 'tax-accounting', question_no: 1 }).success).toBe(true)
    expect(onboardingAnswerSchema.safeParse({ step: 'nope', text: 'x', wa_message_id: 'x', kind: 'text', redacted: false }).success).toBe(false)
  })
})

describe('capability facts from a confirmed draft', () => {
  it('one fact per scope/deliverable line, deduped case-insensitively, trimmed, with the category and locale', () => {
    const facts = capabilityFactsFromDraft(DRAFT, 'te')
    expect(facts.map((f) => f.fact)).toEqual(['GSTR-1 and GSTR-3B every month', '2A/2B reconciliation', 'Filed returns with acknowledgements'])
    for (const f of facts) expect(f).toMatchObject({ category_slug: 'tax-accounting', locale: 'te' })
  })
  it('caps each fact at 300 characters', () => {
    const long = 'x'.repeat(400)
    const facts = capabilityFactsFromDraft({ ...DRAFT, packages: [{ ...DRAFT.packages[0]!, scope_included: [long], deliverables: ['y'] }] }, 'en')
    expect(facts[0]!.fact.length).toBe(300)
  })
})

describe('interview copy', () => {
  it('every message id exists in en, hi and te, renders without {{ and every capability key resolves', () => {
    const ids = onboardingCopyIds()
    expect(ids.length).toBeGreaterThan(60)
    const params = { name: 'Ravi', max: 3, n: 1, total: 3, category: 'Legal', question: 'Q', fields: 'about', link: 'https://x', display_name: 'A', legal_name: 'B', city: 'C', state: 'D', languages: 'E', categories: 'F', about: 'G', title: 'T', scope: 'S', deliverables: 'DL', price: '₹1', days: 3 }
    for (const id of ids) {
      for (const locale of ['en', 'hi', 'te'] as const) {
        const s = onboardingCopy(id, locale, params)
        expect(s.length, `${id}/${locale}`).toBeGreaterThan(0)
        expect(s, `${id}/${locale} has {{`).not.toContain('{{')
        expect(s, `${id}/${locale} left a token`).not.toMatch(/\{[a-z_]+\}/)
      }
    }
    for (const slug of CATEGORY_SLUGS) {
      expect(CAPABILITY_QUESTIONS[slug]).toHaveLength(CAPABILITY_QUESTIONS_PER_CATEGORY)
      for (const key of CAPABILITY_QUESTIONS[slug]) expect(ids).toContain(key)
    }
  })
  it('throws on an unknown id and falls back to English', () => {
    expect(() => onboardingCopy('nope' as never, 'en')).toThrow(/unknown/)
    expect(onboardingCopy('btn_done', 'te')).toBe('Done')
  })
})

describe('S1.6 registry entries', () => {
  it('confirm_onboarding_draft is a provider tool, confirm:true, local', () => {
    const t = agentTool('confirm_onboarding_draft')
    expect(t.persona).toBe('provider')
    expect(t.confirm).toBe(true)
    expect(t.wraps.startsWith('local')).toBe(true)
  })
  it('budget_run_paise_by_agent accepts only known agents and non-negative paise', () => {
    expect(parseAgentSetting('budget_run_paise_by_agent', {}).ok).toBe(true)
    expect(parseAgentSetting('budget_run_paise_by_agent', { onboarding: 1500 }).ok).toBe(true)
    expect(parseAgentSetting('budget_run_paise_by_agent', { onboarding: -1 }).ok).toBe(false)
    expect(parseAgentSetting('budget_run_paise_by_agent', { not_an_agent: 5 }).ok).toBe(false)
    for (const n of AGENT_NAMES) expect(parseAgentSetting('budget_run_paise_by_agent', { [n]: 0 }).ok).toBe(true)
  })
  it('onboarding_session_ttl_hours is 1..168 with default 72', () => {
    expect(parseAgentSetting('onboarding_session_ttl_hours', 72).ok).toBe(true)
    expect(parseAgentSetting('onboarding_session_ttl_hours', 0).ok).toBe(false)
    expect(parseAgentSetting('onboarding_session_ttl_hours', 169).ok).toBe(false)
  })
})
