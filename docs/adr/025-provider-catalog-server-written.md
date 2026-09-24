# ADR 025 — Provider and catalog rows are server-written only

**Status:** Accepted 2026-09-24. **Security hotfix**, touching auth, provider verification and the public catalog (CLAUDE.md §2.5 rule 1). Migrations **0072** (urgent, no code dependency) and **0073** (after the partner-route build is live). Amends ADR 022's note on `public_providers` and `buyer_pool_discipline_v1`. Found by the architecture and security audit of 2026-09-24 (`docs/audit/2026-09-24-architecture-security-audit.md`, findings C1–C4).

## Context

Supabase's default privileges grant `ALL` on every new table and view to `anon` and `authenticated`. ADR 018 revoked client writes on the money and order-state tables. The provider and catalog tables were never covered. The audit confirmed four holes, and a read-only catalog query on production confirmed the grants were live:

1. **`public_providers` was writable with the public anon key.** It is an auto-updatable view (one table, plain columns, a simple WHERE) that runs as its owner, so the RLS on `provider_profiles` never applied to writes through it. It kept the default `ALL` grant. Anyone holding the anon key, which ships in every page, could rename any active provider, set `avg_rating` / `top_rated`, pause them (`capacity_paused`), or `DELETE` them outright. ADR 022 had reviewed this view for reads only.
2. **Any signed-in user could make themselves a provider.** `provider_profiles` kept the `INSERT/UPDATE/DELETE` grants under an `owner all` policy. A buyer could insert their own profile with `status = 'active'` and skip the verification queue. An existing provider could lift a suspension, set `sells_goods` (the GSTIN gate for Mart) or `udyam_verified`, forge ratings, or hard-delete their row (§2.5 rule 4).
3. **`provider_categories`** had the same `owner all` shape, so a provider could join a credential-gated category (legal, CA) directly, and fan-out would send them those requests.
4. **Mart `products` / `price_tiers`** (`seller crud own`) let a seller publish a listing as `active`, skipping `pending_approval`, the typed-attribute validation and the price rules.
5. **`packages`** (`provider crud own`) let a provider skip the package schema (price, discount and delivery bounds), set `member_extra_discount_bps` although member pricing is off, forge an approved machine translation (`i18n_sources`), hard-delete a listing, and skip the catalog purge.
6. **`buyer_pool_discipline_v1`** is a definer view granted to every signed-in user, so any buyer could read every other buyer's pool commitment and default counts.

Every legitimate writer of these rows is already a `/api/v1` route or job on the service role after its own authorisation. The one exception was `/api/v1/partner/packages`, which wrote `packages` with the session client and relied on the RLS policy.

## Decision

1. **`public_providers` is `SELECT` only** for `anon` and `authenticated` (0072). It stays a definer view, because it is a deliberate public projection of fixed columns of active providers.
2. **No client role holds `INSERT`, `UPDATE`, `DELETE` or `TRUNCATE`** on `provider_profiles`, `provider_categories`, `products` or `price_tiers` (0072), or on `packages` (0073). The `owner all` / `crud own` policies become owner `SELECT` policies. The public read policies are unchanged.
3. **`buyer_pool_discipline_v1` is `security_invoker = true` with no client grant** (0072). Its one reader, `lib/mart/pools.ts`, uses the service role.
4. **The partner package routes check ownership on the session client, then write with the service role.** This is the same pattern as `package_addons` (ADR 019), `bundle_milestones` (ADR 021) and `package_groups`. POST, PATCH, the status toggle and the soft DELETE all changed. A full edit that pauses is now one write instead of two.
5. **Two migrations, because of deploy order.** 0072 revokes privileges no code uses, so it can be applied to production at once. 0073 needs the service-role partner routes to be live first; applied earlier, a provider's create, edit or pause would fail.
6. **The same statements are mirrored in `rls/policies.sql`,** so a bootstrap or a re-run keeps the tables closed.
7. **Proof on every PR:**
   - `verify-authz` §7a6 (direct PostgREST): anon and a buyer cannot write through `public_providers`; a provider cannot rewrite, soft-delete or hard-delete their profile; an outsider cannot register an active profile; category joins and leaves are denied; direct package writes are denied; Mart product and tier writes are denied; `buyer_pool_discipline_v1` is unreadable. A denial here must be an error, not zero rows, because a missing grant fails at plan time. Controls: the owner still reads their profile and package, and the status toggle still works through the route.
   - `verify-experience` E2b: the owner's PATCH (edit and pause), restore and soft DELETE work through the routes, and another provider's PATCH is a 404.

## Consequences

- Every table and view needs an explicit grant decision. A new table without `REVOKE INSERT, UPDATE, DELETE ... FROM anon, authenticated` is review-blocking unless the client is meant to write it, and then its policy must say exactly which columns and rows.
- A new auto-updatable view needs `REVOKE ALL` and then `GRANT SELECT`, whether or not it is `security_invoker`.
- **Deploy:** apply 0072 to production immediately; it touches no data. Apply 0073 once the build with the service-role partner routes is serving production.
- **Rollback** reopens the holes and is not recommended. If a legitimate client write turns up, move it to a `/api/v1` route rather than re-granting.
