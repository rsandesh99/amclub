-- Services evidence engine (BUILD_PROMPTS S0.3) — additive, idempotent, NOT
-- staged (apply to prod before/with the writer, RULES.md 2). order_milestones
-- (0000: title/status/completed_at/sort) is unused by app code; this gives it
-- the evidence shape: an ordered kind, a required proof photo, a note, and who
-- captured it. The payout release gate reads these exactly as the goods gate
-- reads delivery photos (evaluateServicesReleaseGate in @amclub/shared).

ALTER TABLE order_milestones ADD COLUMN IF NOT EXISTS kind text;
--> statement-breakpoint
ALTER TABLE order_milestones ADD COLUMN IF NOT EXISTS photo_doc_id uuid REFERENCES order_documents(id);
--> statement-breakpoint
ALTER TABLE order_milestones ADD COLUMN IF NOT EXISTS note text;
--> statement-breakpoint
ALTER TABLE order_milestones ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);
--> statement-breakpoint
-- MILESTONE_KINDS (@amclub/shared). NULL allowed for the legacy title-only rows.
ALTER TABLE order_milestones DROP CONSTRAINT IF EXISTS order_milestones_kind_check;
--> statement-breakpoint
ALTER TABLE order_milestones ADD CONSTRAINT order_milestones_kind_check
  CHECK (kind IS NULL OR kind IN ('accepted', 'site_or_materials', 'in_progress', 'work_complete'));
--> statement-breakpoint
-- Each evidence kind at most once per order (the machine also enforces order).
CREATE UNIQUE INDEX IF NOT EXISTS order_milestones_order_kind_uniq
  ON order_milestones (order_id, kind) WHERE kind IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS order_milestones_order_sort_idx ON order_milestones (order_id, sort);
--> statement-breakpoint
-- Tighten RLS: order parties READ; writes go through the route (service role).
-- (0000 shipped a "parties all" policy; order_milestones was never written by
-- app code, so narrowing to read-only is safe.)
DROP POLICY IF EXISTS "order_milestones: parties all" ON order_milestones;
--> statement-breakpoint
DROP POLICY IF EXISTS "order_milestones: parties read" ON order_milestones;
--> statement-breakpoint
CREATE POLICY "order_milestones: parties read" ON order_milestones
  FOR SELECT USING (
    order_id IN (
      SELECT id FROM orders
      WHERE msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
         OR provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
    )
  );
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON order_milestones FROM anon, authenticated;
