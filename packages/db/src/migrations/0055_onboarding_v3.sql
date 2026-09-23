-- Experience v3 E10 (docs/prd/PRD_EXPERIENCE_V3.md FR-10.4, N27c) — provider
-- onboarding progress and the stall nudge. Dark behind EXP_V3_ONBOARDING.
--
--   provider_onboarding_progress  one row per applicant: the last step saved,
--                                 its category and when it was submitted. The
--                                 v3 wizard writes it through /api/v1 on every
--                                 step; POST /profile/provider stamps submitted_at.
--   onboarding_nudges             one row per nudge (at most 2 per applicant);
--                                 the primary key (user_id, nudge_no) makes the
--                                 hourly cron idempotent.
--
-- Both are service-role only (no client grants). The PAN path (N27b:
-- provider_profiles.gst_registered, pan_verified_at) is NOT here — it waits on
-- D3 and ADR-016.
--
-- Rollback: DROP TABLE onboarding_nudges, provider_onboarding_progress;

CREATE TABLE IF NOT EXISTS provider_onboarding_progress (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  step           text NOT NULL CHECK (step IN ('contact', 'business', 'credentials_bank', 'review')),
  category_slug  text,
  submitted_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS provider_onboarding_progress_stall_idx ON provider_onboarding_progress (updated_at) WHERE submitted_at IS NULL;
--> statement-breakpoint
ALTER TABLE provider_onboarding_progress ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON provider_onboarding_progress FROM anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS provider_onboarding_progress_set_updated_at ON provider_onboarding_progress;
--> statement-breakpoint
CREATE TRIGGER provider_onboarding_progress_set_updated_at BEFORE UPDATE ON provider_onboarding_progress
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS onboarding_nudges (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nudge_no    integer NOT NULL CHECK (nudge_no IN (1, 2)),
  step        text NOT NULL CHECK (step IN ('contact', 'business', 'credentials_bank', 'review')),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, nudge_no)
);
--> statement-breakpoint
ALTER TABLE onboarding_nudges ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON onboarding_nudges FROM anon, authenticated;
