-- AMC Mart M1 — group-buy pools (MART_DESIGN.md §4.4, §4.5, §5).
-- ═══════════════════════════════════════════════════════════════════════════
-- STAGED MIGRATION — DARK BUILD. Do NOT apply to prod during the build.
-- Applies together with the MART_ENABLED=true deploy at the Launch Gate (§8.2),
-- after 0022. Local / preview: apply normally (bootstrap or run-migration).
-- ═══════════════════════════════════════════════════════════════════════════
-- Additive only. Every new table is RLS'd from birth and mirrored in
-- rls/policies.sql. pool_events is append-only under the quote_events regime.
-- No services table or function changes at all: the pay-on-close mechanic
-- (ADR-006) creates ordinary kind='goods' checkout sessions, which the
-- unchanged materialize_order turns into ordinary goods orders.

-- ─── 1. Config keys (founder decisions §9.1/§9.4 live HERE, never in code) ──
INSERT INTO mart_settings (key, value) VALUES
  -- pay_on_close (launch; ADR-006) | block_capture (adapter; enable only after
  -- the PSP report's live verification — docs/mart/PSP_BLOCK_CAPTURE_REPORT.md)
  ('pool_payment_mode', '"pay_on_close"'),
  -- Hours a member has to pay their goods order after the pool closes met.
  ('pool_pay_window_hours', '48'),
  -- §9.1: one goods order per member (the only model that reuses every money path).
  ('pool_order_model', '"per_member"'),
  -- §9.4: launch pool categories (3 consumables) — founder edits this list.
  ('pool_categories', '["fasteners","welding-consumables","abrasives"]'),
  -- Group-Buy Agent schedule: draft one pool per pool category on this day of month.
  ('pool_schedule_day_of_month', '1'),
  -- Open window limits the founder can set when approving a draft.
  ('pool_open_limits', '{"min_open_hours": 24, "max_open_days": 30}')
ON CONFLICT (key) DO NOTHING;

-- ─── 2. pools ────────────────────────────────────────────────────────────────
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS pools (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The listing the pool is for (seller = the product's seller). Nullable per
  -- §4.4 (category + spec pools awarded later); opening REQUIRES a product.
  product_id       uuid REFERENCES products(id) ON DELETE SET NULL,
  category_slug    text NOT NULL REFERENCES mart_categories(slug),
  spec             jsonb,
  title            text NOT NULL,
  unit             text NOT NULL,
  target_qty       integer NOT NULL,
  min_qty          integer NOT NULL,
  unit_price_paise bigint NOT NULL,
  closes_at        timestamptz NOT NULL,
  -- draft | open | closed_met | closed_unmet | ordered | fulfilled | cancelled
  -- ('draft' precedes the §4.4 machine: agent-drafted, founder approves → open)
  status           text NOT NULL DEFAULT 'draft',
  seller_id        uuid REFERENCES provider_profiles(id) ON DELETE SET NULL,
  created_by       uuid REFERENCES users(id),
  approved_by      uuid REFERENCES users(id),
  approved_at      timestamptz,
  closed_at        timestamptz,
  -- Group-Buy Agent rationale (demand-signal refs, schedule tag) — refs only.
  rationale        jsonb NOT NULL DEFAULT '{}',
  -- Founder-confirmed vernacular card line per locale (from ai_decisions 'pool_card').
  card_i18n        jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz,
  deleted_at       timestamptz,
  CONSTRAINT pools_status_check CHECK (status IN ('draft','open','closed_met','closed_unmet','ordered','fulfilled','cancelled')),
  CONSTRAINT pools_qty_check CHECK (target_qty > 0 AND min_qty > 0 AND min_qty <= target_qty),
  CONSTRAINT pools_price_check CHECK (unit_price_paise > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pools_status_closes_idx ON pools (status, closes_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pools_product_idx ON pools (product_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pools_seller_idx ON pools (seller_id);

-- ─── 3. pool_members ─────────────────────────────────────────────────────────
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS pool_members (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id             uuid NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  -- The buyer is an MSME profile (the goods order's msme_id), user kept for RLS.
  msme_id             uuid NOT NULL REFERENCES msme_profiles(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  qty                 integer NOT NULL,
  -- blocked | captured | released | failed (packages/shared POOL_MEMBER_PAYMENT_STATES)
  payment_state       text NOT NULL DEFAULT 'blocked',
  -- Snapshots the eventual goods order needs (same shapes as checkout_sessions).
  delivery_snapshot   jsonb NOT NULL,
  gst_invoice         jsonb,
  -- Pay-on-close: the per-member goods checkout session and the order it became.
  checkout_session_id uuid REFERENCES checkout_sessions(id) ON DELETE SET NULL,
  order_id            uuid REFERENCES orders(id) ON DELETE SET NULL,
  pay_by              timestamptz,
  -- block_capture adapter: the PSP mandate/authorisation reference (never a token).
  psp_ref             text,
  committed_at        timestamptz NOT NULL DEFAULT now(),
  captured_at         timestamptz,
  released_at         timestamptz,
  failed_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz,
  CONSTRAINT pool_members_qty_check CHECK (qty > 0),
  CONSTRAINT pool_members_state_check CHECK (payment_state IN ('blocked','captured','released','failed')),
  CONSTRAINT pool_members_pool_msme_uniq UNIQUE (pool_id, msme_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pool_members_pool_idx ON pool_members (pool_id, payment_state);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pool_members_msme_idx ON pool_members (msme_id);

-- ─── 4. pool_events (append-only, quote_events regime) ───────────────────────
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS pool_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id    uuid NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  member_id  uuid REFERENCES pool_members(id) ON DELETE SET NULL,
  actor_id   uuid REFERENCES users(id),
  -- packages/shared POOL_EVENT_TYPES (+ 'drafted' | 'approved' | 'card_confirmed')
  event_type text NOT NULL,
  payload    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pool_events_pool_idx ON pool_events (pool_id, created_at);
--> statement-breakpoint
DROP TRIGGER IF EXISTS pool_events_no_update ON pool_events;
--> statement-breakpoint
CREATE TRIGGER pool_events_no_update
  BEFORE UPDATE ON pool_events
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON pool_events FROM anon, authenticated;

-- ─── 5. ai_decisions: M1 features ────────────────────────────────────────────
--> statement-breakpoint
ALTER TABLE ai_decisions DROP CONSTRAINT IF EXISTS ai_decisions_feature_check;
--> statement-breakpoint
ALTER TABLE ai_decisions ADD CONSTRAINT ai_decisions_feature_check
  CHECK (feature IN ('catalog_draft','payout_dossier','extraction_correction','pool_draft','pool_card','documents_draft'));

-- ─── 6. Buyer pool-commitment discipline inputs (§4.5) ───────────────────────
-- Read-only per-buyer inputs, no score (sibling of provider_score_inputs_v1).
-- due = commitments in pools that closed met; honoured = paid; defaulted =
-- lapsed. The factor + sample gates live in packages/shared (poolDisciplineFactor).
--> statement-breakpoint
-- A commitment is DUE once its pool closed met: it was paid (captured), it
-- lapsed (failed), or it is still standing in a pool that is closed_met /
-- ordered / fulfilled. Captured and failed rows count whatever the pool's
-- later status (a pool where every member lapsed ends 'cancelled' — the
-- defaults must survive that).
CREATE OR REPLACE VIEW buyer_pool_discipline_v1
WITH (security_invoker = false) AS
SELECT
  m.msme_id,
  count(*) FILTER (WHERE m.payment_state IN ('captured','failed')
                      OR (m.payment_state = 'blocked' AND p.status IN ('closed_met','ordered','fulfilled')))::int AS due,
  count(*) FILTER (WHERE m.payment_state = 'captured')::int                                                        AS honoured,
  count(*) FILTER (WHERE m.payment_state = 'failed')::int                                                          AS defaulted,
  count(*)::int                                                                                                     AS commitments
FROM pool_members m
JOIN pools p ON p.id = m.pool_id
GROUP BY m.msme_id;
--> statement-breakpoint
REVOKE ALL ON buyer_pool_discipline_v1 FROM anon, authenticated;
--> statement-breakpoint
GRANT SELECT ON buyer_pool_discipline_v1 TO authenticated;

-- ─── 7. RLS (mirrored in rls/policies.sql) ───────────────────────────────────
--> statement-breakpoint
ALTER TABLE pools ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pool_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pool_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- pools: the public sees pools that are open or closed (the card stays
-- forwardable after close); drafts and cancelled pools are admin-only; the
-- awarded seller sees its pools; members see pools they joined.
DROP POLICY IF EXISTS "pools: public read live" ON pools;
--> statement-breakpoint
CREATE POLICY "pools: public read live" ON pools
  FOR SELECT USING (status IN ('open','closed_met','closed_unmet','ordered','fulfilled') AND deleted_at IS NULL);
--> statement-breakpoint
DROP POLICY IF EXISTS "pools: seller read own" ON pools;
--> statement-breakpoint
CREATE POLICY "pools: seller read own" ON pools
  FOR SELECT USING (seller_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));
--> statement-breakpoint
DROP POLICY IF EXISTS "pools: admin all" ON pools;
--> statement-breakpoint
CREATE POLICY "pools: admin all" ON pools
  FOR ALL USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON pools FROM anon, authenticated;
--> statement-breakpoint
-- pool_members: a member sees ONLY their own row (cross-tenant = 0 rows — the
-- public progress numbers come from the service-role API, never from rows);
-- the awarded seller sees allocations once the pool closed met; admins all.
-- All writes go through the API (service role) so the money rule is enforced
-- in one place (lib/mart/pools.ts) — clients cannot insert/update/delete.
DROP POLICY IF EXISTS "pool_members: member read own" ON pool_members;
--> statement-breakpoint
CREATE POLICY "pool_members: member read own" ON pool_members
  FOR SELECT USING (user_id = auth_user_id());
--> statement-breakpoint
DROP POLICY IF EXISTS "pool_members: seller read awarded" ON pool_members;
--> statement-breakpoint
CREATE POLICY "pool_members: seller read awarded" ON pool_members
  FOR SELECT USING (
    pool_id IN (
      SELECT id FROM pools
      WHERE status IN ('closed_met','ordered','fulfilled')
        AND seller_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
    )
  );
--> statement-breakpoint
DROP POLICY IF EXISTS "pool_members: admin read" ON pool_members;
--> statement-breakpoint
CREATE POLICY "pool_members: admin read" ON pool_members
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON pool_members FROM anon, authenticated;
--> statement-breakpoint
-- pool_events: members read their pool's events; seller (awarded) and admins read; service role writes.
DROP POLICY IF EXISTS "pool_events: member read" ON pool_events;
--> statement-breakpoint
CREATE POLICY "pool_events: member read" ON pool_events
  FOR SELECT USING (pool_id IN (SELECT pool_id FROM pool_members WHERE user_id = auth_user_id()));
--> statement-breakpoint
DROP POLICY IF EXISTS "pool_events: admin read" ON pool_events;
--> statement-breakpoint
CREATE POLICY "pool_events: admin read" ON pool_events
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
--> statement-breakpoint
REVOKE INSERT ON pool_events FROM anon, authenticated;
