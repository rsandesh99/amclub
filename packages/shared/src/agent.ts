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
  'text_to_speech',    // text → audio for the speech leg (live tier)
  'rfq_parse',         // English requirement → structured RFQ prefill (Phase 8b)
  'rfq_clarify',       // one clarifying question in the user's language (H1)
  'rfq_quality',       // pre-fan-out RFQ completeness check (S1.5)
  'document_extract',  // photographed notice/invoice → structured facts (H1)
  'quote_draft',       // RFQ → provider quote draft (H1)
  'quote_extract',     // provider's free text → structured quote fields (S1.1)
  'quote_compare',     // ≤7 quotes → ranked comparison with reasons (H3)
  'decline_message',   // polite, translated decline copy (S1.2 / S0.4)
  'onboarding_interview', // provider intake interview turn (S1.6)
  'dispute_summary',   // ops: neutral summary of a dispute thread (recommendation only)
  'dispute_triage',    // ops: triage card for a dispute (S1.7)
  'photo_plausibility',// is this evidence photo plausibly of the work? (S0.3/S1.4)
  'support_intent',    // S2.3: classify a support message into an intent + references (NEVER reply text)
  'approval_intent',   // S2.2: classify a provider's reply to a Munshi draft (re-ask / edit / reject — can NEVER approve)
  'thread_reply',      // S2.2: draft a courteous reply on a quote thread (no price change)
  'support_reply',     // customer support reply, bounded + safe (S2.3)
  'score_note',        // S2.4: one informational coaching sentence from score components (numbers + keys only; no free text in)
  'benchmark_explain', // fair-price range explanation (S3.2)
  'translation',       // UI-adjacent short translation
  'embedding',         // retrieval vectors
] as const
export type AgentTaskClass = (typeof AGENT_TASK_CLASSES)[number]

// class→tier is the reviewable routing policy (ARCHITECTURE.md §6). The tier is
// the only thing that moves when prices or hardware change; ids live in the
// router (agent-core/src/llm), never here.
export const TASK_CLASS_TIER: Record<AgentTaskClass, AgentTier> = {
  speech_to_text: 'live',
  text_to_speech: 'live',
  rfq_parse: 'routine',
  rfq_clarify: 'live',
  rfq_quality: 'routine',
  document_extract: 'frontier',
  quote_draft: 'reasoning',
  quote_extract: 'routine',
  quote_compare: 'reasoning',
  decline_message: 'routine',
  onboarding_interview: 'reasoning',
  dispute_summary: 'frontier',
  dispute_triage: 'frontier',
  photo_plausibility: 'frontier',
  support_intent: 'routine',
  approval_intent: 'routine',
  thread_reply: 'routine',
  support_reply: 'reasoning',
  score_note: 'routine',
  benchmark_explain: 'frontier',
  translation: 'routine',
  embedding: 'routine',
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
  // S1.2 — buyer declines a quote with a reason; a quotes.status write, so confirm-gated.
  { name: 'decline_quote', persona: 'buyer', confirm: true, wraps: 'POST /rfq/[id]/quote/[quoteId]/decline' },
  // S1.3 — buyer answers a provider's clarification (visible to every matched provider); a write, so confirm-gated.
  { name: 'answer_clarification', persona: 'buyer', confirm: true, wraps: 'POST /rfq/[id]/clarifications/[cid]/answer' },
  // S1.5 — pre-fan-out completeness: the check only produces questions (local, no write); the buyer's
  // answer / send-as-is is the confirmation and the only write (fan-out release), so confirm-gated.
  { name: 'check_rfq_quality', persona: 'buyer', confirm: false, taskClass: 'rfq_quality', wraps: 'local (questions only)' },
  { name: 'complete_rfq', persona: 'buyer', confirm: true, wraps: 'POST /rfq/[id]/quality/{answer|send}' },
  // provider
  { name: 'extract_requirements', persona: 'provider', confirm: false, taskClass: 'rfq_parse', wraps: 'GET /rfq/matched' },
  { name: 'draft_quote', persona: 'provider', confirm: false, taskClass: 'quote_draft', wraps: 'local (draft only)' },
  // S1.1 — free text → quote form prefill; the provider's Submit is the only write (confirm-gated submit_quote).
  { name: 'extract_quote', persona: 'provider', confirm: false, taskClass: 'quote_extract', wraps: 'local (prefill only)' },
  { name: 'submit_quote', persona: 'provider', confirm: true, wraps: 'POST /rfq/[id]/quote' },
  { name: 'reply_thread', persona: 'provider', confirm: true, wraps: 'POST /quotes/[quoteId]/messages' },
  // S1.3 — RFQ-level clarification (every matched provider reads it) and in-place quote revision; both writes, confirm-gated.
  { name: 'ask_clarification', persona: 'provider', confirm: true, wraps: 'POST /rfq/[id]/clarifications' },
  { name: 'revise_quote', persona: 'provider', confirm: true, wraps: 'PATCH /rfq/[id]/quote' },
  // S1.6 — the ONE confirm gate of the WhatsApp onboarding interview: the provider's button tap on the
  // draft. Local (no /api/v1 route): the ai_decisions row IS the outcome; the wizard consumes the draft.
  { name: 'confirm_onboarding_draft', persona: 'provider', confirm: true, wraps: 'local (draft confirm)' },
  { name: 'list_deadlines', persona: 'provider', confirm: false, wraps: 'GET /orders (provider)' },
  // S2.2 — Digital Munshi reads the provider's own price book (the only basis a draft price may have); a GET.
  { name: 'read_price_book', persona: 'provider', confirm: false, wraps: 'GET /partner/price-book' },
  // S2.4 — the provider's OWN AMC Score (registered now for Munshi's later use; no agent reads it in v1)
  { name: 'read_own_score', persona: 'provider', confirm: false, wraps: 'GET /partner/score' },
  // S2.3 — the Support agent: the same two tools exist for BOTH personas (the table is per persona; a name may repeat).
  // support_lookup is never routed — the support core calls the lookups interface (session client / token GETs).
  { name: 'support_lookup', persona: 'buyer', confirm: false, wraps: 'GET /orders | /rfq | /quotes/[id]/messages (read-only)' },
  { name: 'support_lookup', persona: 'provider', confirm: false, wraps: 'GET /orders | /rfq | /quotes/[id]/messages (read-only)' },
  { name: 'nudge_counterparty', persona: 'buyer', confirm: true, wraps: 'POST /orders/[id]/nudge | /rfq/[id]/nudge' },
  { name: 'nudge_counterparty', persona: 'provider', confirm: true, wraps: 'POST /orders/[id]/nudge | /rfq/[id]/nudge' },
  // ops — recommendations only; never executes an admin action
  { name: 'summarize_dispute', persona: 'ops', confirm: false, taskClass: 'dispute_summary', wraps: 'GET /admin/disputes/[id]' },
  { name: 'triage_verification', persona: 'ops', confirm: false, wraps: 'GET /admin/providers/[id]' },
  { name: 'recommend_payout_release', persona: 'ops', confirm: false, wraps: 'GET /admin/payouts (read-only)' },
  // S1.4 — the Payout-Evidence agent's ONLY data path: one admin read (RLS +
  // requireAdmin apply under the founder's delegated ops token). Never a POST.
  { name: 'read_order_evidence', persona: 'ops', confirm: false, wraps: 'GET /admin/orders/[id]/evidence' },
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
  // S2.3 — a name may exist for more than one persona (support_lookup, nudge_counterparty): check the pair.
  return AGENT_TOOLS.some((t) => t.name === tool && t.persona === persona)
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
  'injection_suspected', // S2.1 — an untrusted part scored ≥ 40 by the detector (logged, never blocking); payload { provenance, score, hits, prompt }
] as const
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number]
export const agentEventKindSchema = z.enum(AGENT_EVENT_KINDS)

// ── Surfaces and channels ─────────────────────────────────────────────────────
// A SURFACE is where a run was opened (agent_runs.surface); it includes 'system'
// for scheduled/proactive runs with no human at a screen. A CHANNEL is the
// delivery channel a delegation grant is bound to (agent_grants.channel) — the
// user-facing subset, never 'phone'/'system'.

export const AGENT_SURFACES = ['web', 'mobile', 'whatsapp', 'phone', 'system'] as const
export type AgentSurface = (typeof AGENT_SURFACES)[number]
export const agentSurfaceSchema = z.enum(AGENT_SURFACES)

export const AGENT_CHANNELS = ['web', 'mobile', 'whatsapp'] as const
export type AgentChannel = (typeof AGENT_CHANNELS)[number]
export const agentChannelSchema = z.enum(AGENT_CHANNELS)

// ── Delegation grant ──────────────────────────────────────────────────────────
// POST /api/v1/agent/grants body. Scopes are tool names and MUST be a subset of
// the persona's allowlist — the token endpoint mints amc_scopes from the grant,
// so a scope outside the persona could never be honoured anyway; we reject it at
// the source. channel_identity is the E.164 phone for a whatsapp grant.

export const agentGrantSchema = z
  .object({
    persona: agentPersonaSchema,
    scopes: z.array(z.string().min(1).max(60)).max(40).default([]),
    channel: agentChannelSchema,
    channel_identity: z.string().min(1).max(120).optional(),
  })
  .superRefine((d, ctx) => {
    const allowed = new Set(toolsForPersona(d.persona).map((t) => t.name))
    for (const s of d.scopes) {
      if (!allowed.has(s)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['scopes'],
          message: `scope '${s}' is not a ${d.persona} tool`,
        })
      }
    }
  })
export type AgentGrantInput = z.infer<typeof agentGrantSchema>

/** True when `scopes` is a subset of the persona's tool allowlist. */
export function scopesWithinPersona(persona: AgentPersona, scopes: readonly string[]): boolean {
  const allowed = new Set(toolsForPersona(persona).map((t) => t.name))
  return scopes.every((s) => allowed.has(s))
}
