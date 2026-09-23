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
import { GatewayError, GatewayValidationError, type ChatParts, type ChatResult, type Gateway } from '../llm/gateway'
import type { Budget, BudgetBreach } from '../budget'
import type { Ledger } from '../ledger/types'
import { costPaiseFor } from '../ledger/invocations'
import { assertEnvelope, type Provenance } from '../untrusted/envelope'
import { INJECTION_SUSPECT_THRESHOLD } from '../untrusted/injection'
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
  /** Output cap override (else prompt front-matter, else the tier default). */
  maxTokens?: number
}

/**
 * S2.1 / Track F — the coarse band a user may see for a suspected envelope. The
 * score and detector hits are NEVER written to agent_events (users can read their
 * own events, so the rule set would leak); they go to server logs only.
 */
export function injectionBand(score: number): 'low' | 'med' | 'high' {
  if (score >= 80) return 'high'
  if (score >= 60) return 'med'
  return 'low'
}

export interface ToolCallResult {
  status: number
  ok: boolean
  body: unknown
}

export type ToolOutcome =
  | { status: 'awaiting_confirmation'; tool: AgentToolName }
  | { status: 'done'; tool: AgentToolName; result: ToolCallResult }

/** S3.1 — routes a scripted call may never reach, whatever the tool (money moves only through the buyer's own tap). */
export const SCRIPTED_CALL_FORBIDDEN: readonly RegExp[] = [
  /^\/api\/v1\/checkout(?:[/?]|$)/,
  /^\/api\/v1\/payments?(?:[/?]|$)/,
  /\/payouts?(?:[/?]|$)/,
  /\/refunds?(?:[/?]|$)/,
  /^\/api\/v1\/orders\/[^/]+\/transition(?:[/?]|$)/,
  /^\/api\/v1\/admin\//,
]

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
    // S1.7 — the Dispute-Triage agent's second read (statements, thread, documents, refund, payout).
    // The dispute RESOLVE route is deliberately absent: no tool wraps it, and it refuses delegated tokens.
    case 'summarize_dispute':
      return { method: 'GET', path: `/api/v1/admin/disputes/${id('dispute_id')}` }
    // S1.6 — a LOCAL confirm gate: no /api/v1 route exists; the approved ai_decisions row is the outcome
    // and executeTool short-circuits before any fetch (see the 'local' branch there).
    case 'confirm_onboarding_draft':
      return { method: 'POST', path: 'local:confirm_onboarding_draft', body: payload }
    // S2.2 — Digital Munshi (provider persona). Reads: the matched list / one RFQ (with clarifications, myQuote,
    // canQuote), the provider's own price book, the provider's orders. Writes: the THREE ordinary provider routes,
    // each confirm:true (the run parks; the surface's ai_decisions row resumes it). The body is the payload minus
    // the path id; `munshi_draft_id` rides along so the quote route links the draft.
    case 'extract_requirements':
      return payload['rfq_id'] ? { method: 'GET', path: `/api/v1/rfq/${id('rfq_id')}` } : { method: 'GET', path: '/api/v1/rfq/matched' }
    case 'read_price_book':
      return { method: 'GET', path: '/api/v1/partner/price-book' }
    case 'read_own_score':
      return { method: 'GET', path: '/api/v1/partner/score' }
    case 'list_deadlines':
      return { method: 'GET', path: '/api/v1/orders?role=provider' }
    case 'submit_quote': {
      const { rfq_id: _r, ...body } = payload
      void _r
      return { method: 'POST', path: `/api/v1/rfq/${id('rfq_id')}/quote`, body }
    }
    case 'ask_clarification': {
      const { rfq_id: _r, ...body } = payload
      void _r
      return { method: 'POST', path: `/api/v1/rfq/${id('rfq_id')}/clarifications`, body }
    }
    case 'reply_thread': {
      const { quote_id: _q, ...body } = payload
      void _q
      return { method: 'POST', path: `/api/v1/quotes/${id('quote_id')}/messages`, body }
    }
    // S2.3 — the ONE Support write: a fixed-template nudge through the spine route for the subject kind.
    // support_lookup is never routed: the support core calls the lookups interface (session client / token GETs).
    case 'nudge_counterparty': {
      const { subject_kind, subject_id, ...body } = payload
      const kind = subject_kind === 'rfq' ? 'rfq' : 'orders'
      return { method: 'POST', path: `/api/v1/${kind}/${String(subject_id ?? '')}/nudge`, body: { ...body, via: typeof body['via'] === 'string' ? body['via'] : 'whatsapp' } }
    }
    // S3.1 — the procurement agent (buyer persona). Reads: the compare results + order. Writes: the ORDINARY buyer
    // routes, each confirm:true (the run parks; the buyer's button / web tap resumes it). The path ids are stripped
    // from the body; `label` / `price_paise` ride only on the proposal for the card, never to a route.
    case 'compare_quotes':
      return { method: 'GET', path: `/api/v1/rfq/${id('rfq_id')}/compare` }
    case 'decline_quote': {
      const { rfq_id: _r, quote_id: _q, label: _l, ...body } = payload
      void _r
      void _q
      void _l
      return { method: 'POST', path: `/api/v1/rfq/${id('rfq_id')}/quote/${id('quote_id')}/decline`, body }
    }
    case 'answer_clarification': {
      const { rfq_id: _r, clarification_id: _c, ...body } = payload
      void _r
      void _c
      return { method: 'POST', path: `/api/v1/rfq/${id('rfq_id')}/clarifications/${id('clarification_id')}/answer`, body }
    }
    case 'complete_rfq': {
      const { rfq_id: _r, mode, ...body } = payload
      void _r
      return mode === 'send'
        ? { method: 'POST', path: `/api/v1/rfq/${id('rfq_id')}/quality/send`, body: {} }
        : { method: 'POST', path: `/api/v1/rfq/${id('rfq_id')}/quality/answer`, body }
    }
    case 'message_provider': {
      const { quote_id: _q, label: _l, ...body } = payload
      void _q
      void _l
      return { method: 'POST', path: `/api/v1/quotes/${id('quote_id')}/messages`, body }
    }
    // S3.1 — "go with B": a LOCAL confirm gate (no route). The approved ai_decisions row IS the outcome; the runtime
    // sends the decision-bound link to the ordinary pay page. executeTool short-circuits before any fetch.
    case 'choose_quote':
      return { method: 'POST', path: 'local:choose_quote', body: payload }
    default:
      throw new AgentRunError('tool_route_unwired', `no /api/v1 route wired for tool '${tool}' yet`)
  }
}

export class AgentRun {
  private tainted = false
  /** S2.1 — every untrusted provenance seen since the run started (deduped, capped 20): the `tainted_by` of later proposals. */
  private readonly taintedBy: Provenance[] = []
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
    // S2.1 — provenance of every untrusted part (deduped, capped) + one injection_suspected event per
    // suspected envelope (≤ 5 per call). Detect and log: nothing is thrown, nothing is dropped.
    let suspected = 0
    for (const e of opts.parts?.untrusted ?? []) {
      const key = `${e.provenance.kind}:${e.provenance.id}`
      if (this.taintedBy.length < 20 && !this.taintedBy.some((p) => `${p.kind}:${p.id}` === key)) this.taintedBy.push({ ...e.provenance })
      if (e.injection.score >= INJECTION_SUSPECT_THRESHOLD && suspected < 5) {
        suspected += 1
        const promptKey = `${opts.prompt.id}@${opts.prompt.version}`
        // Full detector detail → server log only.
        console.warn('[runner] injection_suspected', { runId: this.ctx.runId, provenance: e.provenance, score: e.injection.score, hits: e.injection.hits, prompt: promptKey })
        try {
          await this.ctx.ledger.appendEvent({
            runId: this.ctx.runId,
            kind: 'injection_suspected',
            actor: 'system',
            payload: { suspected: true, band: injectionBand(e.injection.score), source: e.provenance.kind, prompt: promptKey },
          })
        } catch (err) {
          console.error('[runner] injection_suspected event failed', (err as Error).message)
        }
      }
    }

    this.steps += 1
    await this.ctx.ledger.appendEvent({
      runId: this.ctx.runId,
      kind: 'model_call',
      actor: 'agent',
      payload: { taskClass: opts.taskClass, prompt: `${opts.prompt.id}@${opts.prompt.version}`, tainted: this.tainted },
    })

    const started = Date.now()
    let res: ChatResult<T>
    try {
      res = await this.ctx.gateway.chatJson({
        taskClass: opts.taskClass,
        prompt: opts.prompt,
        schema: opts.schema,
        ...(opts.parts !== undefined ? { parts: opts.parts } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.stub !== undefined ? { stub: opts.stub } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      })
    } catch (e) {
      await this.recordFailedCall(opts, e, Date.now() - started)
      throw e
    }

    const { paise: costPaise, source: costSource } = costPaiseFor({
      stub: res.stub,
      costUsd: res.usage.costUsd,
      model: res.model,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
    })
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
      meta: { model: res.model, cost_source: costSource },
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
   * A failed model call still leaves a ledger row. A billed-but-invalid response
   * (GatewayValidationError) is charged to the budget and the run; a transport /
   * residency failure is logged with no cost (nothing was billed). Never throws.
   */
  private async recordFailedCall<T>(opts: ModelCallOptions<T>, e: unknown, latencyMs: number): Promise<void> {
    try {
      const billed = e instanceof GatewayValidationError
      const cost = billed
        ? costPaiseFor({ stub: false, costUsd: e.usage.costUsd, model: e.model, inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens })
        : null
      await this.ctx.ledger.logInvocation({
        runId: this.ctx.runId,
        userId: this.ctx.userId,
        taskClass: opts.taskClass,
        tier: tierFor(opts.taskClass),
        vendor: 'gateway',
        status: 'error',
        latencyMs: billed ? e.latencyMs : latencyMs,
        costEstPaise: cost ? cost.paise : null,
        inputTokens: billed ? e.usage.inputTokens : null,
        outputTokens: billed ? e.usage.outputTokens : null,
        ...(opts.feature !== undefined ? { feature: opts.feature } : {}),
        meta: {
          error: (e as Error)?.message?.slice(0, 300) ?? String(e),
          ...(e instanceof GatewayError ? { error_code: e.code } : {}),
          ...(billed ? { reason: e.reason, model: e.model, cost_source: cost?.source } : {}),
        },
      })
      if (billed && cost) {
        await this.ctx.budget.add(cost.paise)
        await this.ctx.ledger.addRunCost(this.ctx.runId, {
          costPaise: cost.paise,
          inputTokens: e.usage.inputTokens ?? 0,
          outputTokens: e.usage.outputTokens ?? 0,
        })
      }
    } catch (err) {
      console.error('[runner] failed-call accounting failed', (err as Error).message)
    }
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
      // S2.1 — a proposal that follows tainted input names the provenances it followed.
      const proposedPayload = this.tainted ? { ...payload, tainted_by: this.taintedBy.map((p) => ({ ...p })) } : payload
      await this.ctx.ledger.appendEvent({ runId: this.ctx.runId, kind: 'tool_proposed', tool, actor: 'agent', payload: proposedPayload })
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
    if (!isToolAllowed(this.ctx.persona, tool)) throw new ToolNotAllowedError(tool, this.ctx.persona)
    // S2.2 — the grant may have narrowed between the proposal and the tap: the resume re-checks the scopes the
    // caller minted from the CURRENT grant, so a tool no longer granted never reaches its route (the route's own
    // requireToolScope is the second lock).
    if (this.ctx.scopes && !this.ctx.scopes.includes(tool)) throw new ToolOutOfScopeError(tool)
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

  /**
   * S3.1 — a SCRIPTED call the agent's own code makes (never a model-proposed tool): a GET under the delegated token,
   * or a POST to a prefill route that writes nothing the user did not ask for (the S1.8 parse / STT / document intake).
   * Recorded as a `tool_called` event like any tool. Restricted by code, not by the prompt:
   *  - the tool must be the persona's and inside the grant's scopes;
   *  - it must be confirm:false AND read-only / local (a confirm:true tool runs ONLY through proposeTool → park → resume);
   *  - the path must be an /api/v1 route and never a money route (checkout, payments, payouts, refunds, order transitions).
   */
  async scriptedCall(tool: AgentToolName, req: { method: 'GET' | 'POST'; path: string; json?: unknown; form?: FormData }): Promise<ToolCallResult> {
    if (!isToolAllowed(this.ctx.persona, tool)) throw new ToolNotAllowedError(tool, this.ctx.persona)
    if (this.ctx.scopes && !this.ctx.scopes.includes(tool)) throw new ToolOutOfScopeError(tool)
    const spec = agentTool(tool)
    if (spec.confirm || !isReadOnlyOrLocal(spec)) throw new AgentRunError('scripted_write_refused', `tool '${tool}' may only run through proposeTool`)
    if (!req.path.startsWith('/api/v1/') || SCRIPTED_CALL_FORBIDDEN.some((re) => re.test(req.path))) {
      throw new AgentRunError('scripted_path_refused', `scripted call refused for ${req.method} ${req.path}`)
    }
    const token = await this.ctx.getToken()
    const f = this.ctx.fetchImpl ?? fetch
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
    let body: FormData | string | undefined
    if (req.method === 'POST') {
      if (req.form) body = req.form
      else {
        headers['Content-Type'] = 'application/json'
        body = JSON.stringify(req.json ?? {})
      }
    }
    const res = await f(`${this.ctx.apiBaseUrl}${req.path}`, { method: req.method, headers, ...(body !== undefined ? { body } : {}) })
    const parsed = await res.json().catch(() => null)
    await this.ctx.ledger.appendEvent({ runId: this.ctx.runId, kind: 'tool_called', tool, actor: 'agent', payload: { scripted: true, method: req.method, path: req.path.split('?')[0], status: res.status, ok: res.ok } })
    return { status: res.status, ok: res.ok, body: parsed }
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
    // An AgentRunError reports its CODE (budget_run_cap, step_budget, tool_out_of_scope, …) so workers' no-retry
    // rules match what agent_runs.error already holds; anything else reports its message.
    const message = e instanceof AgentRunError || e instanceof GatewayError ? e.code : e instanceof Error ? e.message : String(e)
    await run.fail(message)
    return { runId, status: 'failed', error: message }
  }
}
