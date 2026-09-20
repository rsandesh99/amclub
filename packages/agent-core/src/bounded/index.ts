import type { z } from 'zod'
import { tierFor, type AgentTaskClass } from '@amclub/shared'
import type { ChatParts, Gateway } from '../llm/gateway'
import type { Budget } from '../budget'
import type { Ledger } from '../ledger/types'
import { usdToPaise } from '../ledger/invocations'
import type { PromptRef } from '../prompts/registry'
import { BudgetExceededError } from '../runner'
import type { BudgetBreach } from '../budget'

/**
 * Bounded single-shot model call (ADR-009 §2; S1.1 §3). The Vercel-side
 * pattern every later single-shot stage reuses: one prompt from the registry,
 * one gateway call with `run_id = null`, the three budget caps checked BEFORE
 * the call, and exactly one `ai_invocations` row per call — ok, stub or error.
 * Telemetry never throws to the caller; a budget breach throws
 * BudgetExceededError before the gateway is touched. No runner, no delegated
 * token, no tool — the caller's route does its own authz and its own write.
 */

export interface BoundedChatArgs<T> {
  userId: string
  /** ai_invocations.feature, e.g. 'quote_extraction'. */
  feature: string
  taskClass: AgentTaskClass
  prompt: PromptRef
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
  parts?: ChatParts
  temperature?: number
  stub?: () => T
  meta?: Record<string, unknown> | null
}

export interface BoundedChatDeps {
  gateway: Gateway
  ledger: Ledger
  budget: Budget
}

export interface BoundedChatResult<T> {
  data: T
  stub: boolean
  model: string
  latencyMs: number
  costPaise: number | null
  invocationMeta: Record<string, unknown>
}

export async function runBoundedChatJson<T>(deps: BoundedChatDeps, args: BoundedChatArgs<T>): Promise<BoundedChatResult<T>> {
  const status = await deps.budget.check()
  if (!status.ok) throw new BudgetExceededError(status.breach as BudgetBreach)

  const tier = tierFor(args.taskClass)
  const started = Date.now()
  try {
    const res = await deps.gateway.chatJson({
      taskClass: args.taskClass,
      prompt: args.prompt,
      schema: args.schema,
      ...(args.parts !== undefined ? { parts: args.parts } : {}),
      temperature: args.temperature ?? 0,
      ...(args.stub !== undefined ? { stub: args.stub } : {}),
    })
    const costPaise = res.usage.costUsd != null ? usdToPaise(res.usage.costUsd) : null
    const invocationMeta = { model: res.model, prompt: `${args.prompt.id}@${args.prompt.version}`, usage: res.usage.raw, ...(args.meta ?? {}) }
    await safeLog(deps.ledger, {
      runId: null,
      userId: args.userId,
      taskClass: args.taskClass,
      tier,
      vendor: res.stub ? 'stub' : `gateway:${res.model}`,
      status: res.stub ? 'stub' : 'ok',
      latencyMs: res.latencyMs,
      costEstPaise: costPaise,
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      feature: args.feature,
      meta: invocationMeta,
    })
    if (costPaise != null && costPaise > 0) await deps.budget.add(costPaise).catch(() => undefined)
    return { data: res.data, stub: res.stub, model: res.model, latencyMs: res.latencyMs, costPaise, invocationMeta }
  } catch (e) {
    if (e instanceof BudgetExceededError) throw e
    await safeLog(deps.ledger, {
      runId: null,
      userId: args.userId,
      taskClass: args.taskClass,
      tier,
      vendor: 'gateway',
      status: 'error',
      latencyMs: Date.now() - started,
      costEstPaise: null,
      inputTokens: null,
      outputTokens: null,
      feature: args.feature,
      meta: { error: (e as Error).message, prompt: `${args.prompt.id}@${args.prompt.version}`, ...(args.meta ?? {}) },
    })
    throw e
  }
}

async function safeLog(ledger: Ledger, input: Parameters<Ledger['logInvocation']>[0]): Promise<void> {
  try {
    await ledger.logInvocation(input)
  } catch (e) {
    console.error('[bounded] logInvocation failed', (e as Error).message)
  }
}
