import { describe, expect, it } from 'vitest'
import { VOICE_EVAL_VERSION, summariseVoiceEval, voiceBaseLanguage, voiceEvalPasses, voiceLanguageAllowed, wordErrorRate } from '../index'

const pass = { version: VOICE_EVAL_VERSION, n: 50, wer: 0.18, categoryAccuracy: 0.9, ranAt: '2026-09-23T00:00:00.000Z' }

describe('E14 FR-14.5 — voice search, one language at a time', () => {
  it('WER is word-level edit distance over the reference', () => {
    expect(wordErrorRate('gst registration for my shop', 'gst registration for my shop')).toBe(0)
    expect(wordErrorRate('gst registration for my shop', 'gst registration for shop')).toBeCloseTo(1 / 5)
    expect(wordErrorRate('GST filing, please!', 'gst filing please')).toBe(0)
    expect(wordErrorRate('a b', 'x y z')).toBe(1.5)
    expect(wordErrorRate('', '')).toBe(0)
    expect(wordErrorRate('జీఎస్టీ రిజిస్ట్రేషన్', 'జీఎస్టీ రిజిస్ట్రేషన్')).toBe(0)
  })
  it('an eval passes only at n ≥ 50, WER ≤ 20 %, category ≥ 85 % and the current version', () => {
    expect(voiceEvalPasses(pass)).toBe(true)
    expect(voiceEvalPasses({ ...pass, n: 49 })).toBe(false)
    expect(voiceEvalPasses({ ...pass, wer: 0.21 })).toBe(false)
    expect(voiceEvalPasses({ ...pass, categoryAccuracy: 0.84 })).toBe(false)
    expect(voiceEvalPasses({ ...pass, version: 'voice-search-eval@v0' })).toBe(false)
    expect(voiceEvalPasses(null)).toBe(false)
  })
  it('a language is allowed only when listed AND its eval passes', () => {
    expect(voiceLanguageAllowed('te-IN', ['en', 'te'], { te: pass })).toBe(true)
    expect(voiceLanguageAllowed('te-IN', ['en'], { te: pass })).toBe(false)
    expect(voiceLanguageAllowed('ta-IN', ['ta'], {})).toBe(false)
    expect(voiceLanguageAllowed('ta-IN', ['ta'], { ta: { ...pass, wer: 0.4 } })).toBe(false)
    expect(voiceLanguageAllowed('unknown', ['en'], { en: pass })).toBe(false)
    expect(voiceBaseLanguage('HI-in')).toBe('hi')
  })
  it('a run aggregates WER over all words and scores only cases with an expected category', () => {
    const r = summariseVoiceEval([
      { reference: 'gst filing', hypothesis: 'gst filing', expectedCategory: 'tax-accounting', gotCategory: 'tax-accounting' },
      { reference: 'trademark for my brand name', hypothesis: 'trade mark for my brand name', expectedCategory: 'legal', gotCategory: 'tax-accounting' },
      { reference: 'hello', hypothesis: 'hello', expectedCategory: null, gotCategory: null },
    ], new Date('2026-09-23T00:00:00Z'), 'te-v1')
    expect(r.n).toBe(3)
    expect(r.wer).toBeCloseTo(2 / 8, 3)
    expect(r.categoryAccuracy).toBe(0.5)
    expect(r.set).toBe('te-v1')
  })
})
