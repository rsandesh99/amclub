# ADR 007 — Goods RFQ rides the existing RFQ spine (kind='goods')

**Status:** Accepted for M2, 2026-09-06. Touches the RFQ/quote flow and the money path that an
accepted quote enters (§8.4: "one spine, two modes").

## Context

MART_DESIGN.md §7 M2 asks for bulk and spec-driven goods requests ("I need 500 M12 bolts,
grade 8.8, by the 15th") that verified sellers quote against, with the accepted quote becoming a
goods order. The services product already has an RFQ engine (§3.8: create → fan-out → up to
seven quotes in 72 h → accept → checkout session → webhook → order) with buyer/provider inboxes,
masked messaging, expiry and rescue copy, on web and mobile. Building a second request engine for
goods would duplicate all of it and create a second path into `orders`.

## Decision

1. **One table, one kind.** `rfqs.kind` ∈ {`service`, `goods`} (default `service`). A goods RFQ
   carries `mart_category_slug` (FK `mart_categories`) and `goods_spec` (jsonb, validated by
   `goodsRfqSpecSchema`: item, qty, unit, spec lines, brand preference, target unit price in
   paise, the delivery snapshot the eventual order will carry, optional originating listing).
   `category_id` becomes nullable **only** for goods; `rfqs_kind_shape_check` makes the two
   shapes mutually exclusive, so no existing services row or query changes meaning.
2. **Fan-out to sellers, never to the services graph.** A goods RFQ matches active,
   goods-activated (`sells_goods`), not-paused sellers in the buyer's state; sellers with an
   active listing in the request's Mart category first, else every in-state goods seller
   (a spec request is exactly the case where nobody lists the item yet). Services RFQs keep the
   `provider_categories` match unchanged. The 7-quote cap, 72 h expiry, `rfq_matches`,
   notifications and messaging are reused as-is.
3. **Quote price is server-computed.** A goods quote states a *unit* price excluding GST, the GST
   slab, the HSN code, optionally the seller's own listing and a different quantity (MOQ / pack
   rounding). The route sets `price_paise = qty × unit_price_paise`; the client's `price_paise`
   is ignored for goods. `quotes_goods_terms_check` enforces all-or-nothing terms and the
   identity in the database. Display money on the compare screen (GST, total incl. GST, after
   ITC) is computed in `lib/rfq/queries.ts`, never in a client (FRONTEND.md §8).
4. **Acceptance is an ordinary goods checkout.** `/api/v1/checkout {quoteId}` on a goods RFQ
   builds one `GoodsLineItem` from the spec + terms (`goodsQuoteLineItem`), the delivery
   snapshot from the spec, and `computeGoodsOrderAmounts` with the Mart category's commission;
   the session is `kind='goods'` with `line_items` + `delivery_snapshot`. From there nothing is
   new: webhook → `materialize_order` → goods workspace → release gate (the line carries
   `category_slug`, so the return window resolves without a listing) → `payout.ts`.
   A quote line with no listing has `product_id = NULL`; reorder skips it.
5. **Flag-gated and staged.** The goods branch of `/api/v1/rfq` 404s unless `MART_ENABLED`;
   the goods RFQ page calls `martPageGate()`. Migration 0024 is STAGED with 0022/0023 and
   deploys at the Launch Gate; `verify-migrations.ts` marks it `staged`.

## Consequences

- No second request engine, inbox, expiry job or messaging path. Mobile gains goods mode on the
  existing screens (create toggle, spec block, unit-price quote fields).
- The RFQ list/detail types gain `kind`, `martCategorySlug`, `goodsSpec`, and `quote.goods`;
  every services consumer sees `kind='service'` and `goods=null`.
- The order's `scope_snapshot` records `kind:'goods'`, the RFQ id and the seller name so the
  services workspace copy is never shown for a goods order born from a quote.
- Not now: multi-line goods RFQs (one item per request at M2), attachments on goods RFQs
  (drawings) — logged in FOLLOWUPS.md.
