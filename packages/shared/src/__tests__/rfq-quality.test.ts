import { describe, expect, it } from 'vitest'
import {
  AGENT_SETTING_DEFS,
  RFQ_QUALITY_GAPS,
  RFQ_QUALITY_LOCALES,
  RFQ_QUALITY_STUB_QUESTIONS,
  agentTool,
  isRfqDeferred,
  mentionsIndianPlace,
  mergeQualityReport,
  rfqQualityAnswerSchema,
  rfqQualityDeadline,
  rfqQualityModelOutputSchema,
  rfqQualityPrecheck,
  rfqQualityReportSchema,
  stubQuestionFor,
  titleContentWords,
  type RfqTemplate,
} from '../index'

// Seeded templates (packages/db/src/seed.ts), reduced to what the precheck reads.
const LEGAL: RfqTemplate = {
  fields: [
    { name: 'legal_service', type: 'select', label_en: 'Service Required', label_hi: 'आवश्यक सेवा', required: true, options: ['Trademark Registration', 'Contract Drafting'] },
    { name: 'urgency', type: 'select', label_en: 'Urgency', label_hi: 'अत्यावश्यकता', required: true, options: ['Within 3 days', 'No rush'] },
    { name: 'languages', type: 'select', label_en: 'Preferred Language', label_hi: 'पसंदीदा भाषा', required: false, options: ['English'] },
    { name: 'notes', type: 'textarea', label_en: 'Describe Your Legal Need', label_hi: 'अपनी कानूनी आवश्यकता बताएं', required: true },
  ],
}
const HR: RfqTemplate = {
  fields: [
    { name: 'hr_service', type: 'select', label_en: 'Service Type', label_hi: 'सेवा प्रकार', required: true, options: ['Permanent Recruitment'] },
    { name: 'headcount', type: 'select', label_en: 'Headcount Needed', label_hi: 'आवश्यक कर्मचारी संख्या', required: false, options: ['1–5', '6–20'] },
    { name: 'role_type', type: 'text', label_en: 'Role / Department', label_hi: 'भूमिका / विभाग', required: false },
    { name: 'notes', type: 'textarea', label_en: 'Additional Requirements', label_hi: 'अतिरिक्त आवश्यकताएं', required: false },
  ],
}
const LICENSING: RfqTemplate = {
  fields: [
    { name: 'license_type', type: 'select', label_en: 'License / Scheme', label_hi: 'लाइसेंस / योजना', required: true, options: ['Factory Licence'] },
    { name: 'state', type: 'text', label_en: 'State', label_hi: 'राज्य', required: true },
    { name: 'urgency', type: 'select', label_en: 'Urgency', label_hi: 'अत्यावश्यकता', required: false, options: ['Urgent (< 1 week)'] },
    { name: 'notes', type: 'textarea', label_en: 'Additional Details', label_hi: 'अतिरिक्त विवरण', required: false },
  ],
}
const WEB: RfqTemplate = {
  fields: [
    { name: 'tech_service', type: 'select', label_en: 'Service Required', label_hi: 'आवश्यक सेवा', required: true, options: ['Business Website'] },
    { name: 'budget_range', type: 'select', label_en: 'Budget Range', label_hi: 'बजट सीमा', required: false, options: ['< ₹15,000'] },
    { name: 'timeline', type: 'select', label_en: 'Expected Timeline', label_hi: 'अपेक्षित समय', required: true, options: ['< 2 weeks'] },
    { name: 'notes', type: 'textarea', label_en: 'Features / Requirements', label_hi: 'फीचर / आवश्यकताएं', required: false },
  ],
}
const LONG = 'We run a 12-person garment unit in Tirupur and need a supplier contract drafted with penalty clauses, delivery SLAs and an arbitration clause under Indian law.'
const base = { budgetMinPaise: null as number | null, budgetMaxPaise: null as number | null, neededBy: null as string | null, recentOpenSameCategory: false }

describe('rfqQualityPrecheck — required fields', () => {
  it('lists required template fields that are empty or whitespace', () => {
    const r = rfqQualityPrecheck({ ...base, categorySlug: 'legal', template: LEGAL, title: 'Need a trademark registered', details: { legal_service: 'Trademark Registration', urgency: '  ', notes: '' } })
    expect(r.missingRequired).toEqual(['urgency', 'notes'])
  })
  it('a filled required field is not missing; optional fields never are', () => {
    const r = rfqQualityPrecheck({ ...base, categorySlug: 'legal', template: LEGAL, title: 'Supplier contract drafting for garment unit', details: { legal_service: 'Contract Drafting', urgency: 'No rush', notes: LONG } })
    expect(r.missingRequired).toEqual([])
  })
  it('no template → nothing required, generic gaps still run', () => {
    const r = rfqQualityPrecheck({ ...base, categorySlug: 'unknown', template: null, title: 'need printing', details: {} })
    expect(r.missingRequired).toEqual([])
    expect(r.gaps).toEqual(expect.arrayContaining(['quantity', 'location', 'timeline', 'budget']))
  })
})

describe('rfqQualityPrecheck — generic gaps', () => {
  it('quantity fires for a quantity-bearing template with no digit and the field empty (hr headcount)', () => {
    const r = rfqQualityPrecheck({ ...base, categorySlug: 'hr-staffing', template: HR, title: 'Hire warehouse staff for our Pune unit', details: { hr_service: 'Permanent Recruitment', notes: 'Looking for reliable pickers and packers for a new warehouse, day and night shifts, food provided.' } })
    expect(r.gaps).toContain('quantity')
  })
  it('quantity is satisfied by a digit anywhere OR a filled quantity-like field', () => {
    const digit = rfqQualityPrecheck({ ...base, categorySlug: 'hr-staffing', template: HR, title: 'Hire 8 warehouse staff for our Pune unit', details: { hr_service: 'Permanent Recruitment', notes: LONG } })
    expect(digit.gaps).not.toContain('quantity')
    const field = rfqQualityPrecheck({ ...base, categorySlug: 'hr-staffing', template: HR, title: 'Hire warehouse staff for our Pune unit', details: { hr_service: 'Permanent Recruitment', headcount: '6–20', notes: LONG } })
    expect(field.gaps).not.toContain('quantity')
  })
  it('quantity does NOT fire for a professional-services template with no quantity field (legal)', () => {
    const r = rfqQualityPrecheck({ ...base, categorySlug: 'legal', template: LEGAL, title: 'Trademark registration for my brand', details: { legal_service: 'Trademark Registration', urgency: 'No rush', notes: LONG } })
    expect(r.gaps).not.toContain('quantity')
  })
  it('location fires only for a template with a location-like field left empty (optional) and no place in the text', () => {
    const optionalLoc: RfqTemplate = { fields: [{ name: 'site_city', type: 'text', label_en: 'Site city', label_hi: 'शहर', required: false }, { name: 'notes', type: 'textarea', label_en: 'Notes', label_hi: 'नोट', required: false }] }
    expect(rfqQualityPrecheck({ ...base, categorySlug: 'x', template: optionalLoc, title: 'Factory licence renewal help needed', details: { notes: LONG } }).gaps).toContain('location')
    // Tirupur is not in the city list but "Indian law" is not a place either — a state name satisfies it:
    expect(rfqQualityPrecheck({ ...base, categorySlug: 'x', template: optionalLoc, title: 'Factory licence renewal in Tamil Nadu', details: { notes: LONG } }).gaps).not.toContain('location')
    // A REQUIRED location field left empty is reported once, as missingRequired, not twice:
    const lic = rfqQualityPrecheck({ ...base, categorySlug: 'government-licensing', template: LICENSING, title: 'Factory licence for a new unit', details: { license_type: 'Factory Licence', notes: LONG } })
    expect(lic.missingRequired).toContain('state')
    expect(lic.gaps).not.toContain('location')
  })
  it('mentionsIndianPlace recognises state names, standalone codes and major cities', () => {
    expect(mentionsIndianPlace('unit in Karnataka')).toBe(true)
    expect(mentionsIndianPlace('shipping to KA next week')).toBe(true)
    expect(mentionsIndianPlace('office in Hyderabad')).toBe(true)
    expect(mentionsIndianPlace('nothing here')).toBe(false)
    expect(mentionsIndianPlace('karma is not a code')).toBe(false)
  })
  it('timeline fires when needed_by is null, no timeline-like field is filled and the text has no time words', () => {
    const r = rfqQualityPrecheck({ ...base, categorySlug: 'hr-staffing', template: HR, title: 'Hire 8 warehouse staff for our Pune unit', details: { hr_service: 'Permanent Recruitment', notes: LONG } })
    expect(r.gaps).toContain('timeline')
    expect(rfqQualityPrecheck({ ...base, neededBy: '2026-10-15', categorySlug: 'hr-staffing', template: HR, title: 'Hire 8 warehouse staff for our Pune unit', details: { hr_service: 'Permanent Recruitment', notes: LONG } }).gaps).not.toContain('timeline')
    expect(rfqQualityPrecheck({ ...base, categorySlug: 'hr-staffing', template: HR, title: 'Hire 8 warehouse staff within 2 weeks', details: { hr_service: 'Permanent Recruitment', notes: LONG } }).gaps).not.toContain('timeline')
    // A filled urgency field counts; a REQUIRED empty one is missingRequired, not a second gap.
    expect(rfqQualityPrecheck({ ...base, categorySlug: 'legal', template: LEGAL, title: 'Trademark registration for my brand', details: { legal_service: 'Trademark Registration', urgency: 'No rush', notes: LONG } }).gaps).not.toContain('timeline')
    const req = rfqQualityPrecheck({ ...base, categorySlug: 'legal', template: LEGAL, title: 'Trademark registration for my brand', details: { legal_service: 'Trademark Registration', notes: LONG } })
    expect(req.missingRequired).toContain('urgency')
    expect(req.gaps).not.toContain('timeline')
  })
  it('budget is a gap when both paise fields are null and no budget-like field is filled — never a risk', () => {
    const r = rfqQualityPrecheck({ ...base, categorySlug: 'legal', template: LEGAL, title: 'Trademark registration for my brand', details: { legal_service: 'Trademark Registration', urgency: 'No rush', notes: LONG } })
    expect(r.gaps).toContain('budget')
    expect(r.risks).not.toContain('budget_below_floor')
    expect(rfqQualityPrecheck({ ...base, budgetMaxPaise: 500_000, categorySlug: 'legal', template: LEGAL, title: 'Trademark registration for my brand', details: { legal_service: 'Trademark Registration', urgency: 'No rush', notes: LONG } }).gaps).not.toContain('budget')
    expect(rfqQualityPrecheck({ ...base, categorySlug: 'web-tech', template: WEB, title: 'Business website with 5 pages', details: { tech_service: 'Business Website', budget_range: '< ₹15,000', timeline: '< 2 weeks', notes: LONG } }).gaps).not.toContain('budget')
  })
  it('specs fires when the first textarea has fewer than 80 characters (and is not already a missing required field)', () => {
    const thin = rfqQualityPrecheck({ ...base, categorySlug: 'hr-staffing', template: HR, title: 'Hire 8 warehouse staff for our Pune unit by March', details: { hr_service: 'Permanent Recruitment', notes: 'pickers and packers' } })
    expect(thin.gaps).toContain('specs')
    const rich = rfqQualityPrecheck({ ...base, categorySlug: 'hr-staffing', template: HR, title: 'Hire 8 warehouse staff for our Pune unit by March', details: { hr_service: 'Permanent Recruitment', notes: LONG } })
    expect(rich.gaps).not.toContain('specs')
    const requiredEmpty = rfqQualityPrecheck({ ...base, categorySlug: 'legal', template: LEGAL, title: 'Trademark registration for my brand', details: { legal_service: 'Trademark Registration', urgency: 'No rush' } })
    expect(requiredEmpty.missingRequired).toContain('notes')
    expect(requiredEmpty.gaps).not.toContain('specs')
  })
  it('a complete legal RFQ has no gaps beyond budget when no budget is stated, and none at all with one', () => {
    const r = rfqQualityPrecheck({ ...base, budgetMaxPaise: 1_500_000, categorySlug: 'legal', template: LEGAL, title: 'Supplier contract drafting for garment unit', details: { legal_service: 'Contract Drafting', urgency: 'Within 1 week', notes: LONG } })
    expect(r.missingRequired).toEqual([])
    expect(r.gaps).toEqual([])
  })
})

describe('rfqQualityPrecheck — risks', () => {
  it('contact_info_in_text fires on a phone in the title or an email in any detail', () => {
    expect(rfqQualityPrecheck({ ...base, categorySlug: 'legal', template: LEGAL, title: 'Call me on 98765 43210 for trademark', details: { legal_service: 'Trademark Registration', urgency: 'No rush', notes: LONG } }).risks).toContain('contact_info_in_text')
    expect(rfqQualityPrecheck({ ...base, categorySlug: 'legal', template: LEGAL, title: 'Trademark registration for my brand', details: { legal_service: 'Trademark Registration', urgency: 'No rush', notes: `${LONG} write to me at ops@example.com` } }).risks).toContain('contact_info_in_text')
    expect(rfqQualityPrecheck({ ...base, categorySlug: 'legal', template: LEGAL, title: 'Trademark registration for my brand', details: { legal_service: 'Trademark Registration', urgency: 'No rush', notes: LONG } }).risks).not.toContain('contact_info_in_text')
  })
  it('title_too_vague: fewer than three content words after stop-words (English + Hinglish)', () => {
    expect(titleContentWords('need printing')).toEqual(['printing'])
    expect(titleContentWords('GST filing chahiye')).toEqual(['gst', 'filing'])
    expect(rfqQualityPrecheck({ ...base, categorySlug: 'legal', template: LEGAL, title: 'Need a lawyer', details: {} }).risks).toContain('title_too_vague')
    expect(rfqQualityPrecheck({ ...base, categorySlug: 'legal', template: LEGAL, title: 'Supplier contract drafting for garment unit', details: {} }).risks).not.toContain('title_too_vague')
  })
  it('description_too_short: total free text under 40 characters', () => {
    expect(rfqQualityPrecheck({ ...base, categorySlug: 'legal', template: LEGAL, title: 'Need a lawyer', details: { notes: 'asap' } }).risks).toContain('description_too_short')
    expect(rfqQualityPrecheck({ ...base, categorySlug: 'legal', template: LEGAL, title: 'Need a lawyer', details: { notes: LONG } }).risks).not.toContain('description_too_short')
  })
  it('budget_below_floor is skipped with a note (no category floor on this tree); duplicate_recent is a pass-through', () => {
    const r = rfqQualityPrecheck({ ...base, budgetMaxPaise: 1, recentOpenSameCategory: true, categorySlug: 'legal', template: LEGAL, title: 'Supplier contract drafting for garment unit', details: { notes: LONG } })
    expect(r.risks).not.toContain('budget_below_floor')
    expect(r.notes).toContain('budget_floor_unavailable')
    expect(r.risks).toContain('duplicate_recent')
  })
})

describe('mergeQualityReport — union rule', () => {
  const pre = { missingRequired: ['urgency'], gaps: ['budget'] as const, risks: ['title_too_vague'] as const, notes: [] as string[] }
  const preMut = { missingRequired: [...pre.missingRequired], gaps: [...pre.gaps], risks: [...pre.risks], notes: [] }
  it('rule items first (required, then gaps), model adds a NEW field, cap three, dedupe by field', () => {
    const r = mergeQualityReport(preMut, { specific_enough: false, gaps: [{ field: 'budget', question: 'What is your budget?' }, { field: 'brand_name', question: 'Which brand name or logo is the trademark for?', why: 'needed to search' }, { field: 'classes', question: 'Which trademark classes?' }] }, { locale: 'en', template: LEGAL })
    expect(r.missing.map((m) => `${m.source}:${m.field}`)).toEqual(['rule:urgency', 'rule:budget', 'model:brand_name'])
    expect(r.missing[0]!.question).toBe('Please fill in: Urgency')
    expect(r.missing[2]!.why).toBe('needed to search')
    expect(r.complete).toBe(false)
    expect(r.risk_flags).toEqual(['title_too_vague'])
    expect(rfqQualityReportSchema.safeParse(r).success).toBe(true)
  })
  it('the model can never remove a rule item; a null model gives a rule-only report', () => {
    const r = mergeQualityReport(preMut, null, { locale: 'hi', template: LEGAL })
    expect(r.missing.map((m) => m.field)).toEqual(['urgency', 'budget'])
    expect(r.missing[0]!.question).toBe('कृपया भरें: अत्यावश्यकता')
    expect(r.missing[1]!.question).toBe(RFQ_QUALITY_STUB_QUESTIONS.budget.hi)
    expect(r.locale).toBe('hi')
  })
  it('complete only when there is nothing to ask; risks never block', () => {
    const clean = { missingRequired: [], gaps: [], risks: ['duplicate_recent' as const], notes: [] }
    expect(mergeQualityReport(clean, { specific_enough: true, gaps: [] }, { locale: 'en', template: LEGAL }).complete).toBe(true)
    expect(mergeQualityReport(clean, { specific_enough: false, gaps: [{ field: 'size', question: 'What size are the flyers?' }] }, { locale: 'en', template: LEGAL }).complete).toBe(false)
  })
  it('drops a model question that asks for contact details, and questions too short to mean anything', () => {
    const clean = { missingRequired: [], gaps: [], risks: [], notes: [] }
    const r = mergeQualityReport(clean, { specific_enough: false, gaps: [{ field: 'contact', question: 'What is your WhatsApp number?' }, { field: 'x', question: 'why?' }, { field: 'size', question: 'What size are the flyers?' }] }, { locale: 'en', template: null })
    expect(r.missing.map((m) => m.field)).toEqual(['size'])
  })
  it('when the rules alone exceed the cap, required fields win and the model adds nothing', () => {
    const many = { missingRequired: ['a', 'b'], gaps: ['budget', 'timeline'] as const, risks: [], notes: [] }
    const r = mergeQualityReport({ ...many, gaps: [...many.gaps], risks: [] }, { specific_enough: false, gaps: [{ field: 'z', question: 'Anything else you can tell us?' }] }, { locale: 'ta', template: null })
    expect(r.missing.map((m) => m.field)).toEqual(['a', 'b', 'budget'])
    expect(r.missing).toHaveLength(3)
  })
})

describe('contracts, stubs, deadline, tools, settings', () => {
  it('report schema is strict and capped; model output schema is strict', () => {
    expect(rfqQualityReportSchema.safeParse({ complete: true, missing: [], risk_flags: [], locale: 'en', rank: 1 }).success).toBe(false)
    expect(rfqQualityReportSchema.safeParse({ complete: false, missing: Array(4).fill({ field: 'a', question: 'What is it?', source: 'rule' }), risk_flags: [], locale: 'en' }).success).toBe(false)
    expect(rfqQualityModelOutputSchema.safeParse({ specific_enough: true, gaps: [], extra: 1 }).success).toBe(false)
    expect(rfqQualityModelOutputSchema.safeParse({ specific_enough: false, gaps: [{ field: 'f', question: 'How many pages?' }] }).success).toBe(true)
  })
  it('answer schema: 1..3 trimmed answers, keys ≤ 60', () => {
    expect(rfqQualityAnswerSchema.safeParse({ answers: {} }).success).toBe(false)
    expect(rfqQualityAnswerSchema.parse({ answers: { budget: '  about 50k  ' } }).answers['budget']).toBe('about 50k')
    expect(rfqQualityAnswerSchema.safeParse({ answers: { a: '1', b: '2', c: '3', d: '4' } }).success).toBe(false)
  })
  it('stub questions exist for every gap in every locale, and the required stub fills the label per locale', () => {
    for (const g of [...RFQ_QUALITY_GAPS, 'required'] as const) for (const l of RFQ_QUALITY_LOCALES) expect(RFQ_QUALITY_STUB_QUESTIONS[g][l].length).toBeGreaterThan(5)
    expect(stubQuestionFor('urgency', 'en', LEGAL)).toBe('Please fill in: Urgency')
    expect(stubQuestionFor('urgency', 'te', LEGAL)).toBe('దయచేసి పూరించండి: Urgency') // no te label on this field → English label (rfqFieldLabel fallback)
    expect(stubQuestionFor('unknown_field', 'en', null)).toBe('Please fill in: unknown field')
    expect(stubQuestionFor('timeline', 'ta', null)).toBe(RFQ_QUALITY_STUB_QUESTIONS.timeline.ta)
  })
  it('deadline and derived deferred state', () => {
    expect(rfqQualityDeadline('2026-09-21T10:00:00.000Z', 30)).toBe('2026-09-21T10:30:00.000Z')
    expect(isRfqDeferred({ status: 'open', fanoutAt: null })).toBe(true)
    expect(isRfqDeferred({ status: 'open', fanoutAt: '2026-09-21T10:00:00.000Z' })).toBe(false)
    expect(isRfqDeferred({ status: 'expired', fanoutAt: null })).toBe(false)
  })
  it('tools: check_rfq_quality is a local, confirm:false read; complete_rfq wraps the POSTs and is confirm:true', () => {
    expect(agentTool('check_rfq_quality')).toMatchObject({ persona: 'buyer', confirm: false, taskClass: 'rfq_quality', wraps: 'local (questions only)' })
    expect(agentTool('complete_rfq')).toMatchObject({ persona: 'buyer', confirm: true, wraps: 'POST /rfq/[id]/quality/{answer|send}' })
  })
  it('rfq_quality_hold_minutes is registered: int 5..180, default 30', () => {
    const def = AGENT_SETTING_DEFS.rfq_quality_hold_minutes
    expect(def.default).toBe(30)
    expect(def.schema.safeParse(4).success).toBe(false)
    expect(def.schema.safeParse(181).success).toBe(false)
    expect(def.schema.safeParse(45).success).toBe(true)
  })
})
