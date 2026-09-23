-- Experience v3 (PRD E1 / N33) — the viewer's density preference.
-- NULL = the role default (buyers Comfortable; provider workspace, admin and
-- data views Compact). Written only by PATCH /api/v1/profile/preferences with
-- the service role (0042 revoked client writes on users; owner read stays).
-- Additive and nullable: no backfill. Rollback: ALTER TABLE users DROP COLUMN ui_density;

ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_density text;
--> statement-breakpoint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_ui_density_check;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_ui_density_check CHECK (ui_density IS NULL OR ui_density IN ('comfortable', 'compact'));
