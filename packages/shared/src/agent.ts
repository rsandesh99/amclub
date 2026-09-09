import { z } from 'zod'

/**
 * Agentic assistant contract — H0 groundwork (DESIGN.md §8.6, ADR-008).
 *
 * This module is the single source of truth for WHAT an agent may do, on
 * whose behalf, and at what cost tier. It carries no runtime: the runner,
 * the model gateway and the surfaces consume it. Zero deps except zod, like
 * the rest of @amclub/shared, so web, mobile and the future runtime service
 * agree byte-for-byte.
 *
 * Governing rule (ADR-008): agents PROPOSE, the spine DISPOSES. An agent
 * calls the same /api/v1 routes a human does, under the user's own session,
 * so RLS and the state machines apply to it unchanged. Nothing here grants
 * a capability the calling user does not already have.
 */

// ── Task classes → cost tiers ─────────────────────────────────────────────────
// A task class names the KIND of model work, never a vendor or model id. The
// tier is the only thing that moves when prices or hardware change; the
// class→tier table is the routing policy and lives here so it is reviewable.

export const AGENT_TIERS = ['device', 'live', 'routine', 'reasoning', 'frontier'] as const
export type AgentTier = (typeof AGENT_TIERS)[number]

export const AGENT_TASK_CLASSES = [
  'speech_to_text',    // audio → text (+translate) — today Sarvam, later the live tier
  'rfq_parse',         // English requirement → structured RFQ prefill (Phase 8b)
  'rfq_clarify',       // one clarifying question in the user's language (H1)
  'document_extract',  // photographed notice/invoice → structured facts (H1)
  'quote_draft',       // RFQ → provider quote draft (H1)
  'quote_compare',     // ≤7 quotes → ranked comparison with reasons (H3)
  'translation',       // UI-adjacent short translation
  'embedding',         // retrieval vectors
  'dispute_summary',   // ops: neutral summary of a dispute thread (recommendation only)
] as const
export type AgentTaskClass = (typeof AGENT_TASK_CLASSES)[number]

export const TASK_CLASS_TIER: Record<AgentTaskClass, AgentTier> = {
  speech_to_text: 'live',
  rfq_parse: 'routine',
  rfq_clarify: 'live',
  document_extract: 'frontier',
  quote_draft: 'reasoning',
  quote_compare: 'reasoning',
  translation: 'routine',
  embedding: 'routine',
  dispute_summary: 'frontier',
}

export function tierFor(taskClass: AgentTaskClass): AgentTier {
  return TASK_CLASS_TIER[taskClass]
}

export const agentTaskClassSchema = z.enum(AGENT_TASK_CLASSES)
export const agentTierSchema = z.enum(AGENT_TIERS)

// ── Personas and tools ────────────────────────────────────────────────────────
// Three personas, each with a small allowlist. A persona cannot see another
// persona's tools at all — this allowlist is the prompt-injection boundary.
// Admin actions (KYC approval, payout release, dispute resolution) are NOT
// tools: the ops persona only ever produces recommendations.

export const AGENT_PERSONAS = ['buyer', 'provider', 'ops'] as const
export type AgentPersona = (typeof AGENT_PERSONAS)[number]
export const agentPersonaSchema = z.enum(AGENT_PERSONAS)

export interface AgentToolSpec {
  /** Stable tool name (snake_case); also the agent_events.tool value. */
  name: string
  persona: AgentPersona
  /**
   * true ⇒ executing this tool moves money or order/RFQ/quote status, so the
   * run parks in `awaiting_confirmation` and the SURFACE must record an
   * explicit user yes before the call is made. Fixed here, not in prompts.
   */
  confirm: boolean
  /** Model work this tool performs, if any (read-only API tools have none). */
  taskClass?: AgentTaskClass
  /** The /api/v1 capability the tool wraps, for reviewers (not executed here). */
  wraps: string
}

export const AGENT_TOOLS = [
  // buyer
  { name: 'search_catalog', persona: 'buyer', confirm: false, wraps: 'GET /catalog/search' },
  { name: 'draft_rfq', persona: 'buyer', confirm: false, taskClass: 'rfq_parse', wraps: 'local (prefill only)' },
  { name: 'clarify_rfq', persona: 'buyer', confirm: false, taskClass: 'rfq_clarify', wraps: 'local (question only)' },
  { name: 'extract_document', persona: 'buyer', confirm: false, taskClass: 'document_extract', wraps: 'local (facts only)' },
  { name: 'create_rfq', persona: 'buyer', confirm: true, wraps: 'POST /rfq' },
  { name: 'compare_quotes', persona: 'buyer', confirm: false, taskClass: 'quote_compare', wraps: 'GET /rfq/[id]' },
  { name: 'accept_quote', persona: 'buyer', confirm: true, wraps: 'POST /rfq/[id]/quote (accept)' },
  { name: 'place_order', persona: 'buyer', confirm: true, wraps: 'POST /checkout' },
  { name: 'track_order', persona: 'buyer', confirm: false, wraps: 'GET /orders/[id]' },
  { name: 'draft_dispute', persona: 'buyer', confirm: true, wraps: 'POST /orders/[id]/transition (disputed)' },
  // provider
  { name: 'extract_requirements', persona: 'provider', confirm: false, taskClass: 'rfq_parse', wraps: 'GET /rfq/matched' },
  { name: 'draft_quote', persona: 'provider', confirm: false, taskClass: 'quote_draft', wraps: 'local (draft only)' },
  { name: 'submit_quote', persona: 'provider', confirm: true, wraps: 'POST /rfq/[id]/quote' },
  { name: 'reply_thread', persona: 'provider', confirm: true, wraps: 'POST /quotes/[quoteId]/messages' },
  { name: 'list_deadlines', persona: 'provider', confirm: false, wraps: 'GET /orders (provider)' },
  // ops — recommendations only; never executes an admin action
  { name: 'summarize_dispute', persona: 'ops', confirm: false, taskClass: 'dispute_summary', wraps: 'GET /admin/disputes/[id]' },
  { name: 'triage_verification', persona: 'ops', confirm: false, wraps: 'GET /admin/providers/[id]' },
  { name: 'recommend_payout_release', persona: 'ops', confirm: false, wraps: 'GET /admin/payouts (read-only)' },
] as const satisfies readonly AgentToolSpec[]

export type AgentToolName = (typeof AGENT_TOOLS)[number]['name']
export const agentToolNameSchema = z.enum(
  AGENT_TOOLS.map((t) => t.name) as [AgentToolName, ...AgentToolName[]],
)

const TOOL_BY_NAME: Record<string, AgentToolSpec> = Object.fromEntries(
  AGENT_TOOLS.map((t) => [t.name, t]),
)

export function agentTool(name: AgentToolName): AgentToolSpec {
  return TOOL_BY_NAME[name]!
}

/** Tools visible to a persona — everything else does not exist for it. */
export function toolsForPersona(persona: AgentPersona): readonly AgentToolSpec[] {
  return AGENT_TOOLS.filter((t) => t.persona === persona)
}

export function isToolAllowed(persona: AgentPersona, tool: string): tool is AgentToolName {
  const spec = TOOL_BY_NAME[tool]
  return Boolean(spec && spec.persona === persona)
}

export function requiresConfirmation(tool: AgentToolName): boolean {
  return agentTool(tool).confirm
}

/**
 * Which platform role may run a persona. An agent run is opened under the
 * user's own session; this maps the persona to the role that session must
 * hold (mirrors users.roles). ops requires admin — and even then only
 * produces recommendations.
 */
export const PERSONA_REQUIRED_ROLE: Record<AgentPersona, 'msme' | 'provider' | 'admin'> = {
  buyer: 'msme',
  provider: 'provider',
  ops: 'admin',
}

// ── Event kinds (agent_events, append-only) ───────────────────────────────────

export const AGENT_EVENT_KINDS = [
  'started',
  'model_call',        // one model invocation (ai_invocations.run_id links the row)
  'tool_proposed',     // agent wants to call `tool` with `payload`
  'confirmation_requested',
  'confirmed',         // user said yes (recorded by the surface)
  'declined',          // user said no
  'tool_called',       // the /api/v1 call was made; `payload` holds status + ids
  'completed',
  'failed',
  'cancelled',
] as const
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number]
export const agentEventKindSchema = z.enum(AGENT_EVENT_KINDS)
