import { describe, expect, it } from 'vitest'
import {
  AGENT_NAMES,
  BUYER_DECLINE_REASONS,
  DECLINE_MESSAGE_LOCALES,
  QUOTE_DECLINE_REASONS,
  QUOTE_STATUSES,
  QUOTE_TRANSITIONS,
  agentTool,
  canTransitionQuote,
  comparePointersSchema,
  declineMessageSchema,
  declineMessageTemplate,
  messageMatchesLocaleScript,
  quoteDeclineResponseSchema,
  quoteDeclineSchema,
  resolveDeclineLocale,
} from '../index'

describe('QUOTE_TRANSITIONS (rule 8 — one map, codifying existing behaviour)', () => {
  it('submitted may become accepted / declined / withdrawn / expired; every other state is terminal', () => {
    expect(QUOTE_TRANSITIONS.submitted).toEqual(['accepted', 'declined', 'withdrawn', 'expired'])
    for (const s of ['accepted', 'declined', 'withdrawn', 'expired'] as const) expect(QUOTE_TRANSITIONS[s]).toEqual([])
    expect(Object.keys(QUOTE_TRANSITIONS).sort()).toEqual([...QUOTE_STATUSES].sort())
  })
  it('canTransitionQuote agrees with the map and has no declined → submitted', () => {
    expect(canTransitionQuote('submitted', 'declined')).toBe(true)
    expect(canTransitionQuote('submitted', 'accepted')).toBe(true)
    expect(canTransitionQuote('declined', 'submitted')).toBe(false)
    expect(canTransitionQuote('accepted', 'declined')).toBe(false)
  })
})

describe('decline contract', () => {
  it('quoteDeclineSchema: reason enum + optional trimmed note ≤ 200', () => {
    expect(quoteDeclineSchema.safeParse({ reason: 'price_high' }).success).toBe(true)
    expect(quoteDeclineSchema.parse({ reason: 'other', note: '  too far  ' }).note).toBe('too far')
    expect(quoteDeclineSchema.safeParse({ reason: 'meh' }).success).toBe(false)
    expect(quoteDeclineSchema.safeParse({ reason: 'other', note: 'x'.repeat(201) }).success).toBe(false)
  })
  it('chose_other is a valid reason for the system but not offered to buyers', () => {
    expect(QUOTE_DECLINE_REASONS).toContain('chose_other')
    expect(BUYER_DECLINE_REASONS).not.toContain('chose_other')
    expect(BUYER_DECLINE_REASONS).toHaveLength(5)
  })
  it('response schema', () => {
    expect(quoteDeclineResponseSchema.safeParse({ quoteId: '00000000-0000-0000-0000-000000000001', status: 'declined', message_pending: false }).success).toBe(true)
    expect(quoteDeclineResponseSchema.safeParse({ quoteId: 'x', status: 'declined', message_pending: false }).success).toBe(false)
  })
  it('decline_quote is a confirm:true buyer tool wrapping the new route', () => {
    const t = agentTool('decline_quote')
    expect(t.persona).toBe('buyer')
    expect(t.confirm).toBe(true)
    expect(t.wraps).toBe('POST /rfq/[id]/quote/[quoteId]/decline')
  })
  it('AGENT_NAMES has compare_pointers and decline_message after quote_extract', () => {
    expect(AGENT_NAMES.slice(0, 3)).toEqual(['quote_extract', 'compare_pointers', 'decline_message'])
  })
})

describe('decline message templates', () => {
  it('every reason × locale has a template in the right script, ≤ 320 chars, platform voice, no contact details', () => {
    for (const reason of QUOTE_DECLINE_REASONS) {
      for (const locale of DECLINE_MESSAGE_LOCALES) {
        const m = declineMessageTemplate(reason, locale)
        expect(declineMessageSchema.safeParse(m).success).toBe(true)
        expect(m.message.length).toBeLessThanOrEqual(320)
        expect(messageMatchesLocaleScript(m.message, locale)).toBe(true)
        expect(m.message).toContain('AMClub')
        expect(m.message).not.toMatch(/\d{7,}|@/)
        expect(m.message.toLowerCase().startsWith('i ')).toBe(false)
      }
    }
  })
  it('the "you are welcome to quote again" line appears only where negotiation is not implied', () => {
    expect(declineMessageTemplate('details_unclear', 'en').message).not.toMatch(/requote/i)
    expect(declineMessageTemplate('price_high', 'en').message).toMatch(/future requests/)
  })
  it('resolveDeclineLocale: provider languages first, then preferred locale, then en', () => {
    expect(resolveDeclineLocale(['ta', 'en'], 'hi')).toBe('ta')
    expect(resolveDeclineLocale(['kn'], 'hi')).toBe('hi')
    expect(resolveDeclineLocale(['kn'], 'kn')).toBe('en')
    expect(resolveDeclineLocale(null, null)).toBe('en')
  })
  it('messageMatchesLocaleScript', () => {
    expect(messageMatchesLocaleScript('धन्यवाद', 'hi')).toBe(true)
    expect(messageMatchesLocaleScript('thank you', 'hi')).toBe(false)
    expect(messageMatchesLocaleScript('thank you', 'en')).toBe(true)
    expect(messageMatchesLocaleScript('நன்றி', 'ta')).toBe(true)
    expect(messageMatchesLocaleScript('ధన్యవాదాలు', 'te')).toBe(true)
  })
})

describe('comparePointersSchema is strict — no rank / recommendation can sneak in', () => {
  const id = '00000000-0000-0000-0000-000000000001'
  it('accepts lines only', () => {
    expect(comparePointersSchema.safeParse({ pointers: [{ quote_id: id, lines: ['GST not included'] }] }).success).toBe(true)
    expect(comparePointersSchema.safeParse({ pointers: [{ quote_id: id, lines: [] }] }).success).toBe(true)
  })
  it('rejects extra keys at either level and over-long lines', () => {
    expect(comparePointersSchema.safeParse({ pointers: [{ quote_id: id, lines: [], rank: 1 }] }).success).toBe(false)
    expect(comparePointersSchema.safeParse({ pointers: [{ quote_id: id, lines: [] }], recommendation: id }).success).toBe(false)
    expect(comparePointersSchema.safeParse({ pointers: [{ quote_id: id, lines: ['x'.repeat(161)] }] }).success).toBe(false)
    expect(comparePointersSchema.safeParse({ pointers: [{ quote_id: id, lines: ['a', 'b', 'c', 'd'] }] }).success).toBe(false)
  })
})
