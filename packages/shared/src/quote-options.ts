import { compareQuotes, type CompareFlag, type CompareOptions, type CompareQuoteInput } from './compare'
import { quoteChargeAmounts } from './quote-v3'
import type { QuoteOptionInput, QuoteOptionLabel, QuoteChoiceLabel } from './quote-options-schema'

export * from './quote-options-schema'

/**
 * ADR 020 (PRD Experience v3 E12b, N21) — speed tiers on a services quote. The
 * quote row itself IS the Standard option (its price_paise / delivery_days, so
 * every existing reader — compare, loss labels, benchmarks, insights — keeps
 * meaning "standard"). A provider may add at most one Economy (slower, never
 * dearer) and one Express (faster, never cheaper) row. The buyer only picks;
 * nothing here is negotiated (§8.3). A quote without options behaves exactly
 * as before.
 */
export type QuoteOptionsProblem = 'express_not_faster' | 'express_cheaper' | 'economy_not_slower' | 'economy_dearer'

/**
 * Coherence against the Standard row: Express is strictly faster and never
 * cheaper; Economy is strictly slower and never dearer. (So with all three:
 * express < standard < economy in days, and prices never fall as speed rises.)
 */
export function quoteOptionsProblems(standard: { pricePaise: number; deliveryDays: number }, options: readonly QuoteOptionInput[]): QuoteOptionsProblem[] {
  const out: QuoteOptionsProblem[] = []
  for (const o of options) {
    if (o.label === 'express') {
      if (!(o.delivery_days < standard.deliveryDays)) out.push('express_not_faster')
      if (o.price_paise < standard.pricePaise) out.push('express_cheaper')
    } else {
      if (!(o.delivery_days > standard.deliveryDays)) out.push('economy_not_slower')
      if (o.price_paise > standard.pricePaise) out.push('economy_dearer')
    }
  }
  return out
}

/** One option as the server stores / the buyer sees it. */
export interface QuoteOptionRow {
  id: string
  label: QuoteOptionLabel
  pricePaise: number
  deliveryDays: number
}

/** A buyer-facing choice: Standard (the quote row, id null) or a stored option. */
export interface QuoteChoice {
  optionId: string | null
  label: QuoteChoiceLabel
  pricePaise: number
  deliveryDays: number
  /** What checkout would charge for this choice (ADR-015 / ADR-017 per the quote's GST mode). */
  normalizedTotalPaise: number
  flags: CompareFlag[]
}

const ORDER: Record<QuoteChoiceLabel, number> = { economy: 0, standard: 1, express: 2 }

/**
 * Every choice per quote, with its checkout total and its flags. A choice's
 * flags are compareQuotes run with THAT quote at that choice and every other
 * quote at Standard (the default the buyer sees), so a column's chips follow
 * its selected option. Deterministic; server-side only.
 */
export function quoteChoices(
  quotes: readonly (CompareQuoteInput & { options?: readonly QuoteOptionRow[] })[],
  opts: CompareOptions,
): Map<string, QuoteChoice[]> {
  const base = quotes.map((q) => {
    const rest: CompareQuoteInput & { options?: unknown } = { ...q }
    delete rest.options
    return rest as CompareQuoteInput
  })
  const standard = compareQuotes(base, opts)
  const out = new Map<string, QuoteChoice[]>()
  quotes.forEach((q, i) => {
    const std = standard[i]!
    const choices: QuoteChoice[] = [{ optionId: null, label: 'standard', pricePaise: q.pricePaise, deliveryDays: q.deliveryDays ?? 0, normalizedTotalPaise: std.normalizedTotalPaise, flags: std.flags }]
    if (q.kind === 'service') {
      for (const o of q.options ?? []) {
        const swapped = base.map((b, j) => (j === i ? { ...b, pricePaise: o.pricePaise, deliveryDays: o.deliveryDays } : b))
        const r = compareQuotes(swapped, opts)[i]!
        choices.push({ optionId: o.id, label: o.label, pricePaise: o.pricePaise, deliveryDays: o.deliveryDays, normalizedTotalPaise: r.normalizedTotalPaise, flags: r.flags })
      }
    }
    out.set(q.id, choices.sort((a, b) => ORDER[a.label] - ORDER[b.label]))
  })
  return out
}

/** "Lowest" and "fastest" across every choice of every quote (ties → the earlier quote, then Standard). */
export function choiceExtremes(choices: Map<string, QuoteChoice[]>): { lowest: { quoteId: string; optionId: string | null } | null; fastest: { quoteId: string; optionId: string | null } | null } {
  let lowest: { quoteId: string; c: QuoteChoice } | null = null
  let fastest: { quoteId: string; c: QuoteChoice } | null = null
  for (const [quoteId, cs] of choices) {
    for (const c of cs) {
      if (!lowest || c.normalizedTotalPaise < lowest.c.normalizedTotalPaise) lowest = { quoteId, c }
      if (c.deliveryDays > 0 && (!fastest || c.deliveryDays < fastest.c.deliveryDays)) fastest = { quoteId, c }
    }
  }
  return {
    lowest: lowest ? { quoteId: lowest.quoteId, optionId: lowest.c.optionId } : null,
    fastest: fastest ? { quoteId: fastest.quoteId, optionId: fastest.c.optionId } : null,
  }
}

/** What an accepted choice charges: the option's price under the quote's GST mode (ADR-015 applies per option). */
export function quoteOptionCharge(input: { pricePaise: number; gstIncluded: boolean | null; commissionBps: number }) {
  return quoteChargeAmounts(input)
}
