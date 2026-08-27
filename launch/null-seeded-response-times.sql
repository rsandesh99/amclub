-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 1e (2026-08-27) — retire the SEEDED provider_profiles.median_response_minutes.
-- Those values were static seed data displayed to buyers with nothing computing
-- them. From now the nightly /api/v1/cron/provider-stats job derives the number
-- from real notified→quoted events (≥3 quotes) and NULLs everything else; the
-- UI renders nothing for NULL. Run once (idempotent). Already applied to prod.
-- ═══════════════════════════════════════════════════════════════════════════
update provider_profiles
   set median_response_minutes = null
 where median_response_minutes is not null;

select count(*) as providers, count(median_response_minutes) as with_value from provider_profiles;
