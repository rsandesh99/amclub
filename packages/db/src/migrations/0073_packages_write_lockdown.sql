-- 0073 — Security hardening (architecture + security audit, 2026-09-24; ADR-025, part 2).
--
-- packages kept the default INSERT/UPDATE/DELETE grants under "provider crud own", so a
-- provider could write their own listings straight through PostgREST and skip everything
-- the partner routes check: the package Zod schema (price / discount / delivery bounds),
-- member_extra_discount_bps (member pricing is off), i18n_sources (a forged "approved
-- machine translation" badge), the soft-delete rule (a hard DELETE), and the catalog purge.
-- The partner routes now prove ownership on the session client and write with the service
-- role (same as package_addons / bundle_milestones / package_groups), so this revokes a
-- privilege nothing uses. Providers keep READ of their own rows.
--
-- ORDER: apply only after the build carrying the service-role partner routes is live;
-- before that, a provider's create / edit / pause would fail.
-- The same statements are mirrored in rls/policies.sql. verify-authz §7a6 proves it.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON packages FROM anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "packages: provider crud own" ON packages;
--> statement-breakpoint
DROP POLICY IF EXISTS "packages: provider read own" ON packages;
--> statement-breakpoint
CREATE POLICY "packages: provider read own" ON packages
  FOR SELECT USING (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));
