/**
 * Pure AI-cost math (moved here from apps/web/lib/voice/invocations.ts so the
 * runtime and the Vercel functions estimate cost identically — ONE place). No
 * I/O, no admin client; env-driven rates so a price change is never a deploy of
 * logic. `apps/web/lib/voice/invocations.ts` re-imports these.
 *
 * Cost law (ARCHITECTURE.md §9): a non-stub model call is NEVER recorded as
 * free. Precedence: vendor-reported USD (OpenRouter usage.cost) → token counts ×
 * the model's rate from AGENT_MODEL_RATES → token counts × the conservative
 * FALLBACK_MODEL_RATE (with a warning). Unknown token counts are assumed at
 * FALLBACK_TOKENS so even a usage-less response costs something.
 */

/** OpenAI-compatible usage -> token counts (OpenRouter returns this shape). */
export function tokensFromUsage(
  meta: Record<string, unknown> | undefined,
): { input: number | null; output: number | null } {
  const usage = meta?.['usage']
  if (!usage || typeof usage !== 'object') return { input: null, output: null }
  const u = usage as Record<string, unknown>
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)
  return { input: n(u['prompt_tokens']), output: n(u['completion_tokens']) }
}

/** STT cost per audio-minute (SARVAM_COST_PAISE_PER_MIN). Stub -> 0; unset -> null. */
export function estimateSttCostPaise(durationMs: number, stub: boolean): number | null {
  if (stub) return 0
  const perMin = Number(process.env['SARVAM_COST_PAISE_PER_MIN'] ?? '')
  if (!Number.isFinite(perMin) || perMin <= 0) return null
  return Math.ceil((durationMs / 60_000) * perMin)
}

/** Audit M24 — the fallback rate when SARVAM_COST_PAISE_PER_MIN is unset (a conservative ₹0.50 / audio-minute). */
export const STT_FALLBACK_PAISE_PER_MIN = 50

/** What a speech-to-text call charges the AI budget: the estimate, else the fallback — never ₹0 for a live call. */
export function sttBudgetChargePaise(durationMs: number, stub: boolean): number {
  if (stub) return 0
  const e = estimateSttCostPaise(durationMs, false)
  return e ?? Math.max(1, Math.ceil((Math.max(0, durationMs) / 60_000) * STT_FALLBACK_PAISE_PER_MIN))
}

/**
 * OpenRouter usage (raw) -> paise. Stub -> 0. Vendor `cost` (USD) when present;
 * otherwise estimated from the raw token counts (never null for a live call).
 */
export function estimateParseCostPaise(usage: Record<string, unknown> | undefined, stub: boolean, model?: string | null): number | null {
  if (stub) return 0
  const usd = typeof usage?.['cost'] === 'number' ? (usage['cost'] as number) : null
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)
  return costPaiseFor({
    stub: false,
    costUsd: usd,
    model: model ?? null,
    inputTokens: n(usage?.['prompt_tokens']),
    outputTokens: n(usage?.['completion_tokens']),
  }).paise
}

/** USD -> paise using the same env rate as the parser (default ₹88/USD). */
export function usdToPaise(usd: number | null): number | null {
  if (usd === null || !Number.isFinite(usd)) return null
  const paisePerUsd = Number(process.env['OPENROUTER_USD_INR_PAISE'] ?? '8800')
  return Math.ceil(usd * paisePerUsd)
}

// ── Token-rate estimation ────────────────────────────────────────────────────

export interface ModelRate {
  /** USD per million input (prompt) tokens. */
  inPerMTokUsd: number
  /** USD per million output (completion) tokens. */
  outPerMTokUsd: number
}

/**
 * Conservative fallback when a model has no configured rate: frontier-class
 * list prices, so an unpriced model over-counts rather than under-counts.
 */
export const FALLBACK_MODEL_RATE: ModelRate = { inPerMTokUsd: 3, outPerMTokUsd: 15 }

/** Assumed token counts when the vendor returned no usage at all. */
export const FALLBACK_TOKENS = { input: 2000, output: 800 } as const

function isRate(v: unknown): v is ModelRate {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  const ok = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0
  return ok(r['inPerMTokUsd']) && ok(r['outPerMTokUsd'])
}

/**
 * Parse AGENT_MODEL_RATES — JSON `{ "<model id>": { "inPerMTokUsd": n, "outPerMTokUsd": n } }`.
 * Invalid JSON or invalid entries are ignored (with a warning); never throws.
 */
export function modelRatesFromEnv(raw: string | undefined = process.env['AGENT_MODEL_RATES']): Record<string, ModelRate> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    const out: Record<string, ModelRate> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isRate(v)) out[k] = { inPerMTokUsd: v.inPerMTokUsd, outPerMTokUsd: v.outPerMTokUsd }
    }
    return out
  } catch (e) {
    console.warn('[agent-core cost] AGENT_MODEL_RATES is not valid JSON — using the fallback rate', (e as Error).message)
    return {}
  }
}

export type CostSource = 'stub' | 'vendor' | 'rate' | 'fallback'

export interface CostArgs {
  stub: boolean
  /** Vendor-reported USD (null/undefined when absent). */
  costUsd: number | null | undefined
  model: string | null | undefined
  inputTokens: number | null | undefined
  outputTokens: number | null | undefined
  /** Rate table; defaults to AGENT_MODEL_RATES. */
  rates?: Record<string, ModelRate>
}

const warnedModels = new Set<string>()

/** Token counts × rate -> USD. */
export function estimateUsdFromTokens(inputTokens: number, outputTokens: number, rate: ModelRate): number {
  return (Math.max(0, inputTokens) * rate.inPerMTokUsd + Math.max(0, outputTokens) * rate.outPerMTokUsd) / 1_000_000
}

/**
 * The ONE cost function for a model call. A stub costs 0; a live call always
 * costs ≥ 1 paise (vendor cost, else estimated from tokens × rate, else the
 * conservative fallback rate with a one-time warning per model).
 */
export function costPaiseFor(args: CostArgs): { paise: number; source: CostSource } {
  if (args.stub) return { paise: 0, source: 'stub' }
  if (typeof args.costUsd === 'number' && Number.isFinite(args.costUsd) && args.costUsd >= 0) {
    const vendor = usdToPaise(args.costUsd) ?? 0
    // A vendor that reports cost 0 for a billed call (free tier / promo) is taken at its word.
    return { paise: vendor, source: 'vendor' }
  }
  const rates = args.rates ?? modelRatesFromEnv()
  const model = args.model ?? ''
  const configured = model ? rates[model] : undefined
  const rate = configured ?? FALLBACK_MODEL_RATE
  const input = args.inputTokens ?? (args.outputTokens == null ? FALLBACK_TOKENS.input : 0)
  const output = args.outputTokens ?? (args.inputTokens == null ? FALLBACK_TOKENS.output : 0)
  if (!configured && !warnedModels.has(model)) {
    warnedModels.add(model)
    console.warn(`[agent-core cost] no vendor cost and no AGENT_MODEL_RATES entry for model '${model || 'unknown'}' — using the conservative fallback rate`)
  }
  const usd = estimateUsdFromTokens(input, output, rate)
  const paise = Math.max(1, usdToPaise(usd) ?? 1)
  return { paise, source: configured ? 'rate' : 'fallback' }
}
