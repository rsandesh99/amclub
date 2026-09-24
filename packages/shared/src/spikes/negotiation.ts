import { MAX_QUOTE_REVISIONS } from '../schemas/index'

/**
 * S4.3 SPIKE — NOT PRODUCT CODE (ADR 013 §6).
 *
 * This file is not exported from the package index. It has no schema, no flag and no caller. It exists so that
 * ADR 013's option B (the "sealed one-round counter") is argued from a function whose properties are tested,
 * not from prose. Deleting it changes nothing in the product.
 *
 * Option B, in one line: the buyer may name ONE target price per quote revision. The provider's own pre-set rule
 * (a private floor and a maximum concession) answers it. The provider still taps to send the result, through the
 * ordinary quote-revise route. The laws it tests (ADR 013 §5):
 *   1. Bounded: the answer is never below the provider's floor, never above the live quote, and never concedes more
 *      than the provider's cap (itself capped at NEGOTIATION_SPIKE_CAP_BPS).
 *   2. Sealed: the inputs are one provider's own numbers and the buyer's one number. There is no field for another
 *      provider's quote, so the function cannot run an auction. Providers never see each other or the target.
 *   3. One bit per probe: when the counter is made, its price depends only on (quote, target), never on the floor or
 *      the cap. The floor and the cap only decide yes / no.
 *   4. Few probes: one counter per revision, and a counter IS a revision. quotes.revision is capped at
 *      MAX_QUOTE_REVISIONS, so a quote can be probed at most MAX_QUOTE_REVISIONS − 1 times over its whole life. A buyer
 *      cannot binary-search the floor.
 *   5. Code, never a model: integers in paise, deterministic, no text in or out.
 */

/** Hard ceiling on any provider's maxConcessionBps (15 %). Settings could only tighten it. */
export const NEGOTIATION_SPIKE_CAP_BPS = 1500

/** Counter prices land on a ₹100 grid, rounded UP (in the provider's favour), and never above the quote. */
export const NEGOTIATION_SPIKE_GRID_PAISE = 100_00

export interface SealedCounterInput {
  /** The provider's live quote price, in paise, ex-GST (the quote row, or the chosen speed option). */
  quotePaise: number
  /** The quote's current revision (quotes.revision, 1..MAX_QUOTE_REVISIONS). */
  revision: number
  /** True when this revision was already countered once. */
  counteredThisRevision: boolean
  /** The provider's private floor. The provider sets it ahead of time; it is never inferred or shown. */
  floorPaise: number
  /** How far the provider lets the rule move, in basis points of the quote (at most NEGOTIATION_SPIKE_CAP_BPS). */
  maxConcessionBps: number
  /** The buyer's one structured target: a number, never text. */
  targetPaise: number
}

export type SealedCounterOutcome =
  /** Nothing to move: the target is at or above the quote, or the gap is smaller than one grid step. */
  | { kind: 'no_change'; pricePaise: number }
  /** A revised price. It is a PROPOSAL: the provider taps to send it as an ordinary revision. */
  | { kind: 'counter'; pricePaise: number; nextRevision: number }
  /** The target is below what this provider's rule allows. The quote stands, and nothing about the floor is said. */
  | { kind: 'declined'; pricePaise: number }
  | { kind: 'refused'; reason: 'invalid_input' | 'round_used' | 'revision_cap' }

const isPaise = (n: number): boolean => Number.isSafeInteger(n) && n > 0

/** The lowest price the provider's rule allows: the floor, or the quote less the capped concession, whichever is higher. */
export function permissibleMinimum(quotePaise: number, floorPaise: number, maxConcessionBps: number): number {
  const concession = Math.floor((quotePaise * maxConcessionBps) / 10_000)
  return Math.max(floorPaise, quotePaise - concession)
}

export function sealedCounter(input: SealedCounterInput): SealedCounterOutcome {
  const { quotePaise, revision, counteredThisRevision, floorPaise, maxConcessionBps, targetPaise } = input
  if (
    !isPaise(quotePaise) || !isPaise(floorPaise) || !isPaise(targetPaise) ||
    floorPaise > quotePaise ||
    !Number.isInteger(maxConcessionBps) || maxConcessionBps < 0 || maxConcessionBps > NEGOTIATION_SPIKE_CAP_BPS ||
    !Number.isInteger(revision) || revision < 1 || revision > MAX_QUOTE_REVISIONS
  ) {
    return { kind: 'refused', reason: 'invalid_input' }
  }
  if (counteredThisRevision) return { kind: 'refused', reason: 'round_used' }
  if (revision >= MAX_QUOTE_REVISIONS) return { kind: 'refused', reason: 'revision_cap' }

  if (targetPaise >= quotePaise) return { kind: 'no_change', pricePaise: quotePaise }
  if (targetPaise < permissibleMinimum(quotePaise, floorPaise, maxConcessionBps)) return { kind: 'declined', pricePaise: quotePaise }

  // Split the gap; the provider keeps the odd paisa and the grid rounding. Depends on (quote, target) only (law 3).
  const midpoint = targetPaise + Math.ceil((quotePaise - targetPaise) / 2)
  const onGrid = Math.ceil(midpoint / NEGOTIATION_SPIKE_GRID_PAISE) * NEGOTIATION_SPIKE_GRID_PAISE
  const price = Math.min(quotePaise, onGrid)
  if (price >= quotePaise) return { kind: 'no_change', pricePaise: quotePaise }
  return { kind: 'counter', pricePaise: price, nextRevision: revision + 1 }
}
