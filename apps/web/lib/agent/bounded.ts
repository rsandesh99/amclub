import 'server-only'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { AgentTaskClass } from '@amclub/shared'
import {
  createGateway,
  createNoopBudget,
  createRedisBudget,
  createSupabaseLedger,
  getPrompt,
  loadDefaultPrompts,
  resolveCaps,
  runBoundedChatJson,
  type ChatParts,
  type BoundedChatResult,
} from '@amclub/agent-core'
import { getAgentSetting } from '@/lib/agent/settings'
import { getRedis } from '@/lib/rate-limit'

/**
 * Bounded single-shot model call on Vercel (ADR-009 §2; S1.1 §3) — the pattern
 * every later single-shot stage reuses. Prompt from the registry, gateway from
 * env (stub mode without a key), the three budget caps from agent_settings on
 * the shared Upstash client (no-op without Upstash), one ai_invocations row per
 * call (ok / stub / error) with run_id null. Throws BudgetExceededError before
 * the gateway is touched; the route maps it to 429. Telemetry never throws.
 */

export { BudgetExceededError } from '@amclub/agent-core'

let promptsLoaded = false
function ensurePrompts(): void {
  if (promptsLoaded) return
  loadDefaultPrompts()
  promptsLoaded = true
}

export interface BoundedCallArgs<T> {
  userId: string
  feature: string
  taskClass: AgentTaskClass
  promptId: string
  promptVersion: string
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
  parts?: ChatParts
  temperature?: number
  stub?: () => T
  meta?: Record<string, unknown> | null
  /** S1.8 — explicit model id for this call (VOICE_PARSE_MODEL precedence for the voice parser). */
  model?: string
}

export async function boundedChatJson<T>(admin: SupabaseClient, args: BoundedCallArgs<T>): Promise<BoundedChatResult<T>> {
  ensurePrompts()
  const prompt = getPrompt(args.promptId, args.promptVersion)
  const [run, day, month] = await Promise.all([
    getAgentSetting(admin, 'budget_run_paise'),
    getAgentSetting(admin, 'budget_user_day_paise'),
    getAgentSetting(admin, 'budget_month_paise'),
  ])
  const caps = resolveCaps({ budget_run_paise: run, budget_user_day_paise: day, budget_month_paise: month })
  const redis = getRedis()
  // A bounded call is its own "run" for the per-run cap; user-day and month
  // counters are shared with every other agent call for this user.
  const budget = redis ? createRedisBudget({ redis, caps, runId: `bounded:${randomUUID()}`, userId: args.userId }) : createNoopBudget()
  return runBoundedChatJson(
    { gateway: createGateway(), ledger: createSupabaseLedger(admin), budget },
    {
      userId: args.userId,
      feature: args.feature,
      taskClass: args.taskClass,
      prompt,
      schema: args.schema,
      ...(args.parts !== undefined ? { parts: args.parts } : {}),
      temperature: args.temperature ?? 0,
      ...(args.stub !== undefined ? { stub: args.stub } : {}),
      ...(args.meta !== undefined ? { meta: args.meta } : {}),
      ...(args.model ? { model: args.model } : {}),
    },
  )
}
