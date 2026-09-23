-- Experience v3 E2b — recently viewed (docs/prd/PRD_EXPERIENCE_V3.md FR-2.8, N8).
-- The last 20 provider / package pages a signed-in buyer opened, synced from
-- the device's own list. The owner reads and writes their rows (RLS); nothing
-- here is shown to anyone else. Written through /api/v1/me/recent-views with
-- the caller's session (upsert + keep 20).
--
-- Rollback: DROP TABLE recent_views;

CREATE TABLE IF NOT EXISTS recent_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('provider', 'package')),
  ref_id      uuid NOT NULL,
  viewed_at   timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz,
  CONSTRAINT recent_views_user_ref_uniq UNIQUE (user_id, kind, ref_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS recent_views_user_viewed_idx ON recent_views (user_id, viewed_at DESC);
--> statement-breakpoint
ALTER TABLE recent_views ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "recent_views: owner all" ON recent_views;
--> statement-breakpoint
CREATE POLICY "recent_views: owner all" ON recent_views
  FOR ALL USING (user_id = auth_user_id()) WITH CHECK (user_id = auth_user_id());
--> statement-breakpoint
REVOKE ALL ON recent_views FROM anon;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON recent_views TO authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS recent_views_set_updated_at ON recent_views;
--> statement-breakpoint
CREATE TRIGGER recent_views_set_updated_at BEFORE UPDATE ON recent_views
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
