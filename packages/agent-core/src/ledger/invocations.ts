/**
 * Pure AI-cost math (moved here from apps/web/lib/voice/invocations.ts so the
 * runtime and the Vercel functions estimate cost identically — ONE place). No
 * I/O, no admin client; env-driven rates so a price change is never a deploy of
 * logic. `apps/web/lib/voice/invocations.ts` re-imports these.
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

/** OpenRouter usage.cost (USD) -> paise (OPENROUTER_USD_INR_PAISE, default 8800). Stub -> 0. */
export function estimateParseCostPaise(usage: Record<string, unknown> | undefined, stub: boolean): number | null {
  if (stub) return 0
  const usd = typeof usage?.['cost'] === 'number' ? (usage['cost'] as number) : null
  if (usd === null) return null
  const paisePerUsd = Number(process.env['OPENROUTER_USD_INR_PAISE'] ?? '8800')
  return Math.ceil(usd * paisePerUsd)
}

/** USD -> paise using the same env rate as the parser (default ₹88/USD). */
export function usdToPaise(usd: number | null): number | null {
  if (usd === null || !Number.isFinite(usd)) return null
  const paisePerUsd = Number(process.env['OPENROUTER_USD_INR_PAISE'] ?? '8800')
  return Math.ceil(usd * paisePerUsd)
}
