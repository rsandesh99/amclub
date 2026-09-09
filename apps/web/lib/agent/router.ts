import 'server-only'
import { tierFor, type AgentTaskClass, type AgentTier } from '@amclub/shared'

/**
 * Task-class model router — H0 groundwork (ADR-008 §Routing).
 *
 * The ONLY place a task class becomes a model id. The class→tier policy lives
 * in @amclub/shared (reviewable, shared with mobile + the future runtime);
 * this file maps tier → model id from env so a price or hardware change is a
 * Vercel env edit, never a deploy of logic. Every model id is an
 * OpenAI-compatible route (OpenRouter namespace today; vLLM / owned cluster /
 * another vendor later behind the same gateway).
 *
 *   AGENT_MODEL_LIVE       — speech / clarifying turn (today: Sarvam STT is
 *                            a separate vendor; this id is for the LLM leg)
 *   AGENT_MODEL_ROUTINE    — cheap structured extraction (rfq_parse, …)
 *   AGENT_MODEL_REASONING  — quote drafting / comparison
 *   AGENT_MODEL_FRONTIER   — document interpretation, dispute summary
 *
 * Precedence for the existing voice parser is preserved: VOICE_PARSE_MODEL
 * (if set) > AGENT_MODEL_ROUTINE > default. The default for the routine tier
 * is byte-identical to the Phase 8b parser default, so this change is
 * behaviour-neutral until an env var is set.
 */

const DEFAULTS: Record<Exclude<AgentTier, 'device'>, string> = {
  live: 'google/gemini-2.5-flash-lite',
  routine: 'google/gemini-2.5-flash-lite',
  reasoning: 'qwen/qwen3-235b-a22b',
  frontier: 'anthropic/claude-sonnet-4.5',
}

const ENV_KEY: Record<Exclude<AgentTier, 'device'>, string> = {
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
  const model = process.env[ENV_KEY[tier]] || DEFAULTS[tier]
  return { taskClass, tier, model }
}
