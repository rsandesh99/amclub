import { tierFor, type AgentTaskClass, type AgentTier } from '@amclub/shared'

/**
 * The ONE tier -> model-id mapping (ARCHITECTURE.md §6). The class->tier policy
 * lives in @amclub/shared (reviewable, shared everywhere); this file turns a
 * tier into an OpenAI-compatible model id from env, so a price or hardware
 * change is an env edit, never a deploy of logic. Cloud -> rented GPU -> owned
 * cluster is a serving change behind the same gateway.
 *
 * apps/web/lib/agent/router.ts re-exports resolveModel from here, so there is
 * exactly one mapping across the runtime and the Vercel functions.
 */

export const MODEL_DEFAULTS: Record<Exclude<AgentTier, 'device'>, string> = {
  live: 'google/gemini-2.5-flash-lite',
  routine: 'google/gemini-2.5-flash-lite',
  reasoning: 'qwen/qwen3-235b-a22b',
  frontier: 'anthropic/claude-sonnet-4.5',
}

export const MODEL_ENV_KEY: Record<Exclude<AgentTier, 'device'>, string> = {
  live: 'AGENT_MODEL_LIVE',
  routine: 'AGENT_MODEL_ROUTINE',
  reasoning: 'AGENT_MODEL_REASONING',
  frontier: 'AGENT_MODEL_FRONTIER',
}

export interface ResolvedModel {
  taskClass: AgentTaskClass
  tier: AgentTier
  /** OpenAI-compatible model id (OpenRouter namespace by default). */
  model: string
}

export function resolveModel(taskClass: AgentTaskClass): ResolvedModel {
  const tier = tierFor(taskClass)
  if (tier === 'device') {
    throw new Error(`task class ${taskClass} is device-tier; it has no server model`)
  }
  const model = process.env[MODEL_ENV_KEY[tier]] || MODEL_DEFAULTS[tier]
  return { taskClass, tier, model }
}

/** The embedding model id (routine tier by policy). Env-driven; no default vendor lock-in. */
export function resolveEmbeddingModel(): string {
  return process.env['AGENT_MODEL_EMBEDDING'] || 'openai/text-embedding-3-small'
}
