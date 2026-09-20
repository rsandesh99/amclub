import { describe, expect, it } from 'vitest'
import {
  AGENT_NAMES,
  QUOTE_EXTRACT_FIELDS,
  agentTool,
  clampQuoteExtraction,
  editedExtractFields,
  emptyExtraction,
  quoteExtractRequestSchema,
  quoteExtractionSchema,
  quoteSchema,
  stripContactInfo,
  type QuoteExtraction,
} from '../index'

const full: QuoteExtraction = {
  price_paise: 24000000,
  unit_price_paise: null,
  delivery_days: 21,
  gst_included: false,
  transport_included: false,
  valid_until: '2026-09-27',
  advance_percent: 30,
  gst_rate_bps: null,
  hsn_code: null,
  scope_summary: 'GST filing for FY, 3 weeks, GST extra, transport at actuals, 30% advance',
  uncertain_fields: [],
}
const allNull: QuoteExtraction = { ...emptyExtraction('x'), uncertain_fields: [] }

describe('quoteExtractionSchema', () => {
  it('accepts a full object and an all-null object', () => {
    expect(quoteExtractionSchema.safeParse(full).success).toBe(true)
    expect(quoteExtractionSchema.safeParse(allNull).success).toBe(true)
  })
  it('rejects uncertain_fields outside the enum', () => {
    expect(quoteExtractionSchema.safeParse({ ...full, uncertain_fields: ['colour'] }).success).toBe(false)
  })
  it('rejects valid_until in DD/MM/YYYY', () => {
    expect(quoteExtractionSchema.safeParse({ ...full, valid_until: '27/09/2026' }).success).toBe(false)
  })
  it('rejects a 3-digit hsn_code and accepts 4/6/8', () => {
    expect(quoteExtractionSchema.safeParse({ ...full, hsn_code: '481' }).success).toBe(false)
    for (const h of ['4819', '481910', '48191010']) expect(quoteExtractionSchema.safeParse({ ...full, hsn_code: h }).success).toBe(true)
  })
  it('request schema trims, bounds and defaults the source', () => {
    const r = quoteExtractRequestSchema.parse({ text: '  ₹2 lakh, 3 weeks ' })
    expect(r.text).toBe('₹2 lakh, 3 weeks')
    expect(r.source).toBe('typed')
    expect(quoteExtractRequestSchema.safeParse({ text: 'hi' }).success).toBe(false)
  })
  it('quoteSchema accepts an optional extraction_id', () => {
    const base = { rfq_id: '00000000-0000-0000-0000-000000000001', price_paise: 100, delivery_days: 3, scope: 'A perfectly reasonable scope of twenty chars' }
    expect(quoteSchema.safeParse(base).success).toBe(true)
    expect(quoteSchema.safeParse({ ...base, extraction_id: '00000000-0000-0000-0000-000000000002' }).success).toBe(true)
    expect(quoteSchema.safeParse({ ...base, extraction_id: 'nope' }).success).toBe(false)
  })
})

describe('registry + tool', () => {
  it('AGENT_NAMES contains quote_extract (first — build order)', () => {
    expect(AGENT_NAMES[0]).toBe('quote_extract')
  })
  it('extract_quote is a provider tool, confirm:false, wraps local', () => {
    const t = agentTool('extract_quote')
    expect(t.persona).toBe('provider')
    expect(t.confirm).toBe(false)
    expect(t.wraps.startsWith('local')).toBe(true)
    expect(t.taskClass).toBe('quote_extract')
  })
})

describe('clampQuoteExtraction', () => {
  const today = '2026-09-20'
  it('services: goods fields forced null; goods: total forced null', () => {
    const goodsy: QuoteExtraction = { ...full, unit_price_paise: 12000, gst_rate_bps: 1800, hsn_code: '4819' }
    const s = clampQuoteExtraction(goodsy, { kind: 'services', today })
    expect(s.unit_price_paise).toBeNull()
    expect(s.gst_rate_bps).toBeNull()
    expect(s.hsn_code).toBeNull()
    expect(s.price_paise).toBe(24000000)
    const g = clampQuoteExtraction(goodsy, { kind: 'goods', today })
    expect(g.price_paise).toBeNull()
    expect(g.unit_price_paise).toBe(12000)
  })
  it('off-slab GST rate → null + uncertain', () => {
    const g = clampQuoteExtraction({ ...full, unit_price_paise: 100, gst_rate_bps: 1500 }, { kind: 'goods', today })
    expect(g.gst_rate_bps).toBeNull()
    expect(g.uncertain_fields).toContain('gst_rate_bps')
  })
  it('past valid_until → null + uncertain; future kept', () => {
    const past = clampQuoteExtraction({ ...full, valid_until: '2026-09-01' }, { kind: 'services', today })
    expect(past.valid_until).toBeNull()
    expect(past.uncertain_fields).toContain('valid_until')
    expect(clampQuoteExtraction(full, { kind: 'services', today }).valid_until).toBe('2026-09-27')
  })
  it('strips phone / email / UPI from the summary and dedupes uncertain fields', () => {
    const c = clampQuoteExtraction(
      { ...full, scope_summary: 'Call 9876543210 or ravi@upi or ravi@example.com for details, 5 days', uncertain_fields: ['price', 'price', 'delivery_days'] },
      { kind: 'services', today },
    )
    expect(c.scope_summary).not.toMatch(/9876543210|@/)
    expect(c.scope_summary).toContain('5 days')
    expect(c.uncertain_fields).toEqual(['price', 'delivery_days'])
  })
  it('stripContactInfo keeps ordinary numbers', () => {
    expect(stripContactInfo('1200 sq ft at ₹450, 10-12 days')).toBe('1200 sq ft at ₹450, 10-12 days')
    expect(stripContactInfo('+91 98765 43210 anytime')).toBe('anytime')
  })
  it('a zero price is treated as absent', () => {
    expect(clampQuoteExtraction({ ...full, price_paise: 0 }, { kind: 'services', today }).price_paise).toBeNull()
  })
})

describe('editedExtractFields', () => {
  it('no edits when the submitted terms equal the proposal (null vs omitted equal)', () => {
    const proposed: QuoteExtraction = { ...full, valid_until: null, advance_percent: null }
    expect(editedExtractFields(proposed, { price_paise: 24000000, delivery_days: 21, gst_included: false, transport_included: false }, 'services')).toEqual([])
  })
  it('lists each changed field; goods compares unit terms, not the total', () => {
    expect(editedExtractFields(full, { price_paise: 25000000, delivery_days: 20, gst_included: false, transport_included: false, valid_until: '2026-09-27', advance_percent: 30 }, 'services')).toEqual(['price', 'delivery_days'])
    const g: QuoteExtraction = { ...full, price_paise: null, unit_price_paise: 12000, gst_rate_bps: 1800, hsn_code: '4819' }
    expect(editedExtractFields(g, { price_paise: 6000000, delivery_days: 21, gst_included: false, transport_included: false, valid_until: '2026-09-27', advance_percent: 30, goods: { unit_price_paise: 12500, gst_rate_bps: 1800, hsn_code: '4819' } }, 'goods')).toEqual(['unit_price'])
  })
  it('every field name is in QUOTE_EXTRACT_FIELDS', () => {
    const g: QuoteExtraction = { ...full, unit_price_paise: 1, gst_rate_bps: 500, hsn_code: '1111' }
    const all = editedExtractFields(g, { price_paise: 1, delivery_days: 1, gst_included: true, transport_included: true, valid_until: '2027-01-01', advance_percent: 1, goods: { unit_price_paise: 2, gst_rate_bps: 1200, hsn_code: '2222' } }, 'goods')
    for (const f of all) expect(QUOTE_EXTRACT_FIELDS).toContain(f)
    expect(all).toHaveLength(8)
  })
})
