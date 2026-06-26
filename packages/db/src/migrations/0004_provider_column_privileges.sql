-- Phase-4 audit fix #1 — close PAN/GSTIN exposure on provider_profiles.
--
-- RLS is row-level: the "public read active" policy let anon/authenticated
-- SELECT EVERY column (including gstin, pan) of active providers. §5.7 requires
-- public reads to expose only safe columns. Postgres column privileges fix this
-- without removing the row policy (which the packages policy subquery depends on).
--
-- Revoke whole-table SELECT from anon + authenticated, then grant SELECT on the
-- safe columns only (everything EXCEPT gstin, pan). Owner/admin reads use the
-- service-role key (bypasses these grants); the public_providers view and the
-- SECURITY DEFINER search RPC run as definer and are unaffected.

REVOKE SELECT ON public.provider_profiles FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT (
  id, user_id, legal_name, display_name, slug, about, logo_url,
  state, city, languages, status, avg_rating, review_count, completed_orders,
  median_response_minutes, capacity_paused, top_rated,
  created_at, updated_at, deleted_at
) ON public.provider_profiles TO anon, authenticated;
