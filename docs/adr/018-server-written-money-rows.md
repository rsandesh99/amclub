# ADR 018 — Money and order-state rows are server-written only

**Status:** Accepted 2026-09-23. **Security hotfix**, touching money and auth (CLAUDE.md §2.5 rules 1, 2 and 8). Migration **0064**. Found while reading checkout for PRD Experience v3 E12a, which needs a frozen add-on snapshot on the checkout session that the client cannot rewrite.

## Context

Two holes, both reachable with the public anon key plus a user's own JWT, straight through PostgREST:

1. **`materialize_order()` could be called by any client.**
   - It is `SECURITY DEFINER` and kept the default `EXECUTE` for `PUBLIC` / `anon` / `authenticated`.
   - `POST /api/v1/checkout` returns the buyer's `razorpayOrderId`. The buyer could then call `/rest/v1/rpc/materialize_order` with a made-up payment id and amount, and get a `placed` order and a `captured` payment row **without paying**.
2. **Client roles kept the default table-wide write grants on the money and state tables.**
   - Only row policies stood in the way, and several are `FOR ALL` on the party's own rows.
   - The PostgREST probe below was confirmed against the migrations' schema. It showed:
     - A **provider** could `PATCH` their own order to `status = 'completed'` and raise `provider_earning_paise`. The payout amount is read from that column.
     - A **buyer** could rewrite their own order's `total_paise`.
     - A **buyer** could rewrite an unpaid checkout session's provider / commission / earning split, which `materialize_order` copies into the order. They could also plant a session under an idempotency key before the route bound it.
     - A **party** could rewrite a dispute, and a **provider** could change any column of a review about them.

   The state machine (rule 8) and "webhooks as payment truth" (rule 2) only held for callers who used the API.

What limited the damage: `PAYOUT_AUTO_RELEASE` is off, so every payout is created `held` behind an admin release. Even so, a held payout's amount was the tampered one.

## Decision

1. **EXECUTE on `materialize_order`** (and on the admin-only helpers `claim_quote_slot`, `release_quote_slot` and `increment_coupon_usage`) belongs to `service_role` only. `CREATE OR REPLACE` keeps a function's ACL, so the staged Mart 0022 version (same signature) inherits this.
2. **No client role holds INSERT / UPDATE / DELETE** on:
   - `orders`, `checkout_sessions`, `payments`, `payouts`, `refunds`, `invoices`;
   - `disputes`, `order_documents`;
   - `rfqs`, `quotes`, `rfq_matches`;
   - `coupons`, `coupon_redemptions`;
   - `provider_bank_accounts`, `reviews`.

   Reads are unchanged, because the existing SELECT policies still decide what a party sees. `rls/policies.sql` mirrors the revoke.
3. **Every writer is a `/api/v1` route or a job on the service role.**
   - An audit on 2026-09-23 checked every `.from(<table>).insert/update/upsert/delete` in apps/web and apps/mobile.
   - Only three routes wrote through the user's client. They move to the service role, each after its existing authorisation:
     - **`POST /api/v1/checkout`** and **`POST /api/v1/mart/checkout`**: the session upsert and the `razorpay_order_id` bind. The route has already resolved the caller's own buyer profile, and their own RFQ on the quote branch. The idempotency reads stay on the user's client, so RLS still scopes them.
     - **`POST /api/v1/orders/[id]/review`**: the route now checks the caller is the order's **buyer** (not merely a party) and that the order is `completed`, then inserts.
4. **`verify-authz` §7a** proves it on every PR:
   - a provider cannot complete their own order or raise its earning;
   - a buyer cannot rewrite an order total;
   - a buyer cannot rewrite or insert a checkout session;
   - a buyer cannot call `materialize_order` on their own unpaid session (no order, session untouched);
   - a buyer cannot close an RFQ directly, and a provider cannot reprice a quote directly;
   - a buyer cannot insert a review directly, and a provider cannot insert a payout;
   - the order is byte-identical afterwards.

## Consequences

- The API is the only way to change money or order state. Transition maps, caps and idempotency now bind every caller.
- A future feature that needs a client write on one of these tables must go through a route. A new grant here is review-blocking.
- **Deploy:** apply 0064 to production as soon as it merges. Nothing in the app depends on the old grants.
- **Rollback** reopens the holes and is not recommended. It is grants only; no data is touched. The SQL is in the migration header.
