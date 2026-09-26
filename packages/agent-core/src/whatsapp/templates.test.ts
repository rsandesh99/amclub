import { describe, expect, it } from 'vitest'
import { WA_LOCALES } from '@amclub/shared'
import {
  CORE_TEMPLATES,
  WA_TEMPLATES,
  allTemplateNames,
  linkSuffix,
  resolveTemplate,
  templateApprovalList,
  templateComponents,
  type WaTemplateRegistry,
} from './index'

/** ADR-030 §3 / audit B2 — the template registry v2 and the (name, language) resolution. */

const TEST_REGISTRY: WaTemplateRegistry = {
  only_en_hi: { stem: 'amc_only_en_hi', category: 'utility', locales: ['en', 'hi'], body: { en: 'Hello {{1}} there.', hi: 'नमस्ते {{1}} जी।' }, params: (v) => [String(v['name'] ?? '')] },
  with_ta: { stem: 'amc_with_ta', category: 'utility', locales: ['en', 'ta'], body: { en: 'Order {{1}} update.', ta: 'ஆர்டர் {{1}} புதுப்பிப்பு.' }, params: (v) => [String(v['n'] ?? '')] },
  // declares ta but has no ta body: never resolved to a pair that was not submitted
  declared_only: { stem: 'amc_declared_only', category: 'utility', locales: ['en', 'ta'], body: { en: 'Only en {{1}} here.' }, params: () => ['x'] },
}

describe('resolveTemplate (audit B2: a name AND its language, both of which exist)', () => {
  it('a te request for a template without te → the en name with the en language code', () => {
    expect(resolveTemplate('only_en_hi', 'te', TEST_REGISTRY)).toMatchObject({ name: 'amc_only_en_hi_en', language: 'en', locale: 'en' })
    expect(resolveTemplate('only_en_hi', 'hi', TEST_REGISTRY)).toMatchObject({ name: 'amc_only_en_hi_hi', language: 'hi', locale: 'hi' })
  })
  it('the ta variant is used when it was submitted', () => {
    expect(resolveTemplate('with_ta', 'ta', TEST_REGISTRY)).toMatchObject({ name: 'amc_with_ta_ta', language: 'ta' })
    expect(resolveTemplate('with_ta', 'hi', TEST_REGISTRY)).toMatchObject({ name: 'amc_with_ta_en', language: 'en' })
  })
  it('a locale listed without a body is not sent under that language', () => {
    expect(resolveTemplate('declared_only', 'ta', TEST_REGISTRY)).toMatchObject({ name: 'amc_declared_only_en', language: 'en' })
  })
  it('an unknown kind resolves to nothing', () => {
    expect(resolveTemplate('nope', 'en', TEST_REGISTRY)).toBeNull()
    expect(resolveTemplate('marketing_blast', 'hi')).toBeNull()
  })
  it('every core kind resolves in every locale to its own variant', () => {
    for (const kind of Object.keys(CORE_TEMPLATES)) {
      for (const l of WA_LOCALES) {
        const r = resolveTemplate(kind, l)!
        expect(r.name).toBe(`${CORE_TEMPLATES[kind]!.stem}_${l}`)
        expect(r.language).toBe(l)
      }
    }
  })
})

describe('registry invariants (what Meta accepts)', () => {
  const entries = Object.entries(WA_TEMPLATES)
  it('stems are unique amc_* names and every kind is utility', () => {
    const stems = entries.map(([, s]) => s.stem)
    expect(new Set(stems).size).toBe(stems.length)
    for (const [, s] of entries) {
      expect(s.stem).toMatch(/^amc_[a-z0-9_]+$/)
      expect(s.stem.length).toBeLessThanOrEqual(509)
    }
    for (const [, s] of Object.entries(CORE_TEMPLATES)) expect(s.category).toBe('utility')
    expect(allTemplateNames().length).toBe(new Set(allTemplateNames()).size)
  })
  it('every body: en present, placeholders {{1}}..{{n}} match the params, never at the start or end, never adjacent', () => {
    for (const [kind, s] of entries) {
      expect(s.body.en, kind).toBeTruthy()
      const n = s.params(s.example ?? {}).length
      for (const l of s.locales) {
        const body = s.body[l]
        if (!body) continue
        const found = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]))
        expect([...new Set(found)].sort((a, b) => a - b), `${kind}/${l}`).toEqual(Array.from({ length: n }, (_, i) => i + 1))
        expect(body.trim().startsWith('{{'), `${kind}/${l} starts with a parameter`).toBe(false)
        expect(body.trim().endsWith('}}'), `${kind}/${l} ends with a parameter`).toBe(false)
        expect(/\}\}\s*\{\{/.test(body), `${kind}/${l} has adjacent parameters`).toBe(false)
        expect(body.length, `${kind}/${l}`).toBeLessThanOrEqual(1024)
      }
    }
  })
  it('the four locales are submitted for every core kind, and each language has distinct text per template', () => {
    for (const [kind, s] of Object.entries(CORE_TEMPLATES)) expect([...s.locales].sort(), kind).toEqual([...WA_LOCALES].sort())
    for (const l of WA_LOCALES) {
      const bodies = Object.values(CORE_TEMPLATES).map((s) => s.body[l]).filter(Boolean)
      expect(new Set(bodies).size, l).toBe(bodies.length)
    }
  })
  it('URL-button labels fit (≤ 25 characters) and suffixes stay on our domain', () => {
    for (const [kind, s] of entries) {
      if (!s.urlButton) continue
      for (const l of s.locales) expect(Array.from(s.urlButton.label[l] ?? s.urlButton.label.en).length, `${kind}/${l}`).toBeLessThanOrEqual(25)
      expect(s.urlButton.suffix({ link: 'https://evil.example/steal?x=1' })).toBe('steal?x=1')
      expect(s.urlButton.suffix({})).toBeTruthy()
    }
  })
  it('the reworded kinds carry no promotional wording (Meta re-categorises such utility templates)', () => {
    for (const kind of ['licence_renewal_due', 'munshi_growth', 'onboarding_stalled', 'review_prompt']) {
      const en = CORE_TEMPLATES[kind]!.body.en.toLowerCase()
      for (const w of ['offer', 'discount', 'grow', 'boost', 'win more', 'verified provider', 'renew with', 'help others', 'don\'t miss', 'hurry']) expect(en, `${kind}: ${w}`).not.toContain(w)
    }
  })
})

describe('parameters and buttons for a send', () => {
  it('notification kinds take title / body and link the button to the notification screen', () => {
    const spec = CORE_TEMPLATES['order_accepted']!
    const c = templateComponents(spec, { title: 'Order AMC-1 accepted', body: 'Lakshmi Tax accepted it.', link: '/app/orders/abc' })
    expect(c).toEqual({ body: ['Order AMC-1 accepted', 'Lakshmi Tax accepted it.'], urlButton: { index: 0, suffix: 'app/orders/abc' } })
  })
  it('a missing link falls back to a real screen, never an empty suffix', () => {
    expect(templateComponents(CORE_TEMPLATES['order_accepted']!, { title: 't', body: 'b' }).urlButton?.suffix).toBe('app/notifications')
    expect(templateComponents(CORE_TEMPLATES['procurement_update']!, { line: 'x' }).urlButton?.suffix).toBe('app/assistant')
    expect(linkSuffix('https://amclub.in/partner/onboarding?session=1')).toBe('partner/onboarding?session=1')
    expect(linkSuffix('  ')).toBe('app/notifications')
  })
  it('runtime kinds take their named values', () => {
    expect(templateComponents(CORE_TEMPLATES['munshi_draft']!, { title: 'GST filing', price: '₹3,500 · 5d' }).body).toEqual(['GST filing', '₹3,500 · 5d'])
    expect(templateComponents(CORE_TEMPLATES['support_reply']!, { title: 'Order', body: 'Line 1\nLine 2' }).body).toEqual(['Order', 'Line 1\nLine 2'])
  })
})

describe('the approval list (PRE_LAUNCH_CHECKLIST 1.3)', () => {
  it('one row per submitted (name, language) with a filled sample and the button URL pattern', () => {
    const rows = templateApprovalList()
    expect(rows.length).toBe(allTemplateNames().length)
    const te = rows.find((r) => r.name === 'amc_order_accepted_te')!
    expect(te).toMatchObject({ kind: 'order_accepted', language: 'te', category: 'utility', button: { type: 'url', url: 'https://amclub.in/{{1}}', example: 'app/orders/9d1c2f0e' } })
    expect(te.sample).not.toMatch(/\{\{\d\}\}/)
  })
})
