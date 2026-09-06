# ADR 005 — AMC Mart is a flag-gated dark build on the ONE order spine

**Status:** Accepted (founder direction via MART_DESIGN.md §0), 2026-09-05. Touches money, the order state machine, and auth (§8.4).

## Context

AMC Mart (goods mode) adds fixed-price catalog purchase of industrial consumables to the live services marketplace. MART_DESIGN.md §0 is explicit: same monorepo, same schema lineage, one spine, two modes — a second identity / payment / event / admin system is a design violation. The build must not change any live services behaviour while `MART_ENABLED=false`, and its migrations must not reach prod until the Launch Gate.

The instruction that opened this session also asked for "a new repo on GitHub". That conflicts with §0 ("NOT a new app, NOT a new repo") and with everything the goods mode reuses (payout.ts, readiness.ts, the append-only event tables, the admin shell). A second repository would fork the money path.

## Decision

1. **No new repository.** Mart lives in `rsandesh99/amclub` on a feature branch; it is a dark build behind the existing `MART_ENABLED` flag (`lib/flags.ts`). Every Mart page calls `martPageGate()` and every Mart route calls `martApiGate()` first — the surfaces do not exist while the flag is off.
2. **Sellers are providers; goods orders are orders.** `provider_profiles.sells_goods` is the only new identity fact (gated on a verified, non-stub `gstin_verifications` row). Goods orders are `orders` rows with `kind='goods'`, `line_items`, `delivery_snapshot`, created by the same `checkout_sessions → gateway order → webhook → materialize_order` path.
3. **Goods actions map onto the existing §3.7 transitions and never repurpose one.** `dispatch` performs `accepted → requirements_submitted → in_progress` (two legal steps, both emitted); returns use `delivered | completed → disputed` and the existing dispute console; cancellation stays `placed | accepted`.
4. **Money stays in payout.ts / processRefund / generateInvoices.** The only goods addition is a *release gate* (delivery photo, receipt or 72h auto-receipt, per-category return window clear, no open return) evaluated from `order_events`. It adds hold reasons in `schedulePayout` and makes the admin release route refuse (409) while it holds. `PAYOUT_AUTO_RELEASE` stays off; the founder taps release.
5. **Money math is per line.** `computeGoodsOrderAmounts` rounds GST and commission per line (mixed HSN slabs and per-category commission), then sums; totals, commission, and provider earning obey the same split as services so the fee-headroom guard and invoices apply unchanged.
6. **Migration 0022 is staged.** It ships in the normal migrations directory, bootstraps cleanly in the chain, and is applied to prod together with the `MART_ENABLED=true` deploy (RULES.md rule 2's intent restored at launch). `policies.sql`'s Mart block is guarded so it remains re-runnable against prod before then.
7. **Every AI proposal a human confirms is logged** to the append-only `ai_decisions` table from M0 (cannot be backfilled).

## Consequences

- Shared-file edits are limited to explicit `kind === 'goods'` branches (`transitions.ts`, `resolve.ts`, `generate.ts`, `admin/payouts/[id]`, `OrderWorkspace.tsx`, `materialize_order`) and are covered by inertness checks: the shared unit test pinning the services machine, `killtest-mart-schema.ts` (services `materialize_order` output byte-identical), and `verify-mart-inert.ts`.
- Services hotfixes outrank Mart work; the branch is rebased on `master` frequently.
- Reversal: setting `MART_ENABLED=false` removes every surface instantly; 0022 is additive and stays (nullable/defaulted columns, empty tables).
