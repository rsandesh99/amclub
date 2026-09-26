import { describe, expect, it } from 'vitest'
import {
  WA_COPY,
  WA_COPY_KEYS,
  WA_LANGUAGE_NAMES,
  WA_MENU_KNOWN,
  WA_MENU_UNKNOWN,
  parseWaSystemPayload,
  waCopy,
  waCopySlots,
  waLangPayload,
  waLanguageRows,
  waMenuPayload,
  waMenuRows,
} from '../whatsapp-copy'
import { WA_LOCALES } from '../whatsapp'
import { AGENT_SETTING_DEFS, inAgentCohort, parseAgentSetting } from '../agent-settings'

const chars = (s: string) => [...s].length

describe('WhatsApp system copy (ADR-030)', () => {
  it('every key exists in every locale, non-empty, with the same slots as en', () => {
    const bad: string[] = []
    for (const l of WA_LOCALES) {
      for (const k of WA_COPY_KEYS) {
        const line = WA_COPY[l][k]
        if (!line || !line.trim()) bad.push(`${l}:${k} empty`)
        else if (waCopySlots(k, l).slice().sort().join(',') !== waCopySlots(k, 'en').slice().sort().join(',')) bad.push(`${l}:${k} slots`)
      }
    }
    expect(bad).toEqual([])
  })

  it('renders every slot and never leaves a raw placeholder', () => {
    const slots = { order_number: 'AMC-1', status: 'Placed', url: 'https://amclub.in/x', title: 'GST', ref: 'T-1', hours: 24, email: 'a@b.c', phone: '+91 1', language: 'हिंदी', what: 'x', date: '1 Oct 2026' }
    for (const l of WA_LOCALES) for (const k of WA_COPY_KEYS) expect(waCopy(k, l, slots), `${l}:${k}`).not.toMatch(/\{[a-z_]+\}/)
    expect(waCopy('language_changed', 'en', {})).toBe('Language changed to . Reply MENU to see what I can do.')
  })

  it('menu rows fit a WhatsApp list row (≤ 24) and the reply buttons fit a button (≤ 20)', () => {
    for (const l of WA_LOCALES) {
      for (const r of waMenuRows([...WA_MENU_KNOWN, ...WA_MENU_UNKNOWN, 'open'], l)) expect(chars(r.title), `${l}:${r.title}`).toBeLessThanOrEqual(24)
      for (const k of ['item_open', 'item_stop', 'button_start', 'button_start_again'] as const) expect(chars(waCopy(k, l)), `${l}:${k}`).toBeLessThanOrEqual(20)
    }
    for (const r of waLanguageRows()) expect(chars(r.title)).toBeLessThanOrEqual(24)
    expect(waLanguageRows().map((r) => r.id)).toEqual(['wa:lang:en', 'wa:lang:hi', 'wa:lang:te', 'wa:lang:ta'])
    expect(Object.keys(WA_LANGUAGE_NAMES).sort()).toEqual([...WA_LOCALES].sort())
  })

  it('the known menu has the five items; an unknown number never sees account items', () => {
    expect(WA_MENU_KNOWN).toEqual(['track', 'requests', 'human', 'language', 'stop'])
    expect(WA_MENU_UNKNOWN).toEqual(['language', 'signup', 'human', 'stop'])
    expect(WA_MENU_UNKNOWN).not.toContain('track')
    expect(WA_MENU_UNKNOWN).not.toContain('requests')
  })
})

describe('system payloads', () => {
  it('parses ours and nothing else', () => {
    expect(parseWaSystemPayload('wa:start')).toEqual({ kind: 'start' })
    expect(parseWaSystemPayload(' WA:STOP ')).toEqual({ kind: 'stop' })
    expect(parseWaSystemPayload(waMenuPayload('track'))).toEqual({ kind: 'menu', item: 'track' })
    expect(parseWaSystemPayload(waLangPayload('ta'))).toEqual({ kind: 'lang', locale: 'ta' })
    for (const p of ['wa:menu:delete_everything', 'wa:lang:kn', 'nudge:no:abc', 'no', 'STOP', '', null, undefined]) expect(parseWaSystemPayload(p), String(p)).toBeNull()
  })
})

describe('cohort_mode (audit B8)', () => {
  it("'list' uses the allowlist; 'all' is everyone; anything else is the list", () => {
    expect(inAgentCohort('list', ['u1'], 'u1')).toBe(true)
    expect(inAgentCohort('list', ['u1'], 'u2')).toBe(false)
    expect(inAgentCohort('all', [], 'u2')).toBe(true)
    expect(inAgentCohort(undefined, ['u2'], 'u2')).toBe(true)
    expect(inAgentCohort('everyone', null, 'u2')).toBe(false)
  })
  it('is registered: list | all, default list; the dormant window is registered with 90 days', () => {
    expect(AGENT_SETTING_DEFS.cohort_mode.default).toBe('list')
    expect(parseAgentSetting('cohort_mode', 'all').ok).toBe(true)
    expect(parseAgentSetting('cohort_mode', 'some').ok).toBe(false)
    expect(AGENT_SETTING_DEFS.wa_rebind_dormant_days.default).toBe(90)
    expect(parseAgentSetting('wa_rebind_dormant_days', 0).ok).toBe(true)
    expect(parseAgentSetting('wa_rebind_dormant_days', -1).ok).toBe(false)
  })
})
