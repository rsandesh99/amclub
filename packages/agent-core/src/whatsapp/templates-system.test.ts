import { describe, expect, it } from 'vitest'
import { WA_LOCALES, WA_PAYLOAD_START, WA_PAYLOAD_STOP, parseWaSystemPayload, waCopy } from '@amclub/shared'
import { SYSTEM_TEMPLATES, templateBodyFrom } from './templates-system'

/** ADR-030 §2 — the system templates are utility, in all four locales, and acceptable to Meta's body rules. */
describe('SYSTEM_TEMPLATES', () => {
  const kinds = ['wa_opt_in_confirmed', 'wa_opt_out_confirmed', 'wa_holding_reply', 'wa_language_changed', 'wa_data_request_received']

  it('registers the five system kinds, utility, en / hi / te / ta, stems amc_wa_*', () => {
    expect(Object.keys(SYSTEM_TEMPLATES).sort()).toEqual([...kinds].sort())
    for (const k of kinds) {
      const s = SYSTEM_TEMPLATES[k]!
      expect(s.category, k).toBe('utility')
      expect([...s.locales].sort(), k).toEqual([...WA_LOCALES].sort())
      expect(s.stem, k).toMatch(/^amc_wa_[a-z_]+$/)
    }
  })

  it('bodies: numbered placeholders match the params, never at the start or the end, never two in a row', () => {
    const values = { language: 'हिंदी', what: 'a copy of your data', ref: 'D-1A2B3C4D', date: '26 Oct 2026' }
    for (const [kind, s] of Object.entries(SYSTEM_TEMPLATES)) {
      const n = s.params(values).length
      for (const l of s.locales) {
        const body = s.body[l]!
        const found = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]))
        expect(found, `${kind}:${l}`).toEqual(Array.from({ length: n }, (_, i) => i + 1))
        expect(body.trim(), `${kind}:${l}`).not.toMatch(/^\{\{\d+\}\}/)
        expect(body.trim(), `${kind}:${l}`).not.toMatch(/\{\{\d+\}\}[.!?।]?$/)
        expect(body, `${kind}:${l}`).not.toMatch(/\{\{\d+\}\}\s*\{\{\d+\}\}/)
        expect(body, `${kind}:${l}`).not.toMatch(/\{[a-z_]+\}/)
        expect(body.length, `${kind}:${l}`).toBeLessThanOrEqual(1024)
      }
    }
  })

  it('the template body is the free-text line with its slots numbered (one copy source)', () => {
    const s = SYSTEM_TEMPLATES['wa_language_changed']!
    expect(s.body.en).toBe('Language changed to {{1}}. Reply MENU to see what I can do.')
    expect(s.params({ language: 'తెలుగు' })).toEqual(['తెలుగు'])
    expect(templateBodyFrom('data_received', 'hi', ['what', 'ref', 'date'])).toContain('{{3}}')
    expect(SYSTEM_TEMPLATES['wa_opt_out_confirmed']!.body.ta).toBe(waCopy('opt_out_confirmed', 'ta'))
  })

  it('quick replies are our payloads: opt-in → menu / stop; opt-out → start again (≤ 20 characters each)', () => {
    const optIn = SYSTEM_TEMPLATES['wa_opt_in_confirmed']!.quickReplies ?? []
    const optOut = SYSTEM_TEMPLATES['wa_opt_out_confirmed']!.quickReplies ?? []
    expect(optIn.map((q) => q.id)).toEqual(['wa:menu:open', WA_PAYLOAD_STOP])
    expect(optOut.map((q) => q.id)).toEqual([WA_PAYLOAD_START])
    for (const q of [...optIn, ...optOut]) {
      expect(parseWaSystemPayload(q.id)).not.toBeNull()
      for (const l of WA_LOCALES) expect([...(q.label[l] ?? q.label.en)].length, `${q.id}:${l}`).toBeLessThanOrEqual(20)
    }
  })
})
