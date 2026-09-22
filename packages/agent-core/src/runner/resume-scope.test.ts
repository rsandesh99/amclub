import { describe, expect, it } from 'vitest'
import type { Budget } from '../budget'
import { makeHarnessLedger, harnessStubGateway } from '../munshi/harness'
import { AgentRun, ToolOutOfScopeError } from './index'

const okBudget: Budget = { async check() { return { ok: true, spent: { run: 0, userDay: 0, month: 0 } } }, async add() {} }

/** S2.2 — a grant narrowed after the proposal: the resume refuses the tool before any fetch. */
describe('AgentRun.resume re-checks the grant scopes', () => {
  async function parkedRun(scopes: readonly string[] | null) {
    const { ledger, decisions } = makeHarnessLedger()
    const { id } = await ledger.openRun({ userId: 'u', persona: 'provider', surface: 'system' })
    await ledger.transitionRun(id, 'running', 'awaiting_confirmation')
    const dec = await ledger.recordDecision({ feature: 'munshi_draft', runId: id, tool: 'submit_quote', inputRefs: {}, proposed: {}, final: {}, decidedBy: 'u' })
    let fetched = 0
    const fetchImpl = (async () => { fetched++; return { status: 200, ok: true, json: async () => ({ quoteId: 'q' }) } }) as unknown as typeof fetch
    const run = new AgentRun({ runId: id, userId: 'u', persona: 'provider', ledger, gateway: harnessStubGateway, budget: okBudget, apiBaseUrl: 'http://x', getToken: () => 't', scopes, fetchImpl })
    return { run, decisionId: dec.id, decisions, fetched: () => fetched, ledger, id }
  }
  it('refuses submit_quote when the current scopes lack it — no fetch, ToolOutOfScopeError', async () => {
    const p = await parkedRun(['extract_requirements', 'read_price_book', 'draft_quote'])
    await expect(p.run.resume('submit_quote', { rfq_id: 'r', price_paise: 1 }, { decisionId: p.decisionId })).rejects.toBeInstanceOf(ToolOutOfScopeError)
    expect(p.fetched()).toBe(0)
    expect((await p.ledger.getRun(p.id))?.status).toBe('awaiting_confirmation')
  })
  it('executes submit_quote when the scopes include it (or are null = full persona)', async () => {
    const p = await parkedRun(['submit_quote'])
    const out = await p.run.resume('submit_quote', { rfq_id: 'r' }, { decisionId: p.decisionId })
    expect(out.status).toBe('done')
    expect(p.fetched()).toBe(1)
    const q = await parkedRun(null)
    expect((await q.run.resume('submit_quote', { rfq_id: 'r' }, { decisionId: q.decisionId })).status).toBe('done')
  })
})
