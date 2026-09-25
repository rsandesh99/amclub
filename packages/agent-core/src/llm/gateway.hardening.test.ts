import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  createGateway,
  DEFAULT_MAX_TOKENS_BY_TIER,
  gatewayConfigFromEnv,
  GatewayHttpError,
  GatewayValidationError,
  ResidencyUnconfiguredError,
  ResidencyViolationError,
  residencyPosture,
  type GatewayConfig,
} from './gateway'
import type { PromptRef } from '../prompts/registry'

/**
 * Track F — gateway correctness: max_tokens is always sent; a billed but invalid
 * response throws a GatewayValidationError carrying usage; per-tier base URLs;
 * the opt-in data-residency guard.
 */

const prompt: PromptRef = { id: 'quote_extract', version: 'v1', taskClass: 'quote_extract', schemaRef: 'x', text: 'SYSTEM' }
const schema = z.object({ ok: z.boolean() })

function transport(content: string, extra: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return new Response(JSON.stringify({ choices: [{ message: { content }, ...extra }], usage: { prompt_tokens: 120, completion_tokens: 40, cost: 0.002 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { calls, fetchImpl }
}

const cfg = (fetchImpl: typeof fetch, over: Partial<GatewayConfig> = {}): GatewayConfig => ({
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'k',
  embedBaseUrl: 'https://openrouter.ai/api/v1',
  timeoutMs: 1000,
  maxRetries: 0,
  forceStub: false,
  fetchImpl,
  ...over,
})

describe('gateway — max_tokens', () => {
  it('sends the tier default when neither the call nor the prompt sets one', async () => {
    const t = transport('{"ok":true}')
    await createGateway(cfg(t.fetchImpl)).chatJson({ taskClass: 'quote_extract', prompt, schema })
    expect(t.calls[0]!.body['max_tokens']).toBe(DEFAULT_MAX_TOKENS_BY_TIER.routine)
  })

  it('prompt front-matter beats the tier default; the call beats both', async () => {
    const t = transport('{"ok":true}')
    const gw = createGateway(cfg(t.fetchImpl))
    await gw.chatJson({ taskClass: 'quote_extract', prompt: { ...prompt, maxTokens: 321 }, schema })
    await gw.chatJson({ taskClass: 'quote_extract', prompt: { ...prompt, maxTokens: 321 }, schema, maxTokens: 99 })
    expect(t.calls[0]!.body['max_tokens']).toBe(321)
    expect(t.calls[1]!.body['max_tokens']).toBe(99)
  })

  it('frontier default is the frontier cap', async () => {
    const t = transport('{"ok":true}')
    await createGateway(cfg(t.fetchImpl)).chatJson({ taskClass: 'dispute_triage', prompt, schema })
    expect(t.calls[0]!.body['max_tokens']).toBe(DEFAULT_MAX_TOKENS_BY_TIER.frontier)
  })
})

describe('gateway — billed but invalid output carries usage', () => {
  it('non-JSON content → GatewayValidationError(non_json) with usage + model', async () => {
    const t = transport('sorry, I cannot')
    const err = await createGateway(cfg(t.fetchImpl)).chatJson({ taskClass: 'quote_extract', prompt, schema }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayValidationError)
    const v = err as GatewayValidationError
    expect(v.code).toBe('model_output_invalid')
    expect(v.reason).toBe('non_json')
    expect(v.usage).toMatchObject({ inputTokens: 120, outputTokens: 40, costUsd: 0.002 })
    expect(v.model).toBeTruthy()
  })

  it('schema mismatch → reason schema', async () => {
    const t = transport('{"ok":"yes"}')
    const err = (await createGateway(cfg(t.fetchImpl)).chatJson({ taskClass: 'quote_extract', prompt, schema }).catch((e: unknown) => e)) as GatewayValidationError
    expect(err).toBeInstanceOf(GatewayValidationError)
    expect(err.reason).toBe('schema')
  })

  it('finish_reason length with broken JSON → reason truncated', async () => {
    const t = transport('{"ok":tr', { finish_reason: 'length' })
    const err = (await createGateway(cfg(t.fetchImpl)).chatJson({ taskClass: 'quote_extract', prompt, schema }).catch((e: unknown) => e)) as GatewayValidationError
    expect(err.reason).toBe('truncated')
  })

  it('a ```json fence is tolerated', async () => {
    const t = transport('```json\n{"ok":true}\n```')
    const r = await createGateway(cfg(t.fetchImpl)).chatJson({ taskClass: 'quote_extract', prompt, schema })
    expect(r.data.ok).toBe(true)
  })
})

describe('gateway — per-tier base URL', () => {
  it('a tier override routes only that tier', async () => {
    const t = transport('{"ok":true}')
    const gw = createGateway(cfg(t.fetchImpl, { baseUrlByTier: { frontier: 'https://llm.in.example/v1' } }))
    await gw.chatJson({ taskClass: 'dispute_triage', prompt, schema })
    await gw.chatJson({ taskClass: 'quote_extract', prompt, schema })
    expect(t.calls[0]!.url).toBe('https://llm.in.example/v1/chat/completions')
    expect(t.calls[1]!.url).toBe('https://openrouter.ai/api/v1/chat/completions')
  })

  describe('gatewayConfigFromEnv', () => {
    const saved = { ...process.env }
    afterEach(() => {
      process.env = { ...saved }
    })
    it('reads AGENT_LLM_BASE_URL_<TIER>, AGENT_RESIDENCY_ENFORCE and AGENT_IN_RESIDENCY_HOSTS', () => {
      process.env['AGENT_LLM_BASE_URL_REASONING'] = 'https://gpu.in.example/v1'
      process.env['AGENT_RESIDENCY_ENFORCE'] = 'true'
      process.env['AGENT_IN_RESIDENCY_HOSTS'] = ' GPU.in.example , llm.in.example '
      const c = gatewayConfigFromEnv()
      expect(c.baseUrlByTier?.reasoning).toBe('https://gpu.in.example/v1')
      expect(c.baseUrlByTier?.frontier).toBeUndefined()
      expect(c.residencyEnforce).toBe(true)
      expect(c.inResidencyHosts).toEqual(['gpu.in.example', 'llm.in.example'])
    })
    it('enforcement is off unless explicitly true', () => {
      delete process.env['AGENT_RESIDENCY_ENFORCE']
      expect(gatewayConfigFromEnv().residencyEnforce).toBe(false)
    })
  })
})

describe('gateway — data-residency guard (opt-in)', () => {
  it("enforcement ON: an 'in' class resolving to openrouter.ai is refused before any request", async () => {
    const t = transport('{"ok":true}')
    const gw = createGateway(cfg(t.fetchImpl, { residencyEnforce: true, inResidencyHosts: ['llm.in.example'] }))
    const err = await gw.chatJson({ taskClass: 'quote_extract', prompt, schema }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ResidencyViolationError)
    expect((err as ResidencyViolationError).code).toBe('residency_violation')
    expect((err as ResidencyViolationError).host).toBe('openrouter.ai')
    expect(t.calls).toHaveLength(0)
  })

  it('enforcement OFF (default): the same call is allowed', async () => {
    const t = transport('{"ok":true}')
    const r = await createGateway(cfg(t.fetchImpl)).chatJson({ taskClass: 'quote_extract', prompt, schema })
    expect(r.data.ok).toBe(true)
    expect(t.calls).toHaveLength(1)
  })

  it("enforcement ON: an 'in' class to an allow-listed host is allowed", async () => {
    const t = transport('{"ok":true}')
    const gw = createGateway(cfg(t.fetchImpl, { residencyEnforce: true, inResidencyHosts: ['llm.in.example'], baseUrlByTier: { routine: 'https://llm.in.example/v1' } }))
    const r = await gw.chatJson({ taskClass: 'quote_extract', prompt, schema })
    expect(r.data.ok).toBe(true)
  })

  it("enforcement ON: an 'any' class may go to a non-listed host", async () => {
    const t = transport('{"ok":true}')
    const gw = createGateway(cfg(t.fetchImpl, { residencyEnforce: true, inResidencyHosts: [] }))
    const r = await gw.chatJson({ taskClass: 'translation', prompt, schema })
    expect(r.data.ok).toBe(true)
  })

  it('stub mode never checks residency (nothing leaves the process)', async () => {
    const t = transport('{"ok":true}')
    const gw = createGateway(cfg(t.fetchImpl, { apiKey: null, residencyEnforce: true, inResidencyHosts: [] }))
    const r = await gw.chatJson({ taskClass: 'quote_extract', prompt, schema, stub: () => ({ ok: true }) })
    expect(r.stub).toBe(true)
  })
})

describe('gateway — residency posture fails closed in production (audit M23)', () => {
  const prod = { NODE_ENV: 'production', AGENT_ENABLED: 'true' }
  it('production + agents on + no decision = unconfigured', () => {
    expect(residencyPosture(prod).mode).toBe('unconfigured')
    expect(residencyPosture({ ...prod, AGENT_RESIDENCY_ENFORCE: 'true' }).mode).toBe('unconfigured') // on, but no hosts
    expect(residencyPosture({ ...prod, AGENT_RESIDENCY_WAIVER: 'short' }).mode).toBe('unconfigured') // not a recorded reason
    expect(residencyPosture({ VERCEL_ENV: 'production', AGENT_ENABLED: 'true' }).mode).toBe('unconfigured')
  })
  it('enforcement with hosts, or a recorded waiver, is a decision', () => {
    expect(residencyPosture({ ...prod, AGENT_RESIDENCY_ENFORCE: 'true', AGENT_IN_RESIDENCY_HOSTS: 'llm.in.example' })).toMatchObject({ mode: 'enforced', hosts: ['llm.in.example'] })
    const w = residencyPosture({ ...prod, AGENT_RESIDENCY_WAIVER: 'DPA signed 2026-09-24 with OpenRouter; ZDR on; review 2026-12-31' })
    expect(w.mode).toBe('waived')
    expect(w.waiver).toContain('DPA signed')
  })
  it('an undecided production posture refuses only with AGENT_RESIDENCY_FAIL_CLOSED=true (held until the decision is recorded)', () => {
    expect(residencyPosture(prod)).toMatchObject({ mode: 'unconfigured', refuses: false })
    expect(residencyPosture({ ...prod, AGENT_RESIDENCY_FAIL_CLOSED: 'true' })).toMatchObject({ mode: 'unconfigured', refuses: true })
    expect(residencyPosture({ ...prod, AGENT_RESIDENCY_FAIL_CLOSED: 'true', AGENT_RESIDENCY_WAIVER: 'DPA signed 2026-09-24; review 2026-12-31' })).toMatchObject({ mode: 'waived', refuses: false })
  })
  it("undecided and not fail-closed: an 'in' class is sent (logged), without the ZDR preference", async () => {
    const t = transport('{"ok":true}')
    const gw = createGateway(cfg(t.fetchImpl, { residencyMode: 'unconfigured', residencyRefuses: false, openRouterZdr: false }))
    const r = await gw.chatJson({ taskClass: 'quote_extract', prompt, schema })
    expect(r.data).toEqual({ ok: true })
    expect(t.calls).toHaveLength(1)
  })
  it('outside production, or with agents off, the guard stays opt-in', () => {
    expect(residencyPosture({ NODE_ENV: 'development', AGENT_ENABLED: 'true' }).mode).toBe('opt_in')
    expect(residencyPosture({ NODE_ENV: 'production' }).mode).toBe('opt_in')
  })
  it("unconfigured refuses every 'in' class before any request, loudly; an 'any' class still goes", async () => {
    const t = transport('{"ok":true}')
    const gw = createGateway(cfg(t.fetchImpl, { residencyMode: 'unconfigured' }))
    const err = await gw.chatJson({ taskClass: 'quote_extract', prompt, schema }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ResidencyUnconfiguredError)
    expect((err as ResidencyUnconfiguredError).code).toBe('residency_unconfigured')
    expect(t.calls).toHaveLength(0)
    const ok = await gw.chatJson({ taskClass: 'translation', prompt, schema })
    expect(ok.data.ok).toBe(true)
    await expect(gw.embed(['x'])).rejects.toBeInstanceOf(ResidencyUnconfiguredError)
  })
  it('unconfigured stub mode still answers (nothing leaves the process)', async () => {
    const t = transport('{"ok":true}')
    const r = await createGateway(cfg(t.fetchImpl, { apiKey: null, residencyMode: 'unconfigured' })).chatJson({ taskClass: 'quote_extract', prompt, schema, stub: () => ({ ok: true }) })
    expect(r.stub).toBe(true)
  })
  it('waived and enforced postures allow the call', async () => {
    const t = transport('{"ok":true}')
    expect((await createGateway(cfg(t.fetchImpl, { residencyMode: 'waived' })).chatJson({ taskClass: 'quote_extract', prompt, schema })).data.ok).toBe(true)
  })
})

describe('gateway — OpenRouter retention preferences on every request (audit M23)', () => {
  it('sends provider { data_collection: deny, zdr: true } to OpenRouter only', async () => {
    const t = transport('{"ok":true}')
    const gw = createGateway(cfg(t.fetchImpl, { baseUrlByTier: { frontier: 'https://llm.in.example/v1' } }))
    await gw.chatJson({ taskClass: 'quote_extract', prompt, schema })
    await gw.chatJson({ taskClass: 'dispute_triage', prompt, schema })
    expect(t.calls[0]!.body['provider']).toEqual({ data_collection: 'deny', zdr: true })
    expect(t.calls[1]!.body['provider']).toBeUndefined()
  })
  it('a 4xx is final (no retry) and a data-policy miss has its own code', async () => {
    let n = 0
    const f = (async () => {
      n++
      return new Response('{"error":{"message":"No endpoints found matching your data policy"}}', { status: 404 })
    }) as unknown as typeof fetch
    const err = await createGateway(cfg(f, { maxRetries: 3 })).chatJson({ taskClass: 'quote_extract', prompt, schema }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GatewayHttpError)
    expect((err as GatewayHttpError).code).toBe('provider_policy_unmatched')
    expect((err as Error).message).toMatch(/^gateway 404: /)
    expect(n).toBe(1)
  })
})
