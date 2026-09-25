import { describe, expect, it } from 'vitest'
import { bindTextConfirmation, MUNSHI_TEXT_WINDOW_MS, type OpenConfirmable } from './binding'

const now = new Date('2026-09-24T12:00:00Z')
const ago = (min: number) => new Date(now.getTime() - min * 60_000).toISOString()
const munshi = (runId: string, min: number | null): OpenConfirmable => ({ agent: 'munshi', runId, deliveredAt: min === null ? null : ago(min) })
const proc = (runId: string, min: number): OpenConfirmable => ({ agent: 'procurement', runId, deliveredAt: ago(min) })

describe('bindTextConfirmation (audit M42)', () => {
  it('binds the only open proposal inside its window', () => {
    expect(bindTextConfirmation({ open: [munshi('m1', 5)], quoted: false, quotedRunId: null, now })).toMatchObject({ status: 'bound', via: 'only_open', proposal: { runId: 'm1' } })
  })
  it('never binds when two proposals are open (across agents or two Munshi drafts)', () => {
    expect(bindTextConfirmation({ open: [munshi('m1', 5), proc('p1', 1)], quoted: false, quotedRunId: null, now })).toMatchObject({ status: 'ambiguous', reason: 'several_open' })
    expect(bindTextConfirmation({ open: [munshi('m1', 5), munshi('m2', 1)], quoted: false, quotedRunId: null, now })).toMatchObject({ status: 'ambiguous', reason: 'several_open' })
  })
  it('a quoted reply binds exactly the quoted proposal, and never another', () => {
    expect(bindTextConfirmation({ open: [munshi('m1', 5), proc('p1', 1)], quoted: true, quotedRunId: 'p1', now })).toMatchObject({ status: 'bound', via: 'quoted', proposal: { runId: 'p1' } })
    expect(bindTextConfirmation({ open: [munshi('m1', 5)], quoted: true, quotedRunId: 'gone', now })).toMatchObject({ status: 'ambiguous', reason: 'quoted_other' })
    expect(bindTextConfirmation({ open: [munshi('m1', 5)], quoted: true, quotedRunId: null, now })).toMatchObject({ status: 'ambiguous', reason: 'quoted_other' })
  })
  it("Munshi's text window is short; a quote still binds after it", () => {
    expect(MUNSHI_TEXT_WINDOW_MS).toBeLessThanOrEqual(60 * 60 * 1000)
    expect(bindTextConfirmation({ open: [munshi('m1', 45)], quoted: false, quotedRunId: null, now })).toMatchObject({ status: 'ambiguous', reason: 'outside_window' })
    expect(bindTextConfirmation({ open: [munshi('m1', null)], quoted: false, quotedRunId: null, now })).toMatchObject({ status: 'ambiguous', reason: 'outside_window' })
    expect(bindTextConfirmation({ open: [munshi('m1', 45)], quoted: true, quotedRunId: 'm1', now })).toMatchObject({ status: 'bound', via: 'quoted' })
  })
  it('a re-sent card is one proposal whose window counts from the latest send', () => {
    expect(bindTextConfirmation({ open: [munshi('m1', 400), munshi('m1', 1)], quoted: false, quotedRunId: null, now })).toMatchObject({ status: 'bound', proposal: { runId: 'm1' } })
  })
  it('nothing open → none', () => {
    expect(bindTextConfirmation({ open: [], quoted: true, quotedRunId: 'm1', now })).toEqual({ status: 'none' })
  })
})
