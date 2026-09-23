import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { budgetStoreRequired, budgetWithoutStore, createFailClosedBudget, isProductionEnv } from './index'
import { runBoundedChatJson } from '../bounded'
import { BudgetExceededError } from '../runner'
import type { Gateway } from '../llm/gateway'
import type { Ledger } from '../ledger/types'
import type { PromptRef } from '../prompts/registry'

/**
 * Track F — no budget store in production with agents enabled FAILS CLOSED:
 * the call is refused before the gateway is touched (breach store_unavailable).
 * Dev / dark build (AGENT_ENABLED unset) keeps the allow-all no-op.
 */

describe('budget without a store', () => {
  it('production = NODE_ENV or VERCEL_ENV production', () => {
    expect(isProductionEnv({ NODE_ENV: 'production' })).toBe(true)
    expect(isProductionEnv({ VERCEL_ENV: 'production' })).toBe(true)
    expect(isProductionEnv({ NODE_ENV: 'development', VERCEL_ENV: 'preview' })).toBe(false)
  })

  it('a store is required only in production with AGENT_ENABLED=true', () => {
    expect(budgetStoreRequired({ NODE_ENV: 'production', AGENT_ENABLED: 'true' })).toBe(true)
    expect(budgetStoreRequired({ NODE_ENV: 'production' })).toBe(false)
    expect(budgetStoreRequired({ NODE_ENV: 'development', AGENT_ENABLED: 'true' })).toBe(false)
  })

  it('prod + enabled → fail-closed breach store_unavailable', async () => {
    const s = await budgetWithoutStore({ VERCEL_ENV: 'production', AGENT_ENABLED: 'true' }).check()
    expect(s).toMatchObject({ ok: false, breach: 'store_unavailable' })
  })

  it('dev / dark → the allow-all no-op (unchanged behaviour)', async () => {
    expect((await budgetWithoutStore({ NODE_ENV: 'development' }).check()).ok).toBe(true)
    expect((await budgetWithoutStore({ NODE_ENV: 'production' }).check()).ok).toBe(true)
  })

  it('a bounded call on a fail-closed budget throws BudgetExceededError before the gateway', async () => {
    let calls = 0
    const gateway = { chatJson: async () => { calls++; throw new Error('unreachable') }, embed: async () => { throw new Error('unreachable') } } as unknown as Gateway
    const ledger = { logInvocation: async () => undefined } as unknown as Ledger
    const prompt: PromptRef = { id: 'x', version: 'v1', taskClass: 'quote_extract', schemaRef: 'x', text: 's' }
    const err = await runBoundedChatJson({ gateway, ledger, budget: createFailClosedBudget() }, { userId: 'u', feature: 'f', taskClass: 'quote_extract', prompt, schema: z.object({}) }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BudgetExceededError)
    expect((err as BudgetExceededError).code).toBe('budget_store_unavailable')
    expect(calls).toBe(0)
  })
})
