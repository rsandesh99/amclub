# ADR 022 — order_safe_view applies the caller's RLS

**Status:** Accepted 2026-09-24. **Security hotfix**, touching auth and buyer personal data (CLAUDE.md §2.5 rule 1). Migration **0070**. Found by the Mart launch-readiness sweep of production views before the first real orders.

## Context

`order_safe_view` is `SELECT o.*, <buyer phone> FROM orders o`. It has no WHERE clause. Its purpose was to hide the buyer's phone from a provider until the provider accepts the order.

The view was created without `security_invoker`, so Postgres ran it with its owner's rights. The owner is `postgres`, which holds `BYPASSRLS`. Supabase's default privileges granted `SELECT` on every new view to `anon` and `authenticated`. Together:

- With only the public anon key, `GET /rest/v1/order_safe_view` returned **every order**: amounts, parties and scope. It also returned **every buyer's phone number**, because the masking branch only fires for the order's own provider.
- Any signed-in user could read any other party's orders the same way. The `orders` policies never applied, because the view never read `orders` as the caller.

Production had 0 orders when this was found, so nothing was exposed. The first paid order would have been.

No app code reads the view. The only reader is a fixture script, so nothing depended on the owner's rights.

## Decision

1. **`order_safe_view` is `security_invoker = true`.** The caller's RLS on `orders`, `users` and `msme_profiles` applies:
   - A party sees only their own orders; admin and ops see what their `orders` policy allows.
   - The phone column shows the buyer their own number, and admin / ops see it. It is `NULL` for everyone else, because `users` is readable only by its owner and by admin / ops (0042).
   - A provider no longer sees the buyer's phone after acceptance through this view. No surface used that. If a surface ever needs it, it goes through a `/api/v1` route that checks the order state.
2. **`anon` holds nothing on the view. `authenticated` holds `SELECT` only.** The view is auto-updatable, and `orders` writes are server-only (ADR 018).
3. **The same definition is in `rls/policies.sql` and the staged 0022 rebuild.** Every `DROP` + `CREATE` of the view is followed by the `REVOKE` and `GRANT`, because default privileges re-grant `ALL` on each new view. Re-running either file therefore keeps the view closed.
4. **`verify-authz` §7a5** proves it on every PR:
   - anon reads no rows;
   - a non-party buyer and a non-party provider read no rows of order A;
   - the buyer reads their own order (control);
   - the provider reads their own order with `msme_phone = NULL`;
   - a write through the view is denied, and the order is byte-identical afterwards.

The sweep checked the other public views too:

- **`public_providers`** stays a definer view on purpose. It selects fixed public columns of active providers only.
- **`buyer_pool_discipline_v1`** stays as ADR 006 designed it. It is readable by signed-in users only and holds counts per buyer.
- **`provider_score_inputs_v1`** is already `security_invoker`.

## Consequences

- A view over a table with RLS must be `security_invoker = true` unless it is a deliberate public projection like `public_providers`. A new definer view is review-blocking.
- **Deploy:** apply 0070 to production as soon as it merges. It touches no data.
- **Rollback** reopens the hole and is not recommended. The SQL is in the migration header.
