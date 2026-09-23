-- Experience v3 E3 — trust made visible (docs/prd/PRD_EXPERIENCE_V3.md §6 E3).
-- All additive. Everything user-visible stays behind flags (EXP_V3_TRUST and,
-- for the stats, agent_settings.public_stats_enabled = decision D1).
--
-- 1. provider_public_stats (N9): one row per provider, written nightly by
--    cron/provider-stats (service role). NO client grant: buyers only ever get
--    the gated view the API builds (publicStatsView in @amclub/shared), never
--    the raw row, and never the composite AMC Score (ADR-010).
-- 2. provider_verifications (N10 / F4): expiry + an evidence hash. Method and
--    date already exist (status api_verified | manually_approved, verified_at).
-- 3. provider_profiles (N11 / N12): provider-set next_available_on, capacity
--    slots for the derived availability, and logo moderation (a new logo waits
--    in logo_pending_url until an admin approves it into logo_url).
--
-- Rollback: DROP TABLE provider_public_stats; ALTER TABLE provider_verifications
-- DROP COLUMN expires_at, DROP COLUMN evidence_hash; ALTER TABLE provider_profiles
-- DROP COLUMN next_available_on, DROP COLUMN capacity_slots, DROP COLUMN logo_status,
-- DROP COLUMN logo_pending_url;

CREATE TABLE IF NOT EXISTS provider_public_stats (
  provider_id        uuid PRIMARY KEY REFERENCES provider_profiles(id) ON DELETE CASCADE,
  completed_orders   integer NOT NULL DEFAULT 0 CHECK (completed_orders >= 0),
  on_time_pct        numeric(5,2) CHECK (on_time_pct IS NULL OR (on_time_pct >= 0 AND on_time_pct <= 100)),
  on_time_n          integer NOT NULL DEFAULT 0 CHECK (on_time_n >= 0),
  repeat_buyer_pct   numeric(5,2) CHECK (repeat_buyer_pct IS NULL OR (repeat_buyer_pct >= 0 AND repeat_buyer_pct <= 100)),
  repeat_n           integer NOT NULL DEFAULT 0 CHECK (repeat_n >= 0),
  response_rate_pct  numeric(5,2) CHECK (response_rate_pct IS NULL OR (response_rate_pct >= 0 AND response_rate_pct <= 100)),
  response_n         integer NOT NULL DEFAULT 0 CHECK (response_n >= 0),
  computed_at        timestamptz NOT NULL DEFAULT now(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz
);
--> statement-breakpoint
ALTER TABLE provider_public_stats ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON provider_public_stats FROM anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS provider_public_stats_set_updated_at ON provider_public_stats;
--> statement-breakpoint
CREATE TRIGGER provider_public_stats_set_updated_at BEFORE UPDATE ON provider_public_stats
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE provider_verifications ADD COLUMN IF NOT EXISTS expires_at timestamptz;
--> statement-breakpoint
ALTER TABLE provider_verifications ADD COLUMN IF NOT EXISTS evidence_hash text;
--> statement-breakpoint
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS next_available_on date;
--> statement-breakpoint
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS capacity_slots integer NOT NULL DEFAULT 5;
--> statement-breakpoint
ALTER TABLE provider_profiles DROP CONSTRAINT IF EXISTS provider_profiles_capacity_slots_check;
--> statement-breakpoint
ALTER TABLE provider_profiles ADD CONSTRAINT provider_profiles_capacity_slots_check CHECK (capacity_slots BETWEEN 1 AND 50);
--> statement-breakpoint
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS logo_status text NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE provider_profiles DROP CONSTRAINT IF EXISTS provider_profiles_logo_status_check;
--> statement-breakpoint
ALTER TABLE provider_profiles ADD CONSTRAINT provider_profiles_logo_status_check CHECK (logo_status IN ('none', 'pending', 'approved', 'rejected'));
--> statement-breakpoint
ALTER TABLE provider_profiles ADD COLUMN IF NOT EXISTS logo_pending_url text;
--> statement-breakpoint
-- Public reads may see the availability date (like capacity_paused); moderation
-- state, the pending logo and the slot count stay server-side.
GRANT SELECT (next_available_on) ON public.provider_profiles TO anon, authenticated;
