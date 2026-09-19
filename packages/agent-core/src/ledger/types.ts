import type {
  AgentEventKind,
  AgentPersona,
  AgentRunStatus,
  AgentTaskClass,
  AgentTier,
  AiDecisionFeature,
} from '@amclub/shared'

/**
 * The Ledger is the ONLY writer of agent_runs / agent_events / ai_invocations /
 * ai_decisions. The runner depends on this interface, so it is fully testable
 * with an in-memory fake; the Supabase-backed implementation (service role)
 * lives in ./supabase.ts. Never a second money/status path (RULES.md 5): the
 * runner mutates orders/RFQs only by calling /api/v1 under the delegated token.
 */

export interface OpenRunInput {
  userId: string
  persona: AgentPersona
  surface: string
  subjectType?: string | null
  subjectId?: string | null
  parentRunId?: string | null
  jobId?: string | null
  meta?: Record<string, unknown> | null
}

export interface RunRow {
  id: string
  userId: string
  persona: AgentPersona
  status: AgentRunStatus
  surface: string
  costEstPaise: number
  inputTokens: number
  outputTokens: number
}

export interface AgentEventInput {
  runId: string
  kind: AgentEventKind
  tool?: string | null
  actor?: 'agent' | 'user' | 'system'
  payload?: Record<string, unknown> | null
}

export interface InvocationInput {
  runId: string | null
  userId: string
  taskClass: AgentTaskClass
  tier: AgentTier
  vendor: string
  status: 'ok' | 'error' | 'stub'
  latencyMs: number
  costEstPaise: number | null
  inputTokens: number | null
  outputTokens: number | null
  feature?: string
  meta?: Record<string, unknown> | null
}

export interface DecisionInput {
  feature: AiDecisionFeature
  runId?: string | null
  tool?: string | null
  inputRefs: Record<string, unknown>
  proposed: Record<string, unknown>
  final: Record<string, unknown>
  decidedBy: string
}

export interface ApprovedDecisionQuery {
  runId: string
  tool: string
  /** Optional: require this specific ai_decisions row id. */
  decisionId?: string | null
}

export interface Ledger {
  openRun(input: OpenRunInput): Promise<{ id: string }>
  getRun(runId: string): Promise<RunRow | null>
  /**
   * Guarded, replay-safe transition: validates against AGENT_RUN_TRANSITIONS and
   * updates only WHERE status = `from`. Throws on an illegal or lost transition
   * (terminal states have no exits, so they are final).
   */
  transitionRun(runId: string, from: AgentRunStatus, to: AgentRunStatus, patch?: { error?: string | null }): Promise<void>
  addRunCost(runId: string, cost: { costPaise: number; inputTokens: number; outputTokens: number }): Promise<void>
  appendEvent(input: AgentEventInput): Promise<void>
  logInvocation(input: InvocationInput): Promise<void>
  recordDecision(input: DecisionInput): Promise<{ id: string }>
  hasApprovedDecision(q: ApprovedDecisionQuery): Promise<boolean>
}
