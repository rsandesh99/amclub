-- Experience v3 E4 — packages and honest pricing (docs/prd/PRD_EXPERIENCE_V3.md §6 E4).
-- Additive. A package with no group renders exactly as before; tier UI is
-- behind EXP_V3_PACKAGES.
--
-- 1. package_groups (N14): up to three packages of one provider shown as
--    Basic / Standard / Premium with a comparison matrix (≤ 12 rows).
-- 2. packages: group_id, tier, the "Choose this if…" line, per-row values.
-- 3. Government dependency (N17): category default + per-package override.
--
-- Rollback: DROP TRIGGER packages_group_same_provider ON packages; DROP FUNCTION
-- packages_group_same_provider(); ALTER TABLE packages DROP CONSTRAINT
-- packages_ideal_for_check, DROP COLUMN group_id, DROP COLUMN tier,
-- DROP COLUMN ideal_for_i18n, DROP COLUMN compare_values, DROP COLUMN
-- govt_dependent_override; ALTER TABLE categories DROP COLUMN govt_dependent;
-- DROP TABLE package_groups;

CREATE TABLE IF NOT EXISTS package_groups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id   uuid NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  category_id   uuid NOT NULL REFERENCES categories(id),
  service_slug  text,
  title_i18n    jsonb NOT NULL,
  compare_rows  jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(compare_rows) = 'array' AND jsonb_array_length(compare_rows) <= 12),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz,
  deleted_at    timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS package_groups_provider_idx ON package_groups (provider_id) WHERE deleted_at IS NULL;
--> statement-breakpoint
ALTER TABLE package_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "package_groups: public read active" ON package_groups;
--> statement-breakpoint
CREATE POLICY "package_groups: public read active" ON package_groups
  FOR SELECT USING (
    deleted_at IS NULL
    AND provider_id IN (SELECT id FROM provider_profiles WHERE status = 'active' AND deleted_at IS NULL)
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "package_groups: provider read own" ON package_groups;
--> statement-breakpoint
CREATE POLICY "package_groups: provider read own" ON package_groups
  FOR SELECT USING (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));
--> statement-breakpoint
-- Writes go through /api/v1/partner/package-groups with the service role only.
REVOKE INSERT, UPDATE, DELETE ON package_groups FROM anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS package_groups_set_updated_at ON package_groups;
--> statement-breakpoint
CREATE TRIGGER package_groups_set_updated_at BEFORE UPDATE ON package_groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE packages ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES package_groups(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE packages ADD COLUMN IF NOT EXISTS tier text;
--> statement-breakpoint
ALTER TABLE packages DROP CONSTRAINT IF EXISTS packages_tier_check;
--> statement-breakpoint
ALTER TABLE packages ADD CONSTRAINT packages_tier_check CHECK (tier IS NULL OR tier IN ('basic', 'standard', 'premium'));
--> statement-breakpoint
ALTER TABLE packages ADD COLUMN IF NOT EXISTS ideal_for_i18n jsonb;
--> statement-breakpoint
ALTER TABLE packages ADD COLUMN IF NOT EXISTS compare_values jsonb;
--> statement-breakpoint
ALTER TABLE packages ADD COLUMN IF NOT EXISTS govt_dependent_override boolean;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS packages_group_tier_uniq ON packages (group_id, tier) WHERE group_id IS NOT NULL AND deleted_at IS NULL;
--> statement-breakpoint
-- Providers may UPDATE their own packages under RLS ("packages: provider crud
-- own"), so the database itself keeps a package out of another provider's
-- group: a package joins only a group of the SAME provider. SECURITY DEFINER
-- so the check sees the group whatever the caller's RLS view.
CREATE OR REPLACE FUNCTION packages_group_same_provider() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM package_groups g WHERE g.id = NEW.group_id AND g.provider_id = NEW.provider_id) THEN
    RAISE EXCEPTION 'package_group_other_provider' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS packages_group_same_provider ON packages;
--> statement-breakpoint
CREATE TRIGGER packages_group_same_provider BEFORE INSERT OR UPDATE OF group_id, provider_id ON packages
  FOR EACH ROW WHEN (NEW.group_id IS NOT NULL) EXECUTE FUNCTION packages_group_same_provider();
--> statement-breakpoint
ALTER TABLE packages DROP CONSTRAINT IF EXISTS packages_ideal_for_check;
--> statement-breakpoint
ALTER TABLE packages ADD CONSTRAINT packages_ideal_for_check CHECK (
  ideal_for_i18n IS NULL OR (
    jsonb_typeof(ideal_for_i18n) = 'object'
    AND char_length(coalesce(ideal_for_i18n->>'en', '')) <= 90
    AND char_length(coalesce(ideal_for_i18n->>'hi', '')) <= 90
  )
);
--> statement-breakpoint
ALTER TABLE categories ADD COLUMN IF NOT EXISTS govt_dependent boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Registrations and licences wait on government portals (MCA, state licensing).
UPDATE categories SET govt_dependent = true WHERE slug IN ('company-registrations', 'government-licensing') AND govt_dependent = false;
