import type { z } from 'zod'
import type { AgentTaskClass } from '@amclub/shared'
import { resolveModel, resolveEmbeddingModel } from './router'
import {
  assertEnvelope,
  renderUntrustedAll,
  UNTRUSTED_SYSTEM_NOTE,
  type Envelope,
} from '../untrusted/envelope'
import type { PromptRef } from '../prompts/registry'

/**
 * The model gateway (ARCHITECTURE.md §5-§6). One OpenAI-compatible client shared
 * by the runtime and the Vercel functions: JSON output validated by Zod, prompt
 * built from TRUSTED parts + untrusted Envelopes kept separate, retries with
 * jitter, a hard timeout, and stub mode so CI (and any keyless env) never bills.
 * Model ids come only from the router; a prompt never names one.
 */

export interface ChatUsage {
  inputTokens: number | null
  outputTokens: number | null
  /** Vendor-reported cost in USD when available (OpenRouter usage.cost). */
  costUsd: number | null
  /** Raw usage object for the cost estimator + audit. */
  raw: Record<string, unknown> | null
}

export interface ChatResult<T> {
  data: T
  usage: ChatUsage
  model: string
  latencyMs: number
  /** True when no key was configured and the stub producer was used. */
  stub: boolean
}

export interface ChatParts {
  /** Platform-owned data — safe to place in the prompt directly. */
  trusted?: string[]
  /** Third-party content — MUST be Envelopes; rendered inside <untrusted> tags. */
  untrusted?: Envelope[]
  /**
   * Images for a vision call (S1.4): each becomes an OpenAI-compatible
   * image_url part, preceded by its label as a text part so the model can name
   * it in the output. Signed URLs or data: URLs. Stub mode ignores them.
   */
  images?: ChatImage[]
}

export interface ChatImage {
  url: string
  mime: string
  /** Stable label the model echoes back (e.g. the order_documents id). */
  label?: string
}

export interface ChatJsonParams<T> {
  taskClass: AgentTaskClass
  prompt: PromptRef
  /** Output type T; the input shape may differ (defaults), so ZodType<T, Def, unknown>. */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
  parts?: ChatParts
  temperature?: number
  /** Optional JSON Schema for strict response_format; falls back to JSON mode + Zod. */
  jsonSchema?: Record<string, unknown>
  /** Stub-mode producer: returned (schema-validated) when no key is configured. */
  stub?: () => T
  signal?: AbortSignal
}

export interface EmbedResult {
  vectors: number[][]
  usage: ChatUsage
  model: string
  latencyMs: number
  stub: boolean
}

export interface Gateway {
  chatJson<T>(params: ChatJsonParams<T>): Promise<ChatResult<T>>
  embed(texts: string[], opts?: { stub?: () => number[][] }): Promise<EmbedResult>
}

export interface GatewayConfig {
  baseUrl: string
  apiKey: string | null
  embedBaseUrl: string
  timeoutMs: number
  maxRetries: number
  /** Force stub mode even if a key exists (tests / dry runs). */
  forceStub: boolean
  referer?: string
  title?: string
  /** Transport override (tests / fake vendors). Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export function gatewayConfigFromEnv(): GatewayConfig {
  const baseUrl = process.env['AGENT_LLM_BASE_URL'] || 'https://openrouter.ai/api/v1'
  const apiKey = process.env['AGENT_LLM_API_KEY'] || process.env['OPENROUTER_API_KEY'] || null
  return {
    baseUrl,
    apiKey,
    embedBaseUrl: process.env['AGENT_EMBED_BASE_URL'] || baseUrl,
    timeoutMs: Number(process.env['AGENT_LLM_TIMEOUT_MS'] ?? '30000'),
    maxRetries: Number(process.env['AGENT_LLM_MAX_RETRIES'] ?? '3'),
    forceStub: process.env['AGENT_LLM_STUB'] === '1',
    ...(process.env['AGENT_LLM_REFERER'] ? { referer: process.env['AGENT_LLM_REFERER'] } : {}),
    ...(process.env['AGENT_LLM_TITLE'] ? { title: process.env['AGENT_LLM_TITLE'] } : {}),
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function usageFrom(raw: unknown): ChatUsage {
  if (!raw || typeof raw !== 'object') return { inputTokens: null, outputTokens: null, costUsd: null, raw: null }
  const u = raw as Record<string, unknown>
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)
  const c = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    inputTokens: n(u['prompt_tokens']),
    outputTokens: n(u['completion_tokens']),
    costUsd: c(u['cost']),
    raw: u,
  }
}

type UserContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>

export function buildMessages(prompt: PromptRef, parts: ChatParts | undefined, userLead: string): Array<{ role: 'system' | 'user'; content: UserContent }> {
  const trusted = parts?.trusted ?? []
  const untrusted = parts?.untrusted ?? []
  const images = parts?.images ?? []
  for (const e of untrusted) assertEnvelope(e)
  const system = untrusted.length > 0 ? `${prompt.text}\n\n${UNTRUSTED_SYSTEM_NOTE}` : prompt.text
  const userBlocks = [userLead, ...trusted]
  if (untrusted.length > 0) userBlocks.push(renderUntrustedAll(untrusted))
  const text = userBlocks.filter(Boolean).join('\n\n')
  if (images.length === 0) {
    return [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ]
  }
  // Multimodal (S1.4): one text part with everything textual, then label + image pairs.
  const content: Exclude<UserContent, string> = [{ type: 'text', text }]
  for (const img of images) {
    if (img.label) content.push({ type: 'text', text: `Image label: ${img.label}` })
    content.push({ type: 'image_url', image_url: { url: img.url } })
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content },
  ]
}

export function createGateway(config: GatewayConfig = gatewayConfigFromEnv()): Gateway {
  const stubMode = config.forceStub || !config.apiKey

  function headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey ?? ''}`,
    }
    if (config.referer) h['HTTP-Referer'] = config.referer
    if (config.title) h['X-Title'] = config.title
    return h
  }

  async function postJson(url: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), config.timeoutMs)
      const onAbort = () => ctrl.abort()
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      try {
        const res = await (config.fetchImpl ?? fetch)(url, { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: ctrl.signal })
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`gateway ${res.status}`)
        } else if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`gateway ${res.status}: ${text.slice(0, 300)}`)
        } else {
          return (await res.json()) as Record<string, unknown>
        }
      } catch (e) {
        lastErr = e
      } finally {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
      }
      if (attempt < config.maxRetries) await sleep(250 * 2 ** attempt + Math.random() * 250)
    }
    throw lastErr instanceof Error ? lastErr : new Error('gateway request failed')
  }

  async function chatJson<T>(params: ChatJsonParams<T>): Promise<ChatResult<T>> {
    const { model } = resolveModel(params.taskClass)
    const started = Date.now()

    if (stubMode) {
      if (!params.stub) {
        throw new Error(`no LLM key configured and no stub provided for taskClass '${params.taskClass}'`)
      }
      const data = params.schema.parse(params.stub())
      return { data, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, raw: null }, model: 'stub', latencyMs: Date.now() - started, stub: true }
    }

    const messages = buildMessages(params.prompt, params.parts, 'Return ONLY a JSON object that matches the required schema.')
    const responseFormat = params.jsonSchema
      ? { type: 'json_schema', json_schema: { name: `${params.prompt.id}_${params.prompt.version}`, schema: params.jsonSchema, strict: true } }
      : { type: 'json_object' }
    const body = {
      model,
      messages,
      temperature: params.temperature ?? 0,
      response_format: responseFormat,
      usage: { include: true },
    }
    const json = await postJson(`${config.baseUrl}/chat/completions`, body, params.signal)
    const choices = json['choices'] as Array<{ message?: { content?: string } }> | undefined
    const content = choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('gateway returned no message content')
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new Error('gateway returned non-JSON content in JSON mode')
    }
    const data = params.schema.parse(parsed)
    return { data, usage: usageFrom(json['usage']), model, latencyMs: Date.now() - started, stub: false }
  }

  async function embed(texts: string[], opts?: { stub?: () => number[][] }): Promise<EmbedResult> {
    const model = resolveEmbeddingModel()
    const started = Date.now()
    if (stubMode) {
      const vectors = opts?.stub ? opts.stub() : texts.map(() => [])
      return { vectors, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, raw: null }, model: 'stub', latencyMs: Date.now() - started, stub: true }
    }
    const json = await postJson(`${config.embedBaseUrl}/embeddings`, { model, input: texts })
    const rows = json['data'] as Array<{ embedding?: number[] }> | undefined
    const vectors = (rows ?? []).map((r) => r.embedding ?? [])
    return { vectors, usage: usageFrom(json['usage']), model, latencyMs: Date.now() - started, stub: false }
  }

  return { chatJson, embed }
}
