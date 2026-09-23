import { afterEach, describe, expect, it } from 'vitest'
import {
  costPaiseFor,
  estimateParseCostPaise,
  estimateUsdFromTokens,
  FALLBACK_MODEL_RATE,
  FALLBACK_TOKENS,
  modelRatesFromEnv,
  usdToPaise,
} from './invocations'

/** Track F — the cost estimator: a live call is never recorded as free. */

describe('cost estimator', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  it('stub → 0 (source stub)', () => {
    expect(costPaiseFor({ stub: true, costUsd: null, model: 'm', inputTokens: 100, outputTokens: 100 })).toEqual({ paise: 0, source: 'stub' })
  })

  it('vendor cost wins when present', () => {
    delete process.env['OPENROUTER_USD_INR_PAISE']
    expect(costPaiseFor({ stub: false, costUsd: 0.01, model: 'm', inputTokens: 1, outputTokens: 1 })).toEqual({ paise: 88, source: 'vendor' })
  })

  it('no vendor cost → tokens × the model rate from AGENT_MODEL_RATES', () => {
    delete process.env['OPENROUTER_USD_INR_PAISE']
    const rates = { 'google/gemini-2.5-flash-lite': { inPerMTokUsd: 0.1, outPerMTokUsd: 0.4 } }
    // 1M in × 0.1 + 1M out × 0.4 = 0.5 USD = 4400 paise
    expect(costPaiseFor({ stub: false, costUsd: null, model: 'google/gemini-2.5-flash-lite', inputTokens: 1_000_000, outputTokens: 1_000_000, rates })).toEqual({ paise: 4400, source: 'rate' })
  })

  it('no vendor cost and no rate → the conservative fallback rate, never 0', () => {
    const r = costPaiseFor({ stub: false, costUsd: null, model: 'unknown/model', inputTokens: 10, outputTokens: 0, rates: {} })
    expect(r.source).toBe('fallback')
    expect(r.paise).toBeGreaterThanOrEqual(1)
  })

  it('no usage at all → assumed FALLBACK_TOKENS at the fallback rate', () => {
    const r = costPaiseFor({ stub: false, costUsd: null, model: null, inputTokens: null, outputTokens: null, rates: {} })
    const expected = usdToPaise(estimateUsdFromTokens(FALLBACK_TOKENS.input, FALLBACK_TOKENS.output, FALLBACK_MODEL_RATE))
    expect(r.paise).toBe(expected)
    expect(r.paise).toBeGreaterThan(0)
  })

  it('AGENT_MODEL_RATES is parsed; invalid JSON or entries are ignored, never thrown', () => {
    expect(modelRatesFromEnv('{"a/b":{"inPerMTokUsd":1,"outPerMTokUsd":2},"bad":{"inPerMTokUsd":"x"}}')).toEqual({ 'a/b': { inPerMTokUsd: 1, outPerMTokUsd: 2 } })
    expect(modelRatesFromEnv('not json')).toEqual({})
    expect(modelRatesFromEnv(undefined)).toEqual({})
  })

  it('reads AGENT_MODEL_RATES from env by default', () => {
    delete process.env['OPENROUTER_USD_INR_PAISE']
    process.env['AGENT_MODEL_RATES'] = JSON.stringify({ 'x/y': { inPerMTokUsd: 1, outPerMTokUsd: 1 } })
    expect(costPaiseFor({ stub: false, costUsd: null, model: 'x/y', inputTokens: 500_000, outputTokens: 500_000 })).toEqual({ paise: 8800, source: 'rate' })
  })

  it('estimateParseCostPaise: vendor cost, else a non-null estimate from raw usage', () => {
    delete process.env['OPENROUTER_USD_INR_PAISE']
    expect(estimateParseCostPaise({ cost: 0.01 }, false)).toBe(88)
    expect(estimateParseCostPaise({ prompt_tokens: 100, completion_tokens: 50 }, false)).toBeGreaterThan(0)
    expect(estimateParseCostPaise(undefined, false)).toBeGreaterThan(0)
    expect(estimateParseCostPaise({ cost: 1 }, true)).toBe(0)
  })
})
