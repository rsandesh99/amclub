# ADR 017 — One number per quote: compare shows what checkout charges

**Status:** Accepted 2026-09-23. It follows the approved PRD Experience v3, E11 FR-11.4, whose acceptance says: "for the same quote, the quote preview equals the compare normalised total and the checkout amount; a shared test covers `gst_included` = true / false / null".

It touches money **display** only: no charged amount changes (§8.4). It follows ADR-015 (GST-inclusive quotes).

## Context

A services quote says whether its price includes GST: `quotes.gst_included` is `true`, `false` or `null` (unstated).

- **Checkout** (the quote branch of `POST /api/v1/checkout`) has always done two things:
  - `true`: carves GST out (ADR-015).
  - `false` or `null`: adds GST on top.
  - The buyer's confirm sheet says GST is applied at checkout.
- **The compare screen** (`compareQuotes`, S1.2) also treated `true` / `false` that way, but normalised `null` as "GST unstated — not added". An unstated ₹10,000 quote was therefore totalled at ₹10,000 on compare and charged ₹11,800 at checkout.
- **E11's quote preview** ("Buyer sees ₹4,500 + 18 % GST = ₹5,310 all-in") has to state one number. Whichever rule it picks would contradict one of the other two screens.

## Decision

1. **One function.** Shared `quoteChargeAmounts({ pricePaise, gstIncluded, commissionBps })` is the rule: `true` → `computeGstInclusiveOrderAmounts`; otherwise → `computeOrderAmounts`. These uses call it:
   - checkout's quote branch (a refactor, no behaviour change);
   - the provider preview (`POST /api/v1/rfq/[id]/quote/preview`);
   - the shared test that pins compare to it.
2. **Compare follows the charge.**
   - `compareQuotes` now adds GST on top for `null`, exactly as for `false`.
   - The `gst_unstated` flag stays, so the buyer still sees that the provider didn't say. The note becomes `gst_added` with the amount.
   - The `gst_assumed_none` note is retired.
3. **New v3 quotes state GST.** The v3 quote form makes GST a required choice: Extra or Included. "Not applicable" appears only when ADR-016 (GST-exempt providers) is accepted, because today no provider can legally charge without GST.

## Consequences

- A buyer never sees a quote cheaper on compare than it charges.
- The "cheapest after normalisation" flag can move between quotes where one was unstated. That is correct: it now ranks what the buyer will actually pay.
- Pointer agents (S1.2) read the same normalised totals, so their sentences follow automatically. They carry no numbers of their own.
- Rollback: revert the `compareQuotes` null branch. Checkout is untouched either way.
