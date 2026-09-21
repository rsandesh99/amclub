import { describe, expect, it } from 'vitest'
import type { OnboardingDraft } from '@amclub/shared'
import { chunkText, formatPaiseINR, renderDraftSummary } from './render'

const DRAFT: OnboardingDraft = {
  profile: { display_name: 'Sri Lakshmi Tax Services', legal_name: null, about: 'GST and ITR filing for traders.', city: 'Vijayawada', state: 'AP', languages: ['te', 'en'], category_slugs: ['tax-accounting'] },
  packages: [
    { category_slug: 'tax-accounting', title: 'Monthly GST filing', scope_included: ['GSTR-1', 'GSTR-3B'], deliverables: ['Filed returns'], price_paise: 250000, delivery_days: 5 },
    { category_slug: 'tax-accounting', title: 'Annual ITR', scope_included: ['ITR-3'], deliverables: ['Acknowledgement'], price_paise: null, delivery_days: null },
  ],
  uncertain_fields: ['packages.1.price_paise'],
}

describe('renderDraftSummary', () => {
  it('renders from the validated draft: money as ₹ from paise, "not stated" for nulls, in the locale', () => {
    const en = renderDraftSummary(DRAFT, 'en').join('\n\n')
    expect(en).toContain('Business: Sri Lakshmi Tax Services')
    expect(en).toContain('Legal name: not stated')
    expect(en).toContain('Languages: Telugu, English')
    expect(en).toContain('Services: Tax & Accounting')
    expect(en).toContain('Listing 1: Monthly GST filing (Tax & Accounting)')
    expect(en).toContain('Price: ₹2,500')
    expect(en).toContain('Delivery: 5 days')
    expect(en).toContain('Price: not stated')
    expect(en).toContain('I was not sure about: packages.1.price_paise')
    const te = renderDraftSummary(DRAFT, 'te').join('\n\n')
    expect(te).toContain('వ్యాపారం: Sri Lakshmi Tax Services')
    expect(te).toContain('ధర: చెప్పలేదు')
    expect(te).toContain('పన్ను & అకౌంటింగ్')
  })
  it('chunks at 1024 characters on line boundaries', () => {
    const big: OnboardingDraft = { ...DRAFT, profile: { ...DRAFT.profile, about: 'x'.repeat(900) }, packages: [DRAFT.packages[0]!, DRAFT.packages[0]!, DRAFT.packages[0]!] }
    const chunks = renderDraftSummary(big, 'hi')
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1024)
    expect(chunkText('a\nb', 10)).toEqual(['a\nb'])
    expect(chunkText(`${'a'.repeat(8)}\n${'b'.repeat(8)}`, 10)).toEqual(['a'.repeat(8), 'b'.repeat(8)])
  })
  it('formats paise as Indian rupees', () => {
    expect(formatPaiseINR(250000)).toBe('₹2,500')
    expect(formatPaiseINR(123456789)).toBe('₹12,34,567.89')
    expect(formatPaiseINR(50)).toBe('₹0.50')
  })
})
