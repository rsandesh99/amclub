-- Experience v3 E17 (N36, gated on D-UX2) — analytics consent. Built dark:
-- nothing reads or writes this until counsel decides consent is needed and the
-- NEXT_PUBLIC_ANALYTICS_CONSENT_REQUIRED build flag is on.
--
--   users.analytics_consent  { choice: granted | denied, version, at } for a
--                            signed-in person (visitors keep a first-party
--                            cookie). Written only by POST
--                            /api/v1/me/analytics-consent (service role; the
--                            users table has no client write grant, 0042).
--
-- Backfill: none (NULL = not asked yet). Rollback: ALTER TABLE users DROP COLUMN analytics_consent;

ALTER TABLE users ADD COLUMN IF NOT EXISTS analytics_consent jsonb;
