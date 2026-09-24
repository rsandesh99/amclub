import { agentSettingDefault } from '@amclub/shared'

/**
 * Budget & cost governance (ARCHITECTURE.md §9). Three counters — per run, per
 * user-day, per month — checked BEFORE each model call and incremented AFTER it
 * with a TTL. A breach fails the run cleanly. Caps come from agent_settings
 * (loaded once per run) with env fallback. When no Redis is configured the
 * budget is a no-op that allows (dev only). In production with AGENT_ENABLED=true
 * and no Upstash the budget FAILS CLOSED (breach 'store_unavailable'): an agent
 * call is refused rather than allowed unlimited spend (budgetWithoutStore()).
 */

export interface BudgetCaps {
  runPaise: number
  userDayPaise: number
  monthPaise: number
  /**
   * Audit M24 — the share of the month that OPEN traffic (users outside the cohort, on the ungated paid endpoints:
   * the voice parser, speech-to-text, Mart catalog drafts) may spend, on its own month counter. The rest of
   * `monthPaise` stays for the cohort and ops, so outside traffic can no longer drain every AI feature.
   */
  monthOpenPaise?: number
}

/** 'store_unavailable' = production agent call with no budget store (fail closed). 'month_open_cap' = the open envelope is spent. */
export type BudgetBreach = 'run_cap' | 'user_day_cap' | 'month_cap' | 'month_open_cap' | 'store_unavailable'

/** Who a call spends for (audit M24): `open` = outside the cohort → also the open envelope; `cohort` / `ops` = the month cap only. */
export type BudgetAudience = 'open' | 'cohort' | 'ops'

export interface BudgetStatus {
  ok: boolean
  breach?: BudgetBreach
  spent: { run: number; userDay: number; month: number; monthOpen?: number }
}

export interface Budget {
  /** Are we already at/over any cap? Called before every model call. */
  check(): Promise<BudgetStatus>
  /** Record actual spend (paise) on all three counters. Called after a call. */
  add(paise: number): Promise<void>
}

/** Minimal Upstash Redis surface (keeps the module testable + loosely coupled). */
export interface RedisLike {
  incrby(key: string, value: number): Promise<number>
  expire(key: string, seconds: number): Promise<unknown>
  mget<T = unknown>(...keys: string[]): Promise<(T | null)[]>
}

/**
 * Caps from agent_settings values (or the registry defaults) with env override.
 * S1.6: `agentName` selects a per-agent run cap from `budget_run_paise_by_agent`
 * (an absent agent = the global `budget_run_paise`; the env override still wins).
 */
export function resolveCaps(settings?: Partial<Record<string, unknown>>, agentName?: string): BudgetCaps {
  const num = (v: unknown, fallback: number) => {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  const dRun = agentSettingDefault('budget_run_paise') as number
  const dDay = agentSettingDefault('budget_user_day_paise') as number
  const dMonth = agentSettingDefault('budget_month_paise') as number
  const byAgent = settings?.['budget_run_paise_by_agent']
  const override = agentName && byAgent && typeof byAgent === 'object' ? (byAgent as Record<string, unknown>)[agentName] : undefined
  const runSetting = override !== undefined && override !== null ? override : settings?.['budget_run_paise']
  const dOpen = agentSettingDefault('budget_month_open_paise') as number
  const monthPaise = num(process.env['AGENT_BUDGET_MONTH_PAISE'] ?? settings?.['budget_month_paise'], dMonth)
  return {
    runPaise: num(process.env['AGENT_BUDGET_RUN_PAISE'] ?? runSetting, dRun),
    userDayPaise: num(process.env['AGENT_BUDGET_USER_DAY_PAISE'] ?? settings?.['budget_user_day_paise'], dDay),
    monthPaise,
    // never above the month cap itself
    monthOpenPaise: Math.min(monthPaise, num(process.env['AGENT_BUDGET_MONTH_OPEN_PAISE'] ?? settings?.['budget_month_open_paise'], dOpen)),
  }
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10) // YYYY-MM-DD (UTC)
}
function ym(d: Date): string {
  return d.toISOString().slice(0, 7) // YYYY-MM (UTC)
}

export interface RedisBudgetOptions {
  redis: RedisLike
  /** Fixed caps, or a loader resolved once on the first check (S1.6: caps read from agent_settings per run). */
  caps: BudgetCaps | (() => Promise<BudgetCaps>)
  runId: string
  userId: string
  now?: () => Date
  keyPrefix?: string
  /** Audit M24 — `open` also checks + increments the open month envelope (default `cohort`: unchanged). */
  audience?: BudgetAudience
}

const DAY_SECONDS = 86_400

export function createRedisBudget(opts: RedisBudgetOptions): Budget {
  const now = opts.now ?? (() => new Date())
  const prefix = opts.keyPrefix ?? 'agent:bud'
  let capsPromise: Promise<BudgetCaps> | null = null
  const caps = (): Promise<BudgetCaps> => {
    if (!capsPromise) capsPromise = typeof opts.caps === 'function' ? opts.caps() : Promise.resolve(opts.caps)
    return capsPromise
  }
  const open = opts.audience === 'open'
  const keys = () => {
    const d = now()
    return {
      run: `${prefix}:run:${opts.runId}`,
      userDay: `${prefix}:uday:${opts.userId}:${ymd(d)}`,
      month: `${prefix}:month:${ym(d)}`,
      monthOpen: `${prefix}:month_open:${ym(d)}`,
    }
  }
  return {
    async check(): Promise<BudgetStatus> {
      const k = keys()
      const [run, userDay, month, monthOpen] = await opts.redis.mget<number>(k.run, k.userDay, k.month, ...(open ? [k.monthOpen] : []))
      const spent = { run: Number(run ?? 0), userDay: Number(userDay ?? 0), month: Number(month ?? 0), ...(open ? { monthOpen: Number(monthOpen ?? 0) } : {}) }
      const c = await caps()
      if (spent.run >= c.runPaise) return { ok: false, breach: 'run_cap', spent }
      if (spent.userDay >= c.userDayPaise) return { ok: false, breach: 'user_day_cap', spent }
      if (spent.month >= c.monthPaise) return { ok: false, breach: 'month_cap', spent }
      if (open && c.monthOpenPaise !== undefined && (spent.monthOpen ?? 0) >= c.monthOpenPaise) return { ok: false, breach: 'month_open_cap', spent }
      return { ok: true, spent }
    },
    async add(paise: number): Promise<void> {
      const amount = Math.max(0, Math.round(paise))
      if (amount === 0) return
      const k = keys()
      await opts.redis.incrby(k.run, amount)
      await opts.redis.expire(k.run, DAY_SECONDS)
      await opts.redis.incrby(k.userDay, amount)
      await opts.redis.expire(k.userDay, DAY_SECONDS * 2)
      await opts.redis.incrby(k.month, amount)
      await opts.redis.expire(k.month, DAY_SECONDS * 40)
      if (open) {
        await opts.redis.incrby(k.monthOpen, amount)
        await opts.redis.expire(k.monthOpen, DAY_SECONDS * 40)
      }
    },
  }
}

/** No-op budget (Redis unconfigured). Allows every call — dev only. */
export function createNoopBudget(): Budget {
  return {
    async check() {
      return { ok: true, spent: { run: 0, userDay: 0, month: 0 } }
    },
    async add() {
      /* no-op */
    },
  }
}

/**
 * Fail-closed budget: every check is a breach ('store_unavailable'), so the
 * runner / bounded helper refuse the call BEFORE the gateway is touched.
 */
export function createFailClosedBudget(): Budget {
  return {
    async check() {
      return { ok: false, breach: 'store_unavailable', spent: { run: 0, userDay: 0, month: 0 } }
    },
    async add() {
      /* nothing is ever spent */
    },
  }
}

/** Production = NODE_ENV=production or VERCEL_ENV=production. */
export function isProductionEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env['NODE_ENV'] === 'production' || env['VERCEL_ENV'] === 'production'
}

/**
 * True when agent calls MUST have a budget store: production with AGENT_ENABLED=true.
 * (Dark build: AGENT_ENABLED unset ⇒ false ⇒ the dev no-op keeps today's behaviour.)
 */
export function budgetStoreRequired(env: Record<string, string | undefined> = process.env): boolean {
  return isProductionEnv(env) && env['AGENT_ENABLED'] === 'true'
}

/**
 * The budget to use when no Redis/Upstash client is configured: fail closed in
 * production with agents enabled (logged), the dev no-op otherwise.
 */
export function budgetWithoutStore(env: Record<string, string | undefined> = process.env): Budget {
  if (budgetStoreRequired(env)) {
    console.error('[agent-core budget] UPSTASH_REDIS_REST_URL/TOKEN missing in production with AGENT_ENABLED=true — refusing agent model calls (budget_store_unavailable)')
    return createFailClosedBudget()
  }
  return createNoopBudget()
}
