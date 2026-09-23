# ADR 015 — A quote marked "GST included" is charged exactly its price

**Status:** Accepted 2026-09-23 (founder delegated the decision). Touches money
(§8.4). Closes hardening item **H5** from the S3.3 prompt and the
`docs/USER_EXPECTATIONS_AUDIT.md` "Still open" line about GST-included quotes.
Numbering: 011–013 are reserved by `BUILD_PROMPTS.md`; 014 is dispute settlement
safety.

## Context

Providers state on each services quote whether the price includes GST
(`quotes.gst_included`: `true` / `false` / `null` = unstated, since Phase 4b). The
compare screen already reads that flag. Its normalised total takes an included
price as-is and adds GST only when the quote says GST is **not** included
(`compareQuotes`, shared `compare.ts`).

Checkout ignored the flag. The quote branch of `POST /api/v1/checkout` always ran
`computeOrderAmounts({ pricePaise: quote.price_paise })`, which adds 18 % on top.
A provider who quoted "₹11,800, GST included" had the buyer charged ₹13,924: 18 %
more than the provider's own stated price, and more than the compare screen's
total. This is live code on the money path.

## Decision

1. **Included (`true`) → carve GST out, never add it.** The new shared function
   `computeGstInclusiveOrderAmounts({ grossPaise, commissionBps })`:
   - `taxable = round(gross × 10000 / (10000 + gstBps))` and `gst = gross − taxable`.
   - `total = gross`, exactly: the buyer pays the quoted figure.
   - Commission and the provider's earning are computed on `taxable`, as for every
     other order. `pricePaise` is the pre-GST price, so every order column means
     the same thing whichever way the provider quoted.
   - Worked example: ₹11,800 incl. GST at 10 % commission → taxable ₹10,000,
     GST ₹1,800, commission ₹1,000, provider earns ₹9,000, buyer pays ₹11,800.
2. **Not included (`false`) → unchanged.** GST is added on top.
3. **Unstated (`null`) → unchanged.** GST is added on top. The accept confirm sheet
   already says "GST is applied at checkout — the payment screen shows the exact
   amount before you pay", and the compare screen flags the quote "GST unstated".
   Treating unstated as included would cut the provider's earning by about 15 %
   on a term they never stated. Making an unstated quote block checkout is a
   possible later tightening; it needs its own §8.1 entry.
4. **The confirm sheet tells the truth.** For an included quote it labels the
   figure "Quoted price (incl. GST)" and says this is exactly what the buyer pays
   (en and hi). Other quotes keep the existing "GST is applied at checkout" note.

Goods quotes are untouched: they state a GST slab and HSN, and use their own math
(`computeGoodsOrderAmounts`).

## Consequences

- An included quote's order has a lower `price_paise` / `provider_earning_paise`
  than before, and a total equal to what the provider quoted. Benchmarks (S3.2)
  read pre-GST order prices, so included and excluded quotes now land on the same
  scale.
- Orders already paid under the old math are not changed. This ADR does not
  refund past overcharges; if any real included-quote orders exist, ops reviews
  them by hand (find them via `orders.quote_id → quotes.gst_included = true`).

## Verification

- Shared money tests: the worked example, the old vs new total (₹13,924 vs
  ₹11,800), exclusive ↔ inclusive round-trip equality, and invariants over a grid
  of amounts × GST rates × commissions (`total = gross`,
  `taxable + gst = gross`, integer paise, GST within 1 paisa of the exclusive
  formula).
- `verify-rfq.ts` criterion **3c** (checkout for the rig's GST-included quote
  charges exactly its price). It runs in the `Money rigs · disposable Supabase`
  CI job (H1, PR #25); first green run 2026-09-23, `verify-rfq` 15/15.

## Rollback

Revert the commit. There is no migration.
