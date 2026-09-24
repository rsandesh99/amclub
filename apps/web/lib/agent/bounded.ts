import 'server-only'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { z } from 'zod'
import type { AgentTaskClass } from '@amclub/shared'
import {
  budgetWithoutStore,
  createGateway,
  createRedisBudget,
  createSupabaseLedger,
  getPrompt,
  loadDefaultPrompts,
  resolveCaps,
  runBoundedChatJson,
  BudgetExceededError,
  type Budget,
  type BudgetAudience,
  type ChatParts,
  type BoundedChatResult,
  type PromptRef,
} from '@amclub/agent-core'
import { getAgentSetting } from '@/lib/agent/settings'
import { getRedis } from '@/lib/rate-limit'

/**
 * Bounded single-shot model call on Vercel (ADR-009 §2; S1.1 §3) — the pattern
 * every later single-shot stage reuses. Prompt from the registry, gateway from
 * env (stub mode without a key), the budget caps from agent_settings on the
 * shared Upstash client (dev no-op without Upstash; FAIL CLOSED in production
 * with AGENT_ENABLED=true — BudgetExceededError breach 'store_unavailable'), one ai_invocations row per
 * call (ok / stub / error) with run_id null. Throws BudgetExceededError before
 * the gateway is touched; the route maps it to 429. Telemetry never throws.
 *
 * Audit M24: EVERY paid AI call on Vercel goes through here (or `boundedBudget`
 * for a non-LLM vendor call such as speech-to-text), so nothing bypasses the
 * ledger and the caps. A user outside `cohort_user_ids` spends from the OPEN
 * envelope (`budget_month_open_paise`, its own month counter) as well as the
 * month cap, so outside traffic can never drain the budget the cohort and ops
 * run on. Admin-only callers pass `audience: 'ops'`.
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
  /** A registry prompt … */
  promptId?: string
  promptVersion?: string
  /** … or an in-code PromptRef built per call (a live vocabulary in the system text — the Mart catalog / pool pitch). */
  prompt?: PromptRef
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
  parts?: ChatParts
  temperature?: number
  stub?: () => T
  meta?: Record<string, unknown> | null
  /** S1.8 — explicit model id for this call (VOICE_PARSE_MODEL precedence for the voice parser). */
  model?: string
  /** Output cap override (else prompt front-matter, else the tier default). */
  maxTokens?: number
  /** Audit M24 — who the spend is for: 'auto' (default) = the open envelope unless the user is in the cohort; 'ops' = an admin tool. */
  audience?: 'auto' | 'ops'
}

/** Cohort members and ops spend from the month cap; everyone else also from the open envelope (audit M24). */
async function audienceFor(admin: SupabaseClient, userId: string, audience: 'auto' | 'ops' | undefined): Promise<BudgetAudience> {
  if (audience === 'ops') return 'ops'
  const cohort = await getAgentSetting(admin, 'cohort_user_ids')
  return Array.isArray(cohort) && (cohort as string[]).includes(userId) ? 'cohort' : 'open'
}

/**
 * The budget one bounded call (or one vendor call outside the LLM gateway, e.g.
 * speech-to-text) spends from: the three caps + the open envelope for a user
 * outside the cohort. A bounded call is its own "run" for the per-run cap; the
 * user-day and month counters are shared with every other agent call.
 */
export async function boundedBudget(admin: SupabaseClient, userId: string, opts: { audience?: 'auto' | 'ops' } = {}): Promise<{ budget: Budget; audience: BudgetAudience }> {
  const [run, day, month, monthOpen, audience] = await Promise.all([
    getAgentSetting(admin, 'budget_run_paise'),
    getAgentSetting(admin, 'budget_user_day_paise'),
    getAgentSetting(admin, 'budget_month_paise'),
    getAgentSetting(admin, 'budget_month_open_paise'),
    audienceFor(admin, userId, opts.audience),
  ])
  const caps = resolveCaps({ budget_run_paise: run, budget_user_day_paise: day, budget_month_paise: month, budget_month_open_paise: monthOpen })
  const redis = getRedis()
  const budget = redis ? createRedisBudget({ redis, caps, runId: `bounded:${randomUUID()}`, userId, audience }) : budgetWithoutStore()
  return { budget, audience }
}

/** Check the budget before a non-LLM vendor call; throws BudgetExceededError (the route answers quota). */
export async function assertBudget(budget: Budget): Promise<void> {
  const status = await budget.check()
  if (!status.ok) throw new BudgetExceededError(status.breach ?? 'month_cap')
}

export async function boundedChatJson<T>(admin: SupabaseClient, args: BoundedCallArgs<T>): Promise<BoundedChatResult<T>> {
  ensurePrompts()
  const prompt = args.prompt ?? getPrompt(args.promptId ?? '', args.promptVersion ?? '')
  const { budget, audience } = await boundedBudget(admin, args.userId, { ...(args.audience ? { audience: args.audience } : {}) })
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
      meta: { ...(args.meta ?? {}), budget_audience: audience },
      ...(args.model ? { model: args.model } : {}),
      ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
    },
  )
}
