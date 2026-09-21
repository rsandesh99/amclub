import type { z } from 'zod'
import {
  agentTool,
  isToolAllowed,
  tierFor,
  type AgentPersona,
  type AgentTaskClass,
  type AgentToolName,
  type AgentToolSpec,
} from '@amclub/shared'
import type { ChatParts, Gateway } from '../llm/gateway'
import type { Budget, BudgetBreach } from '../budget'
import type { Ledger } from '../ledger/types'
import { usdToPaise } from '../ledger/invocations'
import { assertEnvelope } from '../untrusted/envelope'
import type { PromptRef } from '../prompts/registry'

/**
 * The runner (ARCHITECTURE.md §5). Every runtime agent drives an AgentRun:
 *  - model calls enforce the step + money budgets and taint the run when
 *    untrusted content enters;
 *  - a tool proposal is checked against the persona allowlist and scope;
 *  - a confirm:true tool PARKS the run in awaiting_confirmation until the
 *    surface records an ai_decisions row — resume() verifies it before calling;
 *  - a confirm:false tool may run only if it does not write after tainting;
 *  - tools execute as fetch(/api/v1) under the DELEGATED token, never the
 *    service role, and terminal run states are final.
 */

export class AgentRunError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'AgentRunError'
  }
}
export class BudgetExceededError extends AgentRunError {
  constructor(public breach: BudgetBreach) {
    super(`budget_${breach}`, `budget exceeded: ${breach}`)
  }
}
export class StepBudgetExceededError extends AgentRunError {
  constructor() {
    super('step_budget', 'step budget exceeded')
  }
}
export class ToolNotAllowedError extends AgentRunError {
  constructor(tool: string, persona: AgentPersona) {
    super('tool_not_allowed', `tool '${tool}' is not in the ${persona} allowlist`)
  }
}
export class ToolOutOfScopeError extends AgentRunError {
  constructor(tool: string) {
    super('tool_out_of_scope', `tool '${tool}' is not in the granted scopes`)
  }
}
export class TaintViolationError extends AgentRunError {
  constructor(tool: string) {
    super('taint_violation', `tool '${tool}' would write after untrusted content entered the run`)
  }
}
export class ConfirmationNotApprovedError extends AgentRunError {
  constructor(tool: string) {
    super('confirmation_not_approved', `no approved ai_decisions row for tool '${tool}'`)
  }
}

export interface RunContext {
  runId: string
  userId: string
  persona: AgentPersona
  ledger: Ledger
  gateway: Gateway
  budget: Budget
  apiBaseUrl: string
  getToken: () => Promise<string> | string
  /** From the grant. undefined/null = no scope restriction (an ordinary session). */
  scopes?: readonly string[] | null
  maxSteps?: number
  fetchImpl?: typeof fetch
}

export interface ModelCallOptions<T> {
  taskClass: AgentTaskClass
  prompt: PromptRef
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
  parts?: ChatParts
  temperature?: number
  stub?: () => T
  feature?: string
}

export interface ToolCallResult {
  status: number
  ok: boolean
  body: unknown
}

export type ToolOutcome =
  | { status: 'awaiting_confirmation'; tool: AgentToolName }
  | { status: 'done'; tool: AgentToolName; result: ToolCallResult }

/** A confirm:false tool is read-only/local: its `wraps` is a GET or a pure local computation. */
export function isReadOnlyOrLocal(spec: AgentToolSpec): boolean {
  return spec.wraps.startsWith('GET ') || spec.wraps.startsWith('local')
}

/** Resolve the /api/v1 route a tool wraps. Wired incrementally as stages need it. */
export function resolveToolRoute(
  tool: AgentToolName,
  payload: Record<string, unknown>,
): { method: 'GET' | 'POST'; path: string; body?: Record<string, unknown> } {
  const id = (k: string) => String(payload[k] ?? '')
  switch (tool) {
    case 'search_catalog':
      return { method: 'GET', path: `/api/v1/catalog/search?q=${encodeURIComponent(id('q'))}` }
    case 'track_order':
      return { method: 'GET', path: `/api/v1/orders/${id('order_id')}` }
    case 'create_rfq':
      return { method: 'POST', path: '/api/v1/rfq', body: payload }
    case 'place_order':
      return { method: 'POST', path: '/api/v1/checkout', body: payload }
    // S1.4 — the ops evidence read. The payout RELEASE route is deliberately
    // absent here: no tool wraps it, so the runtime can never call it.
    case 'read_order_evidence':
      return { method: 'GET', path: `/api/v1/admin/orders/${id('order_id')}/evidence` }
    // S1.6 — a LOCAL confirm gate: no /api/v1 route exists; the approved ai_decisions row is the outcome
    // and executeTool short-circuits before any fetch (see the 'local' branch there).
    case 'confirm_onboarding_draft':
      return { method: 'POST', path: 'local:confirm_onboarding_draft', body: payload }
    default:
      throw new AgentRunError('tool_route_unwired', `no /api/v1 route wired for tool '${tool}' yet`)
  }
}

export class AgentRun {
  private tainted = false
  private steps = 0
  private _parked = false
  private readonly maxSteps: number

  constructor(private ctx: RunContext) {
    this.maxSteps = ctx.maxSteps ?? 12
  }

  get runId(): string {
    return this.ctx.runId
  }
  get userId(): string {
    return this.ctx.userId
  }
  get persona(): AgentPersona {
    return this.ctx.persona
  }
  get isTainted(): boolean {
    return this.tainted
  }
  get parked(): boolean {
    return this._parked
  }

  async begin(): Promise<void> {
    await this.ctx.ledger.appendEvent({ runId: this.ctx.runId, kind: 'started', actor: 'system' })
  }

  async callModel<T>(opts: ModelCallOptions<T>): Promise<T> {
    if (this.steps >= this.maxSteps) {
      await this.fail('step_budget')
      throw new StepBudgetExceededError()
    }
    const budget = await this.ctx.budget.check()
    if (!budget.ok) {
      await this.fail(`budget_${budget.breach}`)
      throw new BudgetExceededError(budget.breach as BudgetBreach)
    }
    for (const e of opts.parts?.untrusted ?? []) assertEnvelope(e)
    if ((opts.parts?.untrusted?.length ?? 0) > 0) this.tainted = true

    this.steps += 1
    await this.ctx.ledger.appendEvent({
      runId: this.ctx.runId,
      kind: 'model_call',
      actor: 'agent',
      payload: { taskClass: opts.taskClass, prompt: `${opts.prompt.id}@${opts.prompt.version}`, tainted: this.tainted },
    })

    const res = await this.ctx.gateway.chatJson({
      taskClass: opts.taskClass,
      prompt: opts.prompt,
      schema: opts.schema,
      ...(opts.parts !== undefined ? { parts: opts.parts } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.stub !== undefined ? { stub: opts.stub } : {}),
    })

    const costPaise = res.usage.costUsd != null ? usdToPaise(res.usage.costUsd) ?? 0 : 0
    await this.ctx.ledger.logInvocation({
      runId: this.ctx.runId,
      userId: this.ctx.userId,
      taskClass: opts.taskClass,
      tier: tierFor(opts.taskClass),
      vendor: 'gateway',
      status: res.stub ? 'stub' : 'ok',
      latencyMs: res.latencyMs,
      costEstPaise: costPaise,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      ...(opts.feature !== undefined ? { feature: opts.feature } : {}),
    })
    await this.ctx.budget.add(costPaise)
    await this.ctx.ledger.addRunCost(this.ctx.runId, {
      costPaise,
      inputTokens: res.usage.inputTokens ?? 0,
      outputTokens: res.usage.outputTokens ?? 0,
    })
    return res.data
  }

  /**
   * Propose a tool. confirm:true -> parks in awaiting_confirmation and STOPS.
   * confirm:false -> executes now, unless taint() forbids it.
   */
  async proposeTool(tool: AgentToolName, payload: Record<string, unknown> = {}): Promise<ToolOutcome> {
    if (!isToolAllowed(this.ctx.persona, tool)) throw new ToolNotAllowedError(tool, this.ctx.persona)
    if (this.ctx.scopes && !this.ctx.scopes.includes(tool)) throw new ToolOutOfScopeError(tool)

    const spec = agentTool(tool)
    if (this.tainted && !spec.confirm && !isReadOnlyOrLocal(spec)) {
      throw new TaintViolationError(tool)
    }

    if (spec.confirm) {
      await this.ctx.ledger.appendEvent({ runId: this.ctx.runId, kind: 'tool_proposed', tool, actor: 'agent', payload })
      await this.ctx.ledger.appendEvent({ runId: this.ctx.runId, kind: 'confirmation_requested', tool, actor: 'agent', payload })
      await this.ctx.ledger.transitionRun(this.ctx.runId, 'running', 'awaiting_confirmation')
      this._parked = true
      return { status: 'awaiting_confirmation', tool }
    }

    const result = await this.executeTool(tool, payload)
    return { status: 'done', tool, result }
  }

  /**
   * Resume a parked run after the surface recorded the user's yes. Verifies an
   * approved ai_decisions row bound to (run_id, tool) BEFORE calling the route.
   */
  async resume(tool: AgentToolName, payload: Record<string, unknown> = {}, opts?: { decisionId?: string }): Promise<ToolOutcome> {
    const approved = await this.ctx.ledger.hasApprovedDecision({
      runId: this.ctx.runId,
      tool,
      decisionId: opts?.decisionId ?? null,
    })
    if (!approved) throw new ConfirmationNotApprovedError(tool)
    await this.ctx.ledger.transitionRun(this.ctx.runId, 'awaiting_confirmation', 'running')
    this._parked = false
    await this.ctx.ledger.appendEvent({ runId: this.ctx.runId, kind: 'confirmed', tool, actor: 'user' })
    const result = await this.executeTool(tool, payload)
    return { status: 'done', tool, result }
  }

  private async executeTool(tool: AgentToolName, payload: Record<string, unknown>): Promise<ToolCallResult> {
    // A local tool (wraps 'local …') calls no route: for a confirm:true local tool the
    // verified ai_decisions row IS the effect; the caller reads it back. Never a fetch.
    if (agentTool(tool).wraps.startsWith('local')) {
      await this.ctx.ledger.appendEvent({ runId: this.ctx.runId, kind: 'tool_called', tool, actor: 'agent', payload: { local: true, ok: true } })
      return { status: 200, ok: true, body: null }
    }
    const route = resolveToolRoute(tool, payload)
    const token = await this.ctx.getToken()
    const f = this.ctx.fetchImpl ?? fetch
    const res = await f(`${this.ctx.apiBaseUrl}${route.path}`, {
      method: route.method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(route.method === 'GET' ? {} : { body: JSON.stringify(route.body ?? payload) }),
    })
    const body = await res.json().catch(() => null)
    await this.ctx.ledger.appendEvent({
      runId: this.ctx.runId,
      kind: 'tool_called',
      tool,
      actor: 'agent',
      payload: { status: res.status, ok: res.ok },
    })
    return { status: res.status, ok: res.ok, body }
  }

  async complete(): Promise<void> {
    await this.ctx.ledger.transitionRun(this.ctx.runId, 'running', 'completed')
    await this.ctx.ledger.appendEvent({ runId: this.ctx.runId, kind: 'completed', actor: 'system' })
  }

  /** Move to failed from whatever non-terminal state we are in. Safe to call once. */
  async fail(error: string): Promise<void> {
    const run = await this.ctx.ledger.getRun(this.ctx.runId)
    if (!run) return
    if (run.status !== 'running' && run.status !== 'awaiting_confirmation') return
    try {
      await this.ctx.ledger.transitionRun(this.ctx.runId, run.status, 'failed', { error })
      await this.ctx.ledger.appendEvent({ runId: this.ctx.runId, kind: 'failed', actor: 'system', payload: { error } })
    } catch {
      /* already advanced by another writer — leave it */
    }
  }
}

// ── runAgent: the standard wrapper every runtime agent uses ────────────────────

export interface AgentDefinition<Input, Output> {
  name: string
  persona: AgentPersona
  run(run: AgentRun, input: Input): Promise<Output>
}

export interface RunAgentDeps {
  ledger: Ledger
  gateway: Gateway
  /** S1.6: `agentName` lets the budget apply a per-agent run cap (budget_run_paise_by_agent). */
  makeBudget: (args: { runId: string; userId: string; agentName?: string }) => Budget
  apiBaseUrl: string
  /** Mint the run-bound delegated token (the caller wires the token endpoint). */
  makeToken: (args: { runId: string; persona: AgentPersona; userId: string }) => Promise<string> | string
  scopes?: readonly string[] | null
  maxSteps?: number
  fetchImpl?: typeof fetch
}

export interface OpenRunArgs {
  userId: string
  surface: string
  subjectType?: string | null
  subjectId?: string | null
  parentRunId?: string | null
  jobId?: string | null
  meta?: Record<string, unknown> | null
}

export type RunAgentResult<O> =
  | { runId: string; status: 'completed'; output: O }
  | { runId: string; status: 'awaiting_confirmation'; output: O }
  | { runId: string; status: 'failed'; error: string }

export async function runAgent<I, O>(
  def: AgentDefinition<I, O>,
  deps: RunAgentDeps,
  open: OpenRunArgs,
  input: I,
): Promise<RunAgentResult<O>> {
  const { id: runId } = await deps.ledger.openRun({ persona: def.persona, ...open })
  const ctx: RunContext = {
    runId,
    userId: open.userId,
    persona: def.persona,
    ledger: deps.ledger,
    gateway: deps.gateway,
    budget: deps.makeBudget({ runId, userId: open.userId, agentName: def.name }),
    apiBaseUrl: deps.apiBaseUrl,
    getToken: () => deps.makeToken({ runId, persona: def.persona, userId: open.userId }),
    scopes: deps.scopes ?? null,
    ...(deps.maxSteps !== undefined ? { maxSteps: deps.maxSteps } : {}),
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  }
  const run = new AgentRun(ctx)
  await run.begin()
  try {
    const output = await def.run(run, input)
    if (run.parked) return { runId, status: 'awaiting_confirmation', output }
    await run.complete()
    return { runId, status: 'completed', output }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await run.fail(message)
    return { runId, status: 'failed', error: message }
  }
}
