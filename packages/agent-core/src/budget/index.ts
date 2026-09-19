import { agentSettingDefault } from '@amclub/shared'

/**
 * Budget & cost governance (ARCHITECTURE.md §9). Three counters — per run, per
 * user-day, per month — checked BEFORE each model call and incremented AFTER it
 * with a TTL. A breach fails the run cleanly. Caps come from agent_settings
 * (loaded once per run) with env fallback. When no Redis is configured the
 * budget is a no-op that allows (dev only) — prod must set Upstash.
 */

export interface BudgetCaps {
  runPaise: number
  userDayPaise: number
  monthPaise: number
}

export type BudgetBreach = 'run_cap' | 'user_day_cap' | 'month_cap'

export interface BudgetStatus {
  ok: boolean
  breach?: BudgetBreach
  spent: { run: number; userDay: number; month: number }
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

/** Caps from agent_settings values (or the registry defaults) with env override. */
export function resolveCaps(settings?: Partial<Record<string, unknown>>): BudgetCaps {
  const num = (v: unknown, fallback: number) => {
    const n = typeof v === 'number' ? v : Number(v)
    return Number.isFinite(n) && n >= 0 ? n : fallback
  }
  const dRun = agentSettingDefault('budget_run_paise') as number
  const dDay = agentSettingDefault('budget_user_day_paise') as number
  const dMonth = agentSettingDefault('budget_month_paise') as number
  return {
    runPaise: num(process.env['AGENT_BUDGET_RUN_PAISE'] ?? settings?.['budget_run_paise'], dRun),
    userDayPaise: num(process.env['AGENT_BUDGET_USER_DAY_PAISE'] ?? settings?.['budget_user_day_paise'], dDay),
    monthPaise: num(process.env['AGENT_BUDGET_MONTH_PAISE'] ?? settings?.['budget_month_paise'], dMonth),
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
  caps: BudgetCaps
  runId: string
  userId: string
  now?: () => Date
  keyPrefix?: string
}

const DAY_SECONDS = 86_400

export function createRedisBudget(opts: RedisBudgetOptions): Budget {
  const now = opts.now ?? (() => new Date())
  const prefix = opts.keyPrefix ?? 'agent:bud'
  const keys = () => {
    const d = now()
    return {
      run: `${prefix}:run:${opts.runId}`,
      userDay: `${prefix}:uday:${opts.userId}:${ymd(d)}`,
      month: `${prefix}:month:${ym(d)}`,
    }
  }
  return {
    async check(): Promise<BudgetStatus> {
      const k = keys()
      const [run, userDay, month] = await opts.redis.mget<number>(k.run, k.userDay, k.month)
      const spent = { run: Number(run ?? 0), userDay: Number(userDay ?? 0), month: Number(month ?? 0) }
      if (spent.run >= opts.caps.runPaise) return { ok: false, breach: 'run_cap', spent }
      if (spent.userDay >= opts.caps.userDayPaise) return { ok: false, breach: 'user_day_cap', spent }
      if (spent.month >= opts.caps.monthPaise) return { ok: false, breach: 'month_cap', spent }
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
