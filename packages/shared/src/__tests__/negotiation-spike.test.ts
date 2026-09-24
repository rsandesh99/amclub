import { describe, expect, it } from 'vitest'
import * as shared from '../index'
import { MAX_QUOTE_REVISIONS } from '../schemas/index'
import {
  NEGOTIATION_SPIKE_CAP_BPS,
  NEGOTIATION_SPIKE_GRID_PAISE,
  permissibleMinimum,
  sealedCounter,
  type SealedCounterInput,
} from '../spikes/negotiation'

/** ADR 013 §6 — the S4.3 spike's laws. Nothing here is product code; the spike is not exported. */

const base: SealedCounterInput = {
  quotePaise: 50_000_00,
  revision: 1,
  counteredThisRevision: false,
  floorPaise: 44_000_00,
  maxConcessionBps: 1000,
  targetPaise: 46_000_00,
}

/** A small seeded PRNG (mulberry32) so the property sweep is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomInput(r: () => number): SealedCounterInput {
  const quotePaise = 1_000_00 + Math.floor(r() * 5_00_000_00)
  const floorPaise = Math.max(1, Math.floor(quotePaise * (0.6 + r() * 0.4)))
  return {
    quotePaise,
    revision: 1 + Math.floor(r() * (MAX_QUOTE_REVISIONS - 1)),
    counteredThisRevision: false,
    floorPaise,
    maxConcessionBps: Math.floor(r() * (NEGOTIATION_SPIKE_CAP_BPS + 1)),
    targetPaise: Math.max(1, Math.floor(quotePaise * (0.5 + r() * 0.6))),
  }
}

describe('S4.3 spike — sealed one-round counter (ADR 013 option B)', () => {
  it('is not exported from the package index (spike only, no caller)', () => {
    expect('sealedCounter' in shared).toBe(false)
    expect('permissibleMinimum' in shared).toBe(false)
    expect('NEGOTIATION_SPIKE_CAP_BPS' in shared).toBe(false)
  })

  it('splits the gap, rounds up to the ₹100 grid, and proposes the next revision', () => {
    // gap ₹4,000 → midpoint ₹48,000 (already on the grid)
    expect(sealedCounter(base)).toEqual({ kind: 'counter', pricePaise: 48_000_00, nextRevision: 2 })
    // gap ₹3,999 → midpoint ₹48,000.50 → ₹48,100 on the grid
    expect(sealedCounter({ ...base, targetPaise: 46_001_00 })).toEqual({ kind: 'counter', pricePaise: 48_100_00, nextRevision: 2 })
  })

  it('declines a target below the rule without saying anything about the floor', () => {
    const out = sealedCounter({ ...base, targetPaise: 43_000_00 })
    expect(out).toEqual({ kind: 'declined', pricePaise: base.quotePaise })
  })

  it('the cap binds before the floor when it is tighter', () => {
    // floor ₹30,000 but the cap (10 %) allows ₹45,000 at the lowest
    expect(permissibleMinimum(50_000_00, 30_000_00, 1000)).toBe(45_000_00)
    expect(sealedCounter({ ...base, floorPaise: 30_000_00, targetPaise: 44_999_00 }).kind).toBe('declined')
    expect(sealedCounter({ ...base, floorPaise: 30_000_00, targetPaise: 45_000_00 }).kind).toBe('counter')
  })

  it('no change when the target is at or above the quote, or the gap is under one grid step', () => {
    expect(sealedCounter({ ...base, targetPaise: base.quotePaise })).toEqual({ kind: 'no_change', pricePaise: base.quotePaise })
    expect(sealedCounter({ ...base, targetPaise: base.quotePaise + 1 })).toEqual({ kind: 'no_change', pricePaise: base.quotePaise })
    // gap ₹50 → midpoint ₹49,975 → the grid rounds it back up to the quote
    expect(sealedCounter({ ...base, targetPaise: 49_950_00 })).toEqual({ kind: 'no_change', pricePaise: base.quotePaise })
    // an off-grid quote can still move to the grid step just below it
    expect(sealedCounter({ ...base, quotePaise: 50_000_50, targetPaise: 49_990_00 })).toEqual({ kind: 'counter', pricePaise: 50_000_00, nextRevision: 2 })
  })

  it('one counter per revision, and never past the revision cap', () => {
    expect(sealedCounter({ ...base, counteredThisRevision: true })).toEqual({ kind: 'refused', reason: 'round_used' })
    expect(sealedCounter({ ...base, revision: MAX_QUOTE_REVISIONS })).toEqual({ kind: 'refused', reason: 'revision_cap' })
  })

  it('refuses malformed input rather than guessing', () => {
    const bad: Array<Partial<SealedCounterInput>> = [
      { quotePaise: 0 }, { quotePaise: 1.5 }, { floorPaise: 60_000_00 }, { targetPaise: -1 },
      { maxConcessionBps: NEGOTIATION_SPIKE_CAP_BPS + 1 }, { maxConcessionBps: -1 }, { maxConcessionBps: 2.5 },
      { revision: 0 }, { revision: MAX_QUOTE_REVISIONS + 1 }, { quotePaise: Number.MAX_SAFE_INTEGER + 2 },
    ]
    for (const b of bad) expect(sealedCounter({ ...base, ...b })).toEqual({ kind: 'refused', reason: 'invalid_input' })
  })

  it('law 1 (bounded) holds across a seeded sweep of 20,000 inputs', () => {
    const r = rng(20260924)
    let counters = 0
    for (let i = 0; i < 20_000; i++) {
      const input = randomInput(r)
      const out = sealedCounter(input)
      if (out.kind === 'refused') throw new Error(`unexpected refusal for ${JSON.stringify(input)}`)
      expect(Number.isSafeInteger(out.pricePaise)).toBe(true)
      expect(out.pricePaise).toBeLessThanOrEqual(input.quotePaise)
      expect(out.pricePaise).toBeGreaterThanOrEqual(input.floorPaise)
      const concession = input.quotePaise - out.pricePaise
      expect(concession * 10_000).toBeLessThanOrEqual(input.quotePaise * input.maxConcessionBps)
      if (out.kind === 'counter') {
        counters++
        expect(out.pricePaise).toBeLessThan(input.quotePaise)
        expect(out.pricePaise).toBeGreaterThanOrEqual(input.targetPaise)
        expect(out.pricePaise % NEGOTIATION_SPIKE_GRID_PAISE).toBe(0)
        expect(out.nextRevision).toBe(input.revision + 1)
      }
    }
    expect(counters).toBeGreaterThan(1000) // the sweep really exercises the counter branch
  })

  it('law 3 (one bit): when a counter is made, its price ignores the floor and the cap', () => {
    const r = rng(7)
    for (let i = 0; i < 2000; i++) {
      const input = randomInput(r)
      const out = sealedCounter(input)
      if (out.kind !== 'counter') continue
      // Any other floor / cap that still admits the target gives the SAME price.
      const loosest = sealedCounter({ ...input, floorPaise: 1, maxConcessionBps: NEGOTIATION_SPIKE_CAP_BPS })
      const tightest = sealedCounter({ ...input, floorPaise: input.targetPaise, maxConcessionBps: Math.ceil(((input.quotePaise - input.targetPaise) * 10_000) / input.quotePaise) })
      expect(loosest).toEqual(out)
      expect(tightest).toEqual(out)
    }
  })

  it('law 4 (few probes): a buyer probing the floor gets at most MAX_QUOTE_REVISIONS − 1 answers per quote', () => {
    // An adversarial buyer binary-searches the floor, re-probing after every answer.
    const floor = 43_210_00
    let lo = 1
    let hi = base.quotePaise
    let quote = base.quotePaise
    let revision = 1
    let countered = false
    let answers = 0
    for (let probe = 0; probe < 40; probe++) {
      const target = Math.floor((lo + hi) / 2)
      const out = sealedCounter({ ...base, quotePaise: quote, floorPaise: floor, maxConcessionBps: NEGOTIATION_SPIKE_CAP_BPS, revision, counteredThisRevision: countered, targetPaise: target })
      if (out.kind === 'refused') {
        // A decline leaves the revision countered; only the provider's own revision would reset it.
        continue
      }
      answers++
      // The provider sends the counter as the next revision; the buyer learned "floor ≤ target".
      if (out.kind === 'counter') { hi = target; quote = out.pricePaise; revision = out.nextRevision; countered = false }
      else { lo = target; countered = true }
    }
    expect(answers).toBeLessThanOrEqual(MAX_QUOTE_REVISIONS - 1)
    // With so few answers the floor stays uncertain across a wide band (> ₹1,000 here), not pinned to the rupee.
    expect(hi - lo).toBeGreaterThan(1_000_00)
  })

  it('law 2 (sealed): the input has no field for another provider\'s price, so it cannot run an auction', () => {
    const others = [41_000_00, 42_500_00, 39_900_00]
    // @ts-expect-error — there is deliberately no cross-quote input
    const out = sealedCounter({ ...base, otherQuotesPaise: others })
    // Extra fields are ignored at run time: the answer equals the sealed answer.
    expect(out).toEqual(sealedCounter(base))
  })

  it('a simulated "bidding war" cannot run: each provider moves once, within its own cap', () => {
    // Five providers; the buyer keeps setting the target to the lowest price seen (the dynamic §8.3 rejects).
    const providers = [50_000_00, 48_000_00, 52_000_00, 47_500_00, 49_000_00].map((q, i) => ({
      quote: q, revision: 1, countered: false, floor: Math.floor(q * 0.8), capBps: 1000 + i * 100,
    }))
    for (let round = 0; round < 10; round++) {
      const lowest = Math.min(...providers.map((p) => p.quote))
      for (const p of providers) {
        const out = sealedCounter({ quotePaise: p.quote, revision: p.revision, counteredThisRevision: p.countered, floorPaise: p.floor, maxConcessionBps: p.capBps, targetPaise: lowest - 1_000_00 })
        if (out.kind === 'counter') { p.quote = out.pricePaise; p.revision = out.nextRevision }
        else if (out.kind !== 'refused') p.countered = true
      }
    }
    const originals = [50_000_00, 48_000_00, 52_000_00, 47_500_00, 49_000_00]
    providers.forEach((p, i) => {
      // Two revisions at most (1 → 2 → 3), each concession within that revision's cap.
      expect(p.revision).toBeLessThanOrEqual(MAX_QUOTE_REVISIONS)
      const maxTotal = originals[i]! - Math.floor(originals[i]! * (1 - p.capBps / 10_000) ** (MAX_QUOTE_REVISIONS - 1))
      expect(originals[i]! - p.quote).toBeLessThanOrEqual(maxTotal)
      expect(p.quote).toBeGreaterThanOrEqual(p.floor)
    })
  })
})
