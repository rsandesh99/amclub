import 'server-only'

/**
 * Task-class model router (ADR-008 §Routing, ADR-009 §6). The mapping now lives
 * in @amclub/agent-core (src/llm/router.ts) so the runtime and the Vercel
 * functions share ONE tier -> model-id policy. This module re-exports it so
 * existing web callers (lib/voice/parser.ts) keep importing from here unchanged.
 *
 * Precedence for the existing voice parser is preserved by the parser itself
 * (VOICE_PARSE_MODEL > AGENT_MODEL_ROUTINE > default); this router only maps a
 * task class to its tier's env-driven model id.
 */
export {
  resolveModel,
  resolveEmbeddingModel,
  MODEL_DEFAULTS,
  MODEL_ENV_KEY,
  type ResolvedModel,
} from '@amclub/agent-core'
