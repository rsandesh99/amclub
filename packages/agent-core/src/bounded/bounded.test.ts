import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createGateway } from '../llm/gateway'
import { createSupabaseLedger } from '../ledger/supabase'
import type { Budget } from '../budget'
import type { PromptRef } from '../prompts/registry'
import { BudgetExceededError } from '../runner'
import { runBoundedChatJson } from './index'

/**
 * S1.1 §3 — bounded call: one ai_invocations insert per call with run_id null
 * and the feature passed through; a budget breach throws BEFORE the gateway
 * is called; a gateway error still writes an 'error' row.
 */

const prompt: PromptRef = { id: 'quote_extract', version: 'v1', taskClass: 'quote_extract', schemaRef: 'x', text: 'SYSTEM' }
const schema = z.object({ ok: z.boolean() })

/** In-memory admin fake: records every ai_invocations insert. */
function fakeAdmin() {
  const inserts: Array<Record<string, unknown>> = []
  const admin = {
    from(table: string) {
      return {
        insert: async (row: Record<string, unknown>) => {
          if (table === 'ai_invocations') inserts.push(row)
          return { error: null }
        },
      }
    },
  }
  return { admin: admin as unknown as Parameters<typeof createSupabaseLedger>[0], inserts }
}

const budgetOf = (ok: boolean): Budget & { added: number[] } => {
  const added: number[] = []
  return {
    added,
    async check() {
      return ok ? { ok: true, spent: { run: 0, userDay: 0, month: 0 } } : { ok: false, breach: 'user_day_cap', spent: { run: 0, userDay: 9999, month: 0 } }
    },
    async add(p) {
      added.push(p)
    },
  }
}

const stubGateway = () => createGateway({ baseUrl: 'https://llm.test', apiKey: null, embedBaseUrl: 'https://llm.test', timeoutMs: 100, maxRetries: 0, forceStub: true })

describe('runBoundedChatJson', () => {
  it('stub call: one ai_invocations row, run_id null, feature + task class + tier recorded', async () => {
    const { admin, inserts } = fakeAdmin()
    const r = await runBoundedChatJson(
      { gateway: stubGateway(), ledger: createSupabaseLedger(admin), budget: budgetOf(true) },
      { userId: 'u1', feature: 'quote_extraction', taskClass: 'quote_extract', prompt, schema, stub: () => ({ ok: true }), meta: { rfq_id: 'r1' } },
    )
    expect(r.stub).toBe(true)
    expect(r.data.ok).toBe(true)
    expect(inserts).toHaveLength(1)
    const row = inserts[0]!
    expect(row['run_id']).toBeNull()
    expect(row['feature']).toBe('quote_extraction')
    expect(row['task_class']).toBe('quote_extract')
    expect(row['tier']).toBe('routine')
    expect(row['status']).toBe('stub')
    expect((row['meta'] as Record<string, unknown>)['rfq_id']).toBe('r1')
  })

  it('budget breach throws before the gateway is called and writes no row', async () => {
    const { admin, inserts } = fakeAdmin()
    let gatewayCalls = 0
    const gateway = { ...stubGateway(), chatJson: async () => { gatewayCalls++; throw new Error('should not be called') } } as unknown as ReturnType<typeof createGateway>
    await expect(
      runBoundedChatJson({ gateway, ledger: createSupabaseLedger(admin), budget: budgetOf(false) }, { userId: 'u1', feature: 'f', taskClass: 'quote_extract', prompt, schema, stub: () => ({ ok: true }) }),
    ).rejects.toBeInstanceOf(BudgetExceededError)
    expect(gatewayCalls).toBe(0)
    expect(inserts).toHaveLength(0)
  })

  it('gateway error → one error row, then rethrows', async () => {
    const { admin, inserts } = fakeAdmin()
    const gateway = { ...stubGateway(), chatJson: async () => { throw new Error('gateway 502') } } as unknown as ReturnType<typeof createGateway>
    await expect(runBoundedChatJson({ gateway, ledger: createSupabaseLedger(admin), budget: budgetOf(true) }, { userId: 'u1', feature: 'f', taskClass: 'quote_extract', prompt, schema })).rejects.toThrow('gateway 502')
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!['status']).toBe('error')
    expect((inserts[0]!['meta'] as Record<string, unknown>)['error']).toBe('gateway 502')
  })

  it('a priced live-shaped result adds to the budget', async () => {
    const { admin } = fakeAdmin()
    const gateway = {
      ...stubGateway(),
      chatJson: async () => ({ data: { ok: true }, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01, raw: null }, model: 'm', latencyMs: 1, stub: false }),
    } as unknown as ReturnType<typeof createGateway>
    const budget = budgetOf(true)
    const r = await runBoundedChatJson({ gateway, ledger: createSupabaseLedger(admin), budget }, { userId: 'u1', feature: 'f', taskClass: 'quote_extract', prompt, schema })
    expect(r.costPaise).toBeGreaterThan(0)
    expect(budget.added).toEqual([r.costPaise])
  })
})
