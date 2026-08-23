-- ═══════════════════════════════════════════════════════════════════════════
-- Prod copy of packages/db/src/migrations/0015_provider_depth.sql
-- WHERE TO RUN: Supabase Dashboard → AMClub project → SQL Editor.
-- Adds onboarding depth fields (years of experience, website). Safe to run
-- before or after the code deploy — the API writes these best-effort.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE provider_profiles
  ADD COLUMN IF NOT EXISTS years_experience text,
  ADD COLUMN IF NOT EXISTS website text;

GRANT SELECT (years_experience, website) ON provider_profiles TO anon, authenticated;

-- Verify
select column_name from information_schema.columns
 where table_name = 'provider_profiles'
   and column_name in ('years_experience', 'website');
