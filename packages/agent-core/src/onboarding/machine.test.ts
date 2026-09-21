import { describe, expect, it } from 'vitest'
import { ONBOARDING_MAX_CATEGORIES, ONBOARDING_MAX_PHOTOS, type OnboardingStep } from '@amclub/shared'
import { businessNameOf, capabilityProgress, promptFor, stepMachine, type MachineInbound, type MachineSession, type OutboundMsg } from './machine'

/** In-memory session; no I/O anywhere in these tests. */
function session(over: Partial<MachineSession> = {}): MachineSession {
  return { id: 's1', state: 'language', locale: 'en', answers: [], photo_refs: [], category_slugs: [], gstin: null, udyam: null, draft_run_id: null, draft_count: 0, revise_pending: false, ...over }
}
let seq = 0
const msg = (over: Partial<MachineInbound> = {}): MachineInbound => ({ messageId: `00000000-0000-0000-0000-${String(++seq).padStart(12, '0')}`, kind: 'text', text: null, buttonPayload: null, mediaRef: null, ...over })
const text = (t: string) => msg({ kind: 'text', text: t })
const button = (id: string) => msg({ kind: 'button', buttonPayload: id, text: id })
const audio = (t: string | null) => msg({ kind: 'audio', text: t, transcriptVendor: 'stub' })
const image = (ref: string) => msg({ kind: 'image', mediaRef: ref })
const buttonsOf = (r: OutboundMsg[]) => r.filter((m): m is Extract<OutboundMsg, { type: 'buttons' }> => m.type === 'buttons')
/** Apply a result to the session the way the runtime persists it. */
function apply(s: MachineSession, r: ReturnType<typeof stepMachine>): MachineSession {
  return { ...s, ...r.patch, state: r.state } as MachineSession
}
/** Drive a session through the whole interview up to a given step. */
function upTo(step: OnboardingStep, cats: MachineSession['category_slugs'] = ['tax-accounting']): MachineSession {
  let s = session()
  const run = (i: MachineInbound) => { s = apply(s, stepMachine(s, i)) }
  if (step === 'language') return s
  run(button('lang:en'))
  if (step === 'business_name') return s
  run(text('Sri Lakshmi Tax Services'))
  if (step === 'gstin') return s
  run(text('37ABCDE1234F1Z5'))
  if (step === 'udyam') return s
  run(button('udyam:skip'))
  if (step === 'categories') return s
  for (const c of cats) run(button(`cat:${c}`))
  if (cats.length < ONBOARDING_MAX_CATEGORIES) run(button('cat:done'))
  if (step === 'capabilities') return s
  for (let i = 0; i < cats.length * 3; i++) run(text(`answer number ${i + 1} about our work`))
  if (step === 'photos') return s
  run(button('photos:skip'))
  if (step === 'drafting') return s
  s = { ...s, state: 'review', draft_run_id: 'run-draft-1', draft_count: 1 }
  return s
}

describe('language step', () => {
  it('opens with the welcome and three language buttons', () => {
    const p = promptFor('language', session(), { name: 'Ravi' })
    expect(p[0]).toMatchObject({ type: 'text' })
    expect((p[0] as { text: string }).text).toContain('Ravi')
    expect(buttonsOf(p)[0]!.buttons.map((b) => b.id)).toEqual(['lang:en', 'lang:hi', 'lang:te'])
  })
  it('a language button advances to business_name and switches the locale of the next prompt', () => {
    const r = stepMachine(session(), button('lang:te'))
    expect(r.state).toBe('business_name')
    expect(r.patch.locale).toBe('te')
    expect(r.outcome).toBe('answered')
    expect((r.replies[0] as { text: string }).text).toContain('వ్యాపారం')
  })
  it('typed language names and numbers are accepted; junk re-prompts without advancing', () => {
    expect(stepMachine(session(), text('hindi')).state).toBe('business_name')
    expect(stepMachine(session(), text('3')).patch.locale).toBe('te')
    expect(stepMachine(session(), text('తెలుగు')).patch.locale).toBe('te')
    const r = stepMachine(session(), text('whatever'))
    expect(r.state).toBe('language')
    expect(r.outcome).toBe('reprompt')
    expect(buttonsOf(r.replies)).toHaveLength(1)
  })
})

describe('business name step', () => {
  it('accepts a text name and records the answer', () => {
    const r = stepMachine(upTo('business_name'), text('  Sri Lakshmi   Tax Services '))
    expect(r.state).toBe('gstin')
    expect(r.answer).toMatchObject({ step: 'business_name', text: 'Sri Lakshmi   Tax Services', kind: 'text', redacted: false })
    expect(businessNameOf({ answers: r.patch.answers! })).toBe('Sri Lakshmi   Tax Services')
  })
  it('accepts a transcribed voice note, with the vendor tag', () => {
    const r = stepMachine(upTo('business_name'), audio('Ravi Traders'))
    expect(r.state).toBe('gstin')
    expect(r.answer).toMatchObject({ kind: 'audio', transcript_vendor: 'stub' })
  })
  it('rejects too short, too long, and an image', () => {
    for (const i of [text('x'), text('a'.repeat(101)), image('p.jpg')]) {
      const r = stepMachine(upTo('business_name'), i)
      expect(r.state).toBe('business_name')
      expect(r.outcome).toBe('reprompt')
    }
  })
})

describe('gstin step', () => {
  it('a bad GSTIN re-prompts and the state is unchanged', () => {
    const r = stepMachine(upTo('gstin'), text('29ABC'))
    expect(r.state).toBe('gstin')
    expect(r.patch.gstin).toBeUndefined()
    expect((r.replies[0] as { text: string }).text).toMatch(/GSTIN/)
  })
  it('a good GSTIN (spaces and lowercase tolerated) advances to udyam with the Skip button', () => {
    const r = stepMachine(upTo('gstin'), text('37abcde 1234f1z5'))
    expect(r.state).toBe('udyam')
    expect(r.patch.gstin).toBe('37ABCDE1234F1Z5')
    expect(buttonsOf(r.replies)[0]!.buttons[0]!.id).toBe('udyam:skip')
  })
})

describe('udyam step', () => {
  it('SKIP (button or word) moves on with udyam null', () => {
    for (const i of [button('udyam:skip'), text('skip'), text('नहीं')]) {
      const r = stepMachine(upTo('udyam'), i)
      expect(r.state).toBe('categories')
      expect(r.outcome).toBe('skipped')
      expect(r.patch.udyam).toBeNull()
    }
  })
  it('a valid Udyam number is stored; a bad one re-prompts', () => {
    const ok = stepMachine(upTo('udyam'), text('udyam-ap-01-0001234'))
    expect(ok.state).toBe('categories')
    expect(ok.patch.udyam).toBe('UDYAM-AP-01-0001234')
    const bad = stepMachine(upTo('udyam'), text('UDYAM-1'))
    expect(bad.state).toBe('udyam')
  })
})

describe('categories step', () => {
  it('shows all eight categories as a list and no Done until one is picked', () => {
    const p = buttonsOf(promptFor('categories', upTo('categories')))[0]!
    expect(p.buttons).toHaveLength(8)
    expect(p.buttons.some((b) => b.id === 'cat:done')).toBe(false)
    expect(p.listLabel).toBe('Choose')
  })
  it('picking a category stays on the step, records it, and offers Done + the remaining ones', () => {
    const r = stepMachine(upTo('categories'), button('cat:legal'))
    expect(r.state).toBe('categories')
    expect(r.patch.category_slugs).toEqual(['legal'])
    const b = buttonsOf(r.replies)[0]!
    expect(b.buttons).toHaveLength(8) // 7 remaining + Done
    expect(b.buttons.some((x) => x.id === 'cat:legal')).toBe(false)
    expect(b.buttons.some((x) => x.id === 'cat:done')).toBe(true)
  })
  it('Done with nothing picked re-prompts; Done with one picked advances to the first capability question', () => {
    const none = stepMachine(upTo('categories'), button('cat:done'))
    expect(none.state).toBe('categories')
    const s = apply(upTo('categories'), stepMachine(upTo('categories'), button('cat:legal')))
    const r = stepMachine(s, button('cat:done'))
    expect(r.state).toBe('capabilities')
    expect((r.replies[0] as { text: string }).text).toMatch(/Legal · question 1 of 3/)
  })
  it('the third category auto-advances (cap 3); a duplicate or unknown pick re-prompts', () => {
    let s = upTo('categories')
    s = apply(s, stepMachine(s, button('cat:legal')))
    s = apply(s, stepMachine(s, button('cat:web-tech')))
    const dup = stepMachine(s, button('cat:legal'))
    expect(dup.state).toBe('categories')
    const unknown = stepMachine(s, button('cat:nope'))
    expect(unknown.state).toBe('categories')
    const third = stepMachine(s, button('cat:hr-staffing'))
    expect(third.state).toBe('capabilities')
    expect(third.patch.category_slugs).toEqual(['legal', 'web-tech', 'hr-staffing'])
    expect((third.replies[0] as { text: string }).text).toMatch(/3/)
  })
  it('typed numbers and names work for BSPs without buttons', () => {
    const byNumber = stepMachine(upTo('categories'), text('3'))
    expect(byNumber.patch.category_slugs).toEqual(['legal'])
    const byName = stepMachine(upTo('categories'), text('Web & Tech'))
    expect(byName.patch.category_slugs).toEqual(['web-tech'])
    const byHindi = stepMachine(upTo('categories'), text('कानूनी सेवाएं'))
    expect(byHindi.patch.category_slugs).toEqual(['legal'])
  })
})

describe('capabilities step', () => {
  it('asks 3 × categories questions in order and advances to photos after the last', () => {
    let s = upTo('capabilities', ['tax-accounting', 'legal'])
    expect(capabilityProgress(s)).toEqual({ answered: 0, total: 6, category: 'tax-accounting', questionNo: 1 })
    for (let i = 0; i < 5; i++) {
      const r = stepMachine(s, text(`answer ${i + 1} in a few words`))
      expect(r.state).toBe('capabilities')
      expect(r.answer).toMatchObject({ step: 'capabilities', category_slug: i < 3 ? 'tax-accounting' : 'legal', question_no: (i % 3) + 1 })
      s = apply(s, r)
    }
    expect(capabilityProgress(s)).toMatchObject({ answered: 5, category: 'legal', questionNo: 3 })
    const last = stepMachine(s, audio('we charge two thousand per filing'))
    expect(last.state).toBe('photos')
    expect(last.answer).toMatchObject({ kind: 'audio', question_no: 3, category_slug: 'legal' })
    expect(buttonsOf(last.replies)[0]!.buttons.map((b) => b.id)).toEqual(['photos:skip', 'photos:done'])
  })
  it('a failed transcription (audio with null text) asks to type instead and stays', () => {
    const r = stepMachine(upTo('capabilities'), audio(null))
    expect(r.state).toBe('capabilities')
    expect((r.replies[0] as { text: string }).text).toMatch(/type/i)
    expect(r.answer).toBeUndefined()
  })
  it('a too-short answer or an image re-prompts without recording', () => {
    expect(stepMachine(upTo('capabilities'), text('ok')).answer).toBeUndefined()
    expect(stepMachine(upTo('capabilities'), image('x.jpg')).answer).toBeUndefined()
  })
  it('the redacted flag from the runtime is carried on the stored answer', () => {
    const r = stepMachine(upTo('capabilities'), msg({ kind: 'text', text: 'call me on [contact hidden] for GST work', redacted: true }))
    expect(r.answer?.redacted).toBe(true)
  })
})

describe('photos step', () => {
  it('images append media refs up to the cap, then auto-advance to drafting with the draft action', () => {
    let s = upTo('photos')
    for (let i = 1; i < ONBOARDING_MAX_PHOTOS; i++) {
      const r = stepMachine(s, image(`c/p${i}.jpg`))
      expect(r.state).toBe('photos')
      expect(r.patch.photo_refs).toHaveLength(i)
      s = apply(s, r)
    }
    const r = stepMachine(s, image('c/p5.jpg'))
    expect(r.state).toBe('drafting')
    expect(r.action).toBe('draft')
    expect(r.patch.photo_refs).toHaveLength(ONBOARDING_MAX_PHOTOS)
  })
  it('SKIP with no photos is a skip; Done after some photos is an answer; both enter drafting', () => {
    const skip = stepMachine(upTo('photos'), button('photos:skip'))
    expect(skip).toMatchObject({ state: 'drafting', outcome: 'skipped', action: 'draft' })
    const s = apply(upTo('photos'), stepMachine(upTo('photos'), image('c/a.jpg')))
    const done = stepMachine(s, text('done'))
    expect(done).toMatchObject({ state: 'drafting', outcome: 'answered', action: 'draft' })
  })
  it('a text message on photos just re-prompts', () => {
    const r = stepMachine(upTo('photos'), text('here is my shop'))
    expect(r.state).toBe('photos')
    expect(r.action).toBeNull()
  })
})

describe('drafting and review', () => {
  it('messages during drafting are ignored (noop)', () => {
    const r = stepMachine(upTo('drafting'), text('hello?'))
    expect(r).toMatchObject({ state: 'drafting', outcome: 'noop', action: null, replies: [] })
  })
  it('free text "yes" on review never confirms: the buttons are re-sent', () => {
    const r = stepMachine(upTo('review'), text('yes'))
    expect(r.state).toBe('review')
    expect(r.action).toBeNull()
    const b = buttonsOf(r.replies)[0]!
    expect(b.buttons.map((x) => x.id)).toEqual(['confirm:run-draft-1', 'revise:run-draft-1'])
  })
  it('the confirm button for THIS draft run confirms; a stale or foreign run id does not', () => {
    const ok = stepMachine(upTo('review'), button('confirm:run-draft-1'))
    expect(ok).toMatchObject({ state: 'confirmed', action: 'confirm', outcome: 'confirm' })
    const stale = stepMachine(upTo('review'), button('confirm:run-other'))
    expect(stale.state).toBe('review')
    expect(stale.action).toBeNull()
  })
  it('revise asks what should change, marks revise_pending, and the next text re-enters drafting (second draft)', () => {
    const s = upTo('review')
    const r1 = stepMachine(s, button('revise:run-draft-1'))
    expect(r1).toMatchObject({ state: 'review', action: 'revise', outcome: 'revise' })
    expect(r1.patch.revise_pending).toBe(true)
    const s2 = apply(s, r1)
    const r2 = stepMachine(s2, text('make the price 3000 per month'))
    expect(r2.state).toBe('drafting')
    expect(r2.action).toBe('draft')
    expect(r2.answer).toMatchObject({ step: 'review', text: 'make the price 3000 per month' })
    expect(r2.patch.revise_pending).toBe(false)
  })
  it('a revise after two drafts hands off with the cap (no confirmation, no third draft)', () => {
    const s = { ...upTo('review'), draft_count: 2, draft_run_id: 'run-draft-2' }
    const r = stepMachine(s, button('revise:run-draft-2'))
    expect(r).toMatchObject({ state: 'handed_off', action: 'cap_handoff' })
  })
})

describe('terminal states and prompts', () => {
  it('terminal sessions ignore everything', () => {
    for (const state of ['handed_off', 'abandoned', 'failed', 'confirmed'] as const) {
      const r = stepMachine(session({ state }), text('hi'))
      expect(r.outcome).toBe('noop')
      expect(r.state).toBe(state)
    }
  })
  it('hand-off, failure and expiry prompts carry the link', () => {
    for (const state of ['handed_off', 'failed', 'abandoned'] as const) {
      const p = promptFor(state, session(), { link: 'https://amclub.example/partner/onboarding?session=s1' })
      expect((p[0] as { text: string }).text).toContain('https://amclub.example/partner/onboarding?session=s1')
    }
  })
  it('the whole interview end to end yields the expected answer trail', () => {
    const s = upTo('review', ['tax-accounting', 'legal'])
    expect(s.answers.map((a) => a.step)).toEqual(['language', 'business_name', 'gstin', 'categories', ...Array(6).fill('capabilities')])
    expect(s.gstin).toBe('37ABCDE1234F1Z5')
    expect(s.udyam).toBeNull()
    expect(s.category_slugs).toEqual(['tax-accounting', 'legal'])
  })
})
