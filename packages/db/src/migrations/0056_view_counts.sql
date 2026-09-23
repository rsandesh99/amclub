-- Experience v3 E11 (docs/prd/PRD_EXPERIENCE_V3.md FR-11.1 / 11.5, N29) —
-- daily view counts for provider profiles and packages, the top of the
-- provider's funnel ("Views 212 → Matched 14 → Quoted 9 → Won 3").
--
-- Written ONLY by bump_view_count() (SECURITY DEFINER, service role) from the
-- rate-limited POST /api/v1/views beacon, which skips bots and the owner's
-- own views and counts a visitor once per subject per day. A provider reads
-- only their own rows (RLS); nobody else reads them.
--
-- Rollback: DROP FUNCTION bump_view_count(text, uuid, date); DROP TABLE view_counts_daily;

CREATE TABLE IF NOT EXISTS view_counts_daily (
  subject_kind  text NOT NULL CHECK (subject_kind IN ('provider', 'package')),
  subject_id    uuid NOT NULL,
  provider_id   uuid NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  day           date NOT NULL,
  views         integer NOT NULL DEFAULT 0 CHECK (views >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_kind, subject_id, day)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS view_counts_daily_provider_day_idx ON view_counts_daily (provider_id, day);
--> statement-breakpoint
ALTER TABLE view_counts_daily ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "view_counts_daily: provider reads own" ON view_counts_daily;
--> statement-breakpoint
CREATE POLICY "view_counts_daily: provider reads own" ON view_counts_daily
  FOR SELECT USING (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));
--> statement-breakpoint
REVOKE ALL ON view_counts_daily FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON view_counts_daily TO authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS view_counts_daily_set_updated_at ON view_counts_daily;
--> statement-breakpoint
CREATE TRIGGER view_counts_daily_set_updated_at BEFORE UPDATE ON view_counts_daily
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- +1 view of an ACTIVE provider or package on p_day. Unknown / inactive subjects count nothing.
CREATE OR REPLACE FUNCTION bump_view_count(p_kind text, p_id uuid, p_day date) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE owner uuid;
BEGIN
  IF p_kind = 'provider' THEN
    SELECT id INTO owner FROM provider_profiles WHERE id = p_id AND status = 'active';
  ELSIF p_kind = 'package' THEN
    SELECT p.provider_id INTO owner FROM packages p WHERE p.id = p_id AND p.status = 'active';
  END IF;
  IF owner IS NULL THEN RETURN false; END IF;
  INSERT INTO view_counts_daily (subject_kind, subject_id, provider_id, day, views)
  VALUES (p_kind, p_id, owner, p_day, 1)
  ON CONFLICT (subject_kind, subject_id, day) DO UPDATE SET views = view_counts_daily.views + 1;
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION bump_view_count(text, uuid, date) FROM PUBLIC, anon, authenticated;
