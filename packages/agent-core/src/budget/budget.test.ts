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
})
