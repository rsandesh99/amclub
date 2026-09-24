# ADR 020 — Speed options on a quote: Economy · Standard · Express

**Status:** Accepted 2026-09-23. It follows the approved PRD Experience v3, E12b (N21, "ADR-XB"). It changes money, so it goes through §8.4: it adds a `verify-rfq` criterion (11) and ships dark behind `agent_settings.quote_options_enabled` (default off). It depends on ADR 018 (checkout sessions are server-written only).

## Context

Xometry quotes Economy / Standard / Express (XM-04), and Moglix offers 24 h against 5 days (MG-04). Buyers trade speed for price. Today a quote has one price and one delivery time, so the trade-off happens off-platform or not at all.

The rules this must keep (the E12 common rules):
- **One money path.** `quoteChargeAmounts` (ADR-015 / ADR-017) on the server, frozen into the checkout session; the webhook materialises the order.
- **No new order or quote states**, and no repurposed transitions.
- **No negotiation (§8.3).** The provider states every option before the buyer sees it. The buyer only picks, and there is no counter-offer.
- **The 7-quote cap is unchanged.** Options are not extra quotes.

## Decision

1. **The quote row IS the Standard option.** `price_paise` and `delivery_days` keep meaning Standard, so every existing reader keeps working unchanged: compare, loss labels, benchmarks, provider insights, mobile, the agents. A quote without options behaves exactly as before.
2. **`quote_options`** (migration 0066):

   | Column | Rule |
   |---|---|
   | `quote_id` | FK to `quotes` |
   | `revision` | the quote's revision the row belongs to |
   | `label` | `economy` \| `express` |
   | `price_paise` | > 0 |
   | `delivery_days` | 1–365 |

   - Unique per (quote, revision, label).
   - Rows are **immutable**. A revision (S1.3 PATCH, same optimistic lock and cap) writes a new set under the new revision number, so a checkout session frozen on an older row still resolves.
   - **Service role only**: no client grant; the API is the only reader and writer.

   The PRD lists `standard` as a label value. Here Standard is the quote itself, so storing it would duplicate the quote's own columns.
3. **Coherence** (shared `quoteOptionsProblems`, re-checked on the server; incoherent → **400 `options_incoherent`**):
   - Express is strictly faster and never cheaper than Standard.
   - Economy is strictly slower and never dearer.

   Options are services only (goods → 422) and allowed only while the switch is on (422 otherwise).
4. **Compare.** Shared `quoteChoices` gives each quote's choices. Each choice carries:
   - its checkout total, which is `quoteChargeAmounts` under the quote's GST mode (ADR-015 applies per option; the quote's `gst_included` covers all of them);
   - its flags: `compareQuotes` with that quote at that choice and every other quote at Standard.

   `choiceExtremes` gives the lowest and fastest across every choice. The page renders option chips, and the column's total, delivery and flags follow the picked chip. The client only picks, and every figure is the server's.
5. **Checkout.**
   - The quote branch takes `optionId`. The option must be this quote's, at its current revision, with the switch on; otherwise **404 `option_not_found`**, including an id from another quote.
   - The session is frozen on the option's price (`quoteChargeAmounts`) and days (the order's due date), with `checkout_sessions.quote_option_id` set.
   - A live session on another option of the same quote is another payment in flight, so it gets the existing 409 `rfq_checkout_in_progress`.
6. **Acceptance.**
   - `finalizeQuoteAcceptance` records `quotes.selected_option_id` from the frozen session. It is a separate best-effort write, so the acceptance itself never names a 0066 column.
   - N22 loss labels compare against the **winning option's** price and days.
7. **Provider form.** "Offer faster or cheaper options" is off by default. It adds Express and Economy rows in both the v3 and v2 forms, so a revision never drops options silently. Each row shows the buyer's all-in figure from the same server preview (FR-11.4).

## Consequences

- The buyer can trade speed for price with no negotiation, no new state, and no new money path. The payout is on the frozen order like every other order.
- Loss labels and "selected option" data let insights later say "you lost on speed" truthfully.
- A column's flags assume the other quotes stay at Standard. The lowest / fastest line covers every combination, so nothing the buyer can pick is hidden.
- **Rollback:**
  - Turn `quote_options_enabled` off. The form hides options, options are refused, compare shows Standard only, and checkout refuses an `optionId`.
  - Paid orders keep their frozen amounts.
  - Migration 0066 is additive, so it can stay.
