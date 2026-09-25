import { describe, expect, it, beforeEach } from 'vitest'
import { createNoopBudget, createRedisBudget, resolveCaps, type RedisLike } from './index'

/** In-memory RedisLike stand-in for the three budget counters. */
function fakeRedis(): RedisLike & { store: Map<string, number> } {
  const store = new Map<string, number>()
  return {
    store,
    async incrby(key, value) {
      const next = (store.get(key) ?? 0) + value
      store.set(key, next)
      return next
    },
    async expire() {
      return 1
    },
    async mget<T = unknown>(...keys: string[]) {
      return keys.map((k) => (store.has(k) ? (store.get(k) as unknown as T) : null))
    },
  }
}

const CAPS = { runPaise: 2000, userDayPaise: 5000, monthPaise: 500_000 }

describe('budget counters', () => {
  let redis: ReturnType<typeof fakeRedis>
  beforeEach(() => {
    redis = fakeRedis()
  })

  it('allows while under every cap and records spend on all three counters', async () => {
    const b = createRedisBudget({ redis, caps: CAPS, runId: 'r1', userId: 'u1' })
    expect((await b.check()).ok).toBe(true)
    await b.add(500)
    // three counters incremented
    expect([...redis.store.values()].filter((v) => v === 500).length).toBe(3)
    expect((await b.check()).ok).toBe(true)
  })

  it('fails on the run cap', async () => {
    const b = createRedisBudget({ redis, caps: CAPS, runId: 'r1', userId: 'u1' })
    await b.add(2000)
    const s = await b.check()
    expect(s.ok).toBe(false)
    expect(s.breach).toBe('run_cap')
  })

  it('fails on the user-day cap even when the run is small', async () => {
    // Pre-load the user-day counter for today past the cap.
    const b = createRedisBudget({ redis, caps: { ...CAPS, runPaise: 10_000_000 }, runId: 'r1', userId: 'u1' })
    await b.add(5000)
    const s = await b.check()
    expect(s.ok).toBe(false)
    expect(s.breach).toBe('user_day_cap')
  })

  it('S1.6: a zero run cap fails the check before any spend (per-agent override) and lazy caps resolve once', async () => {
    let loads = 0
    const b = createRedisBudget({ redis, caps: async () => { loads++; return { ...CAPS, runPaise: 0 } }, runId: 'r1', userId: 'u1' })
    const s = await b.check()
    expect(s.ok).toBe(false)
    expect(s.breach).toBe('run_cap')
    await b.check()
    expect(loads).toBe(1)
  })

  it('S1.6: resolveCaps prefers budget_run_paise_by_agent[agent] over budget_run_paise; absent agent = global', () => {
    const settings = { budget_run_paise: 2000, budget_run_paise_by_agent: { onboarding: 1500 } }
    expect(resolveCaps(settings, 'onboarding').runPaise).toBe(1500)
    expect(resolveCaps(settings, 'rfq_quality').runPaise).toBe(2000)
    expect(resolveCaps(settings).runPaise).toBe(2000)
    expect(resolveCaps({ budget_run_paise_by_agent: { onboarding: 0 } }, 'onboarding').runPaise).toBe(0)
    expect(resolveCaps({}, 'onboarding').runPaise).toBe(2000) // registry default
  })

  it('noop budget always allows', async () => {
    const b = createNoopBudget()
    expect((await b.check()).ok).toBe(true)
    await b.add(9_999_999)
    expect((await b.check()).ok).toBe(true)
  })
})

describe('resolveCaps', () => {
  it('uses registry defaults when nothing is set', () => {
    const caps = resolveCaps()
    expect(caps.runPaise).toBe(2000)
    expect(caps.userDayPaise).toBe(5000)
    expect(caps.monthPaise).toBe(500_000)
  })

  it('prefers a provided setting over the default', () => {
    const caps = resolveCaps({ budget_run_paise: 1234 })
    expect(caps.runPaise).toBe(1234)
  })

  it('audit M24: the open envelope defaults from the registry and never exceeds the month cap', () => {
    expect(resolveCaps().monthOpenPaise).toBe(200_000)
    expect(resolveCaps({ budget_month_paise: 100_000 }).monthOpenPaise).toBe(100_000)
    expect(resolveCaps({ budget_month_open_paise: 50_000 }).monthOpenPaise).toBe(50_000)
  })
})

describe('audit M24 — the open envelope keeps headroom for the cohort and ops', () => {
  const caps = { runPaise: 1_000_000, userDayPaise: 1_000_000, monthPaise: 10_000, monthOpenPaise: 4_000 }
  it('outside traffic stops at the envelope while the cohort keeps spending up to the month cap', async () => {
    const redis = fakeRedis()
    // many different outside users, one small call each
    for (let i = 0; i < 4; i++) {
      const b = createRedisBudget({ redis, caps, runId: `open-${i}`, userId: `stranger-${i}`, audience: 'open' })
      expect((await b.check()).ok).toBe(true)
      await b.add(1_000)
    }
    const fifth = await createRedisBudget({ redis, caps, runId: 'open-5', userId: 'stranger-5', audience: 'open' }).check()
    expect(fifth).toMatchObject({ ok: false, breach: 'month_open_cap' })
    const cohort = createRedisBudget({ redis, caps, runId: 'c1', userId: 'member', audience: 'cohort' })
    expect((await cohort.check()).ok).toBe(true)
    await cohort.add(5_000)
    expect((await createRedisBudget({ redis, caps, runId: 'ops', userId: 'founder', audience: 'ops' }).check()).ok).toBe(true)
    // the month cap still binds everyone
    await cohort.add(1_000)
    expect(await createRedisBudget({ redis, caps, runId: 'c2', userId: 'member', audience: 'cohort' }).check()).toMatchObject({ ok: false, breach: 'month_cap' })
  })
  it('cohort / ops spend never touches the open counter', async () => {
    const redis = fakeRedis()
    await createRedisBudget({ redis, caps, runId: 'c1', userId: 'm', audience: 'cohort' }).add(3_000)
    expect([...redis.store.keys()].some((k) => k.includes('month_open'))).toBe(false)
  })
})
