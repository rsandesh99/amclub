import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  createGateway,
  DEFAULT_MAX_TOKENS_BY_TIER,
  gatewayConfigFromEnv,
  GatewayValidationError,
  ResidencyViolationError,
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
