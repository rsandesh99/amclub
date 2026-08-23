-- Provider onboarding depth (launch-day, 2026-08-23): years of experience and
-- website/portfolio captured at signup. Both are public-safe profile facts.
-- The API writes them best-effort, so deploy order vs. this migration is safe.
ALTER TABLE provider_profiles
  ADD COLUMN IF NOT EXISTS years_experience text,
  ADD COLUMN IF NOT EXISTS website text;
--> statement-breakpoint
-- Column privileges: 0004 switched provider_profiles to an explicit safe-column
-- GRANT list; new public-safe columns must be granted or nobody can read them.
GRANT SELECT (years_experience, website) ON provider_profiles TO anon, authenticated;
