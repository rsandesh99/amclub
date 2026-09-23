import type { z } from 'zod'
import { residencyFor, tierFor, type AgentTaskClass, type AgentTier } from '@amclub/shared'
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
 *
 * Track F hardening:
 *  - every chat call sends `max_tokens` (call → prompt front-matter → tier default)
 *    so one runaway response cannot blow through the budget caps, which are only
 *    checked BEFORE a call;
 *  - a billed response that fails JSON / Zod validation throws a
 *    GatewayValidationError that CARRIES the usage, so the runner / bounded
 *    helper log the paid call and add its cost before rethrowing;
 *  - per-tier base URLs (AGENT_LLM_BASE_URL_<TIER>) and an OPT-IN data-residency
 *    guard (AGENT_RESIDENCY_ENFORCE=true + AGENT_IN_RESIDENCY_HOSTS): an 'in'
 *    task class is refused before any byte leaves for a host off the allow-list.
 */

/** Conservative per-tier output caps (tokens). Env override AGENT_MAX_TOKENS_<TIER>. */
export const DEFAULT_MAX_TOKENS_BY_TIER: Record<Exclude<AgentTier, 'device'>, number> = {
  live: 800,
  routine: 1200,
  // reasoning models spend part of max_tokens on hidden reasoning; a lower cap truncates the JSON.
  reasoning: 4000,
  frontier: 2500,
}

export function defaultMaxTokens(tier: AgentTier): number {
  const t = tier === 'device' ? 'live' : tier
  const env = Number(process.env[`AGENT_MAX_TOKENS_${t.toUpperCase()}`] ?? '')
  return Number.isInteger(env) && env > 0 ? env : DEFAULT_MAX_TOKENS_BY_TIER[t]
}

/** A gateway failure with a stable machine code (the runner reports it as the run error). */
export class GatewayError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'GatewayError'
  }
}

export type GatewayValidationReason = 'no_content' | 'non_json' | 'schema' | 'truncated'

/**
 * The vendor answered (and billed) but the output is unusable. Carries usage /
 * model / latency so the caller logs the paid call and charges the budget.
 */
export class GatewayValidationError extends GatewayError {
  constructor(
    public reason: GatewayValidationReason,
    public usage: ChatUsage,
    public model: string,
    public latencyMs: number,
    detail?: string,
  ) {
    super('model_output_invalid', `gateway: model output invalid (${reason})${detail ? `: ${detail}` : ''}`)
    this.name = 'GatewayValidationError'
  }
}

/** An 'in'-residency task class would have been sent to a host outside AGENT_IN_RESIDENCY_HOSTS. */
export class ResidencyViolationError extends GatewayError {
  constructor(public taskClass: AgentTaskClass, public host: string) {
    super('residency_violation', `gateway: task class '${taskClass}' is in-India residency; host '${host}' is not on AGENT_IN_RESIDENCY_HOSTS`)
    this.name = 'ResidencyViolationError'
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

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
  /** S1.8 — explicit model id for this call (an env override such as VOICE_PARSE_MODEL); default = the task class's tier model. */
  model?: string
  /** Output cap for this call. Default: prompt.maxTokens, else the tier default. Always sent as max_tokens. */
  maxTokens?: number
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
  /** Default chat base URL (AGENT_LLM_BASE_URL). */
  baseUrl: string
  /** Per-tier overrides (AGENT_LLM_BASE_URL_<TIER>); a missing tier falls back to baseUrl. */
  baseUrlByTier?: Partial<Record<AgentTier, string>>
  /** AGENT_RESIDENCY_ENFORCE=true — refuse an 'in' class to a host off the allow-list. Default off. */
  residencyEnforce?: boolean
  /** AGENT_IN_RESIDENCY_HOSTS — hostnames that keep data in India (lower-case). */
  inResidencyHosts?: readonly string[]
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

export const TIER_BASE_URL_ENV_KEY: Record<Exclude<AgentTier, 'device'>, string> = {
  live: 'AGENT_LLM_BASE_URL_LIVE',
  routine: 'AGENT_LLM_BASE_URL_ROUTINE',
  reasoning: 'AGENT_LLM_BASE_URL_REASONING',
  frontier: 'AGENT_LLM_BASE_URL_FRONTIER',
}

export function gatewayConfigFromEnv(): GatewayConfig {
  const baseUrl = process.env['AGENT_LLM_BASE_URL'] || 'https://openrouter.ai/api/v1'
  const apiKey = process.env['AGENT_LLM_API_KEY'] || process.env['OPENROUTER_API_KEY'] || null
  const baseUrlByTier: Partial<Record<AgentTier, string>> = {}
  for (const [tier, key] of Object.entries(TIER_BASE_URL_ENV_KEY) as Array<[AgentTier, string]>) {
    const v = process.env[key]
    if (v) baseUrlByTier[tier] = v
  }
  const hosts = (process.env['AGENT_IN_RESIDENCY_HOSTS'] ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
  return {
    baseUrl,
    baseUrlByTier,
    residencyEnforce: process.env['AGENT_RESIDENCY_ENFORCE'] === 'true',
    inResidencyHosts: hosts,
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

/** Chat base URL for a tier: AGENT_LLM_BASE_URL_<TIER>, else AGENT_LLM_BASE_URL. */
export function baseUrlForTier(config: GatewayConfig, tier: AgentTier): string {
  return config.baseUrlByTier?.[tier] || config.baseUrl
}

/**
 * The residency guard (opt-in). Throws ResidencyViolationError when enforcement
 * is on, the class is 'in', and the host is not on the allow-list. Logged.
 */
export function assertResidency(config: GatewayConfig, taskClass: AgentTaskClass, url: string): void {
  if (!config.residencyEnforce) return
  if (residencyFor(taskClass) !== 'in') return
  const host = hostOf(url)
  const allowed = (config.inResidencyHosts ?? []).map((h) => h.toLowerCase())
  if (host && allowed.includes(host)) return
  const err = new ResidencyViolationError(taskClass, host || url)
  console.error('[agent-core gateway] residency refused', { taskClass, host: host || null })
  throw err
}

/** Strip a ```json … ``` fence some vendors wrap JSON-mode output in. */
function unfence(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
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
    const model = params.model || resolveModel(params.taskClass).model
    const started = Date.now()

    if (stubMode) {
      if (!params.stub) {
        throw new Error(`no LLM key configured and no stub provided for taskClass '${params.taskClass}'`)
      }
      const data = params.schema.parse(params.stub())
      return { data, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, raw: null }, model: 'stub', latencyMs: Date.now() - started, stub: true }
    }

    const tier = tierFor(params.taskClass)
    const url = `${baseUrlForTier(config, tier)}/chat/completions`
    assertResidency(config, params.taskClass, url)
    const maxTokens = params.maxTokens ?? params.prompt.maxTokens ?? defaultMaxTokens(tier)
    const messages = buildMessages(params.prompt, params.parts, 'Return ONLY a JSON object that matches the required schema.')
    const responseFormat = params.jsonSchema
      ? { type: 'json_schema', json_schema: { name: `${params.prompt.id}_${params.prompt.version}`, schema: params.jsonSchema, strict: true } }
      : { type: 'json_object' }
    const body = {
      model,
      messages,
      temperature: params.temperature ?? 0,
      response_format: responseFormat,
      max_tokens: maxTokens,
      usage: { include: true },
    }
    const json = await postJson(url, body, params.signal)
    // From here on the call is billed: every failure carries the usage.
    const usage = usageFrom(json['usage'])
    const invalid = (reason: GatewayValidationReason, detail?: string) =>
      new GatewayValidationError(reason, usage, model, Date.now() - started, detail)
    const choices = json['choices'] as Array<{ message?: { content?: string }; finish_reason?: string }> | undefined
    const truncated = choices?.[0]?.finish_reason === 'length'
    const content = choices?.[0]?.message?.content
    if (typeof content !== 'string') throw invalid(truncated ? 'truncated' : 'no_content')
    let parsed: unknown
    try {
      parsed = JSON.parse(unfence(content))
    } catch {
      throw invalid(truncated ? 'truncated' : 'non_json')
    }
    const result = params.schema.safeParse(parsed)
    if (!result.success) throw invalid('schema', result.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
    return { data: result.data, usage, model, latencyMs: Date.now() - started, stub: false }
  }

  async function embed(texts: string[], opts?: { stub?: () => number[][] }): Promise<EmbedResult> {
    const model = resolveEmbeddingModel()
    const started = Date.now()
    if (stubMode) {
      const vectors = opts?.stub ? opts.stub() : texts.map(() => [])
      return { vectors, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, raw: null }, model: 'stub', latencyMs: Date.now() - started, stub: true }
    }
    const url = `${config.embedBaseUrl}/embeddings`
    assertResidency(config, 'embedding', url)
    const json = await postJson(url, { model, input: texts })
    const rows = json['data'] as Array<{ embedding?: number[] }> | undefined
    const vectors = (rows ?? []).map((r) => r.embedding ?? [])
    return { vectors, usage: usageFrom(json['usage']), model, latencyMs: Date.now() - started, stub: false }
  }

  return { chatJson, embed }
}
