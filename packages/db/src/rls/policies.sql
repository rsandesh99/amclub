-- =============================================================================
-- AMClub — RLS Policies & Helper Functions  (Phase 1)
-- Idempotent: safe to re-run. DROP POLICY IF EXISTS before each CREATE POLICY.
-- =============================================================================

-- ─── Helper functions ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION auth_user_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT auth.uid()
$$;

CREATE OR REPLACE FUNCTION has_role(r text)
RETURNS bool LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM users WHERE id = auth.uid() AND r = ANY(roles)
  )
$$;

-- Breaks the rfqs ↔ rfq_matches RLS cycle: reads rfq_matches bypassing RLS
CREATE OR REPLACE FUNCTION is_provider_matched_to_rfq(p_rfq_id uuid)
RETURNS bool LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM rfq_matches
    WHERE rfq_id = p_rfq_id
      AND provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth.uid())
  )
$$;

-- ─── Enable RLS on every table ────────────────────────────────────────────────

ALTER TABLE users                ENABLE ROW LEVEL SECURITY;
ALTER TABLE msme_profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories           ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_categories  ENABLE ROW LEVEL SECURITY;
ALTER TABLE packages             ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfqs                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfq_matches          ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders               ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_milestones     ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_documents      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments             ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds              ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE disputes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews              ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations        ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages             ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_providers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications        ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupons              ENABLE ROW LEVEL SECURITY;
ALTER TABLE coupon_redemptions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices             ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE cms_banners          ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_account_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE terms_acceptances    ENABLE ROW LEVEL SECURITY;
-- AMC Mart (0022) — staged; these ALTERs are no-ops until 0022 is applied.
ALTER TABLE IF EXISTS mart_categories  ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS mart_settings    ENABLE ROW LEVEL SECURITY;
-- AMC Mart M1 (0023) — staged; no-ops until 0023 is applied.
ALTER TABLE IF EXISTS pools            ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS pool_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS pool_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS products         ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS price_tiers      ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS product_events   ENABLE ROW LEVEL SECURITY;
-- ai_decisions RLS is enabled in the always-applied section (0027 lifted it out
-- of staged Mart 0022); no IF EXISTS guard needed once 0027 is applied.

-- ─── users ────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "users: owner all" ON users;
CREATE POLICY "users: owner all" ON users
  FOR ALL USING (id = auth_user_id()) WITH CHECK (id = auth_user_id());

DROP POLICY IF EXISTS "users: admin read" ON users;
CREATE POLICY "users: admin read" ON users
  FOR SELECT USING (has_role('admin') OR has_role('ops'));

-- ─── msme_profiles ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "msme_profiles: owner all" ON msme_profiles;
CREATE POLICY "msme_profiles: owner all" ON msme_profiles
  FOR ALL USING (user_id = auth_user_id()) WITH CHECK (user_id = auth_user_id());

DROP POLICY IF EXISTS "msme_profiles: admin read" ON msme_profiles;
CREATE POLICY "msme_profiles: admin read" ON msme_profiles
  FOR SELECT USING (has_role('admin') OR has_role('ops'));

-- ─── provider_profiles ────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "provider_profiles: owner all" ON provider_profiles;
CREATE POLICY "provider_profiles: owner all" ON provider_profiles
  FOR ALL USING (user_id = auth_user_id()) WITH CHECK (user_id = auth_user_id());

DROP POLICY IF EXISTS "provider_profiles: public read active" ON provider_profiles;
CREATE POLICY "provider_profiles: public read active" ON provider_profiles
  FOR SELECT USING (status = 'active' AND deleted_at IS NULL);

DROP POLICY IF EXISTS "provider_profiles: admin all" ON provider_profiles;
CREATE POLICY "provider_profiles: admin all" ON provider_profiles
  FOR ALL USING (has_role('admin') OR has_role('ops'));

-- Public view: safe columns only (no PAN, GSTIN, bank details)
CREATE OR REPLACE VIEW public_providers AS
  SELECT
    id, display_name, slug, about, logo_url,
    state, city, languages,
    avg_rating, review_count, completed_orders,
    median_response_minutes, capacity_paused, top_rated,
    created_at
  FROM provider_profiles
  WHERE status = 'active' AND deleted_at IS NULL;

-- ─── provider_verifications ───────────────────────────────────────────────────

DROP POLICY IF EXISTS "provider_verifications: owner read" ON provider_verifications;
CREATE POLICY "provider_verifications: owner read" ON provider_verifications
  FOR SELECT USING (
    provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
  );

DROP POLICY IF EXISTS "provider_verifications: admin all" ON provider_verifications;
CREATE POLICY "provider_verifications: admin all" ON provider_verifications
  FOR ALL USING (has_role('admin') OR has_role('ops'));

-- ─── provider_bank_accounts ───────────────────────────────────────────────────

DROP POLICY IF EXISTS "provider_bank_accounts: owner all" ON provider_bank_accounts;
CREATE POLICY "provider_bank_accounts: owner all" ON provider_bank_accounts
  FOR ALL
  USING (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()))
  WITH CHECK (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));

DROP POLICY IF EXISTS "provider_bank_accounts: admin read" ON provider_bank_accounts;
CREATE POLICY "provider_bank_accounts: admin read" ON provider_bank_accounts
  FOR SELECT USING (has_role('admin') OR has_role('ops'));

-- ─── categories ───────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "categories: public read active" ON categories;
CREATE POLICY "categories: public read active" ON categories
  FOR SELECT USING (is_active = true);

DROP POLICY IF EXISTS "categories: admin all" ON categories;
CREATE POLICY "categories: admin all" ON categories
  FOR ALL USING (has_role('admin') OR has_role('ops'));

-- ─── provider_categories ──────────────────────────────────────────────────────

DROP POLICY IF EXISTS "provider_categories: public read" ON provider_categories;
CREATE POLICY "provider_categories: public read" ON provider_categories
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "provider_categories: owner all" ON provider_categories;
CREATE POLICY "provider_categories: owner all" ON provider_categories
  FOR ALL
  USING (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()))
  WITH CHECK (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));

-- ─── packages ─────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "packages: public read active" ON packages;
CREATE POLICY "packages: public read active" ON packages
  FOR SELECT USING (
    status = 'active'
    AND deleted_at IS NULL
    AND provider_id IN (SELECT id FROM provider_profiles WHERE status = 'active' AND deleted_at IS NULL)
  );

DROP POLICY IF EXISTS "packages: provider crud own" ON packages;
CREATE POLICY "packages: provider crud own" ON packages
  FOR ALL
  USING (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()))
  WITH CHECK (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));

DROP POLICY IF EXISTS "packages: admin all" ON packages;
CREATE POLICY "packages: admin all" ON packages
  FOR ALL USING (has_role('admin') OR has_role('ops'));

-- ─── rfqs ─────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "rfqs: owner all" ON rfqs;
CREATE POLICY "rfqs: owner all" ON rfqs
  FOR ALL
  USING (msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id()))
  WITH CHECK (msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id()));

DROP POLICY IF EXISTS "rfqs: matched provider read" ON rfqs;
CREATE POLICY "rfqs: matched provider read" ON rfqs
  FOR SELECT USING (
    status = 'open'
    AND is_provider_matched_to_rfq(id)
  );

DROP POLICY IF EXISTS "rfqs: admin all" ON rfqs;
CREATE POLICY "rfqs: admin all" ON rfqs
  FOR ALL USING (has_role('admin') OR has_role('ops'));

-- ─── rfq_matches ──────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "rfq_matches: provider read own" ON rfq_matches;
CREATE POLICY "rfq_matches: provider read own" ON rfq_matches
  FOR SELECT USING (
    provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
  );

DROP POLICY IF EXISTS "rfq_matches: msme read own rfq" ON rfq_matches;
CREATE POLICY "rfq_matches: msme read own rfq" ON rfq_matches
  FOR SELECT USING (
    rfq_id IN (
      SELECT id FROM rfqs
      WHERE msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
    )
  );

DROP POLICY IF EXISTS "rfq_matches: admin all" ON rfq_matches;
CREATE POLICY "rfq_matches: admin all" ON rfq_matches
  FOR ALL USING (has_role('admin') OR has_role('ops'));

-- ─── quotes ───────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "quotes: provider crud own" ON quotes;
CREATE POLICY "quotes: provider crud own" ON quotes
  FOR ALL
  USING (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()))
  WITH CHECK (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));

DROP POLICY IF EXISTS "quotes: msme read own rfq" ON quotes;
CREATE POLICY "quotes: msme read own rfq" ON quotes
  FOR SELECT USING (
    rfq_id IN (
      SELECT id FROM rfqs
      WHERE msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
    )
  );

DROP POLICY IF EXISTS "quotes: admin all" ON quotes;
CREATE POLICY "quotes: admin all" ON quotes
  FOR ALL USING (has_role('admin') OR has_role('ops'));

-- ─── quote_events (0016) — append-only; read-only for every client role ──────

DROP POLICY IF EXISTS "quote_events: provider read own" ON quote_events;
CREATE POLICY "quote_events: provider read own" ON quote_events
  FOR SELECT USING (
    quote_id IN (
      SELECT id FROM quotes
      WHERE provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
    )
  );

DROP POLICY IF EXISTS "quote_events: msme read own rfq" ON quote_events;
CREATE POLICY "quote_events: msme read own rfq" ON quote_events
  FOR SELECT USING (
    quote_id IN (
      SELECT q.id FROM quotes q
      JOIN rfqs r ON r.id = q.rfq_id
      WHERE r.msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
    )
  );

DROP POLICY IF EXISTS "quote_events: admin read" ON quote_events;
CREATE POLICY "quote_events: admin read" ON quote_events
  FOR SELECT USING (has_role('admin') OR has_role('ops'));

DROP POLICY IF EXISTS "quote_events: admin insert" ON quote_events;
CREATE POLICY "quote_events: admin insert" ON quote_events
  FOR INSERT WITH CHECK (has_role('admin') OR has_role('ops'));

-- No UPDATE/DELETE policies by design (append-only); grants revoked in 0016.
REVOKE UPDATE, DELETE ON quote_events FROM anon, authenticated;

-- ─── bank_account_verifications (0016) — service-role only, no policies ──────

REVOKE ALL ON bank_account_verifications FROM anon, authenticated;

-- ─── terms_acceptances (0017) — append-only; self read + admin read ──────────

DROP POLICY IF EXISTS "terms_acceptances: self read" ON terms_acceptances;
CREATE POLICY "terms_acceptances: self read" ON terms_acceptances
  FOR SELECT USING (user_id = auth_user_id());

DROP POLICY IF EXISTS "terms_acceptances: admin read" ON terms_acceptances;
CREATE POLICY "terms_acceptances: admin read" ON terms_acceptances
  FOR SELECT USING (has_role('admin') OR has_role('ops'));

-- No INSERT/UPDATE/DELETE policies by design (service role writes; append-only).
REVOKE UPDATE, DELETE ON terms_acceptances FROM anon, authenticated;

-- ─── gstin_verifications (0021) — self read + admin read; server-side writes ──

ALTER TABLE gstin_verifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "gstin_verifications: self read" ON gstin_verifications;
CREATE POLICY "gstin_verifications: self read" ON gstin_verifications
  FOR SELECT USING (user_id = auth_user_id());

DROP POLICY IF EXISTS "gstin_verifications: admin read" ON gstin_verifications;
CREATE POLICY "gstin_verifications: admin read" ON gstin_verifications
  FOR SELECT USING (has_role('admin') OR has_role('ops'));

-- No INSERT/UPDATE/DELETE policies by design (service role writes only).
REVOKE INSERT, UPDATE, DELETE ON gstin_verifications FROM anon, authenticated;

-- ─── udyam_verifications (0029) — mirror of gstin_verifications ──────────────
ALTER TABLE udyam_verifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "udyam_verifications: self read" ON udyam_verifications;
CREATE POLICY "udyam_verifications: self read" ON udyam_verifications
  FOR SELECT USING (user_id = auth_user_id());

DROP POLICY IF EXISTS "udyam_verifications: admin read" ON udyam_verifications;
CREATE POLICY "udyam_verifications: admin read" ON udyam_verifications
  FOR SELECT USING (has_role('admin') OR has_role('ops'));

-- No INSERT/UPDATE/DELETE policies by design (service role writes only).
REVOKE INSERT, UPDATE, DELETE ON udyam_verifications FROM anon, authenticated;

-- ─── wa_conversations / wa_messages (0030) — no client policies; admin read ──
ALTER TABLE wa_conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wa_conversations: admin read" ON wa_conversations;
CREATE POLICY "wa_conversations: admin read" ON wa_conversations
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
REVOKE INSERT, UPDATE, DELETE ON wa_conversations FROM anon, authenticated;

ALTER TABLE wa_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "wa_messages: admin read" ON wa_messages;
CREATE POLICY "wa_messages: admin read" ON wa_messages
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
REVOKE INSERT, UPDATE, DELETE ON wa_messages FROM anon, authenticated;

-- ─── agent_runs / agent_events (0026) — self read + admin read; service writes ─
-- Mirrors migration 0026 (H0 agent groundwork, ADR-008). agent_events carries
-- the same append-only guard as order_events; raise_append_only() from 0017.

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_runs: self read" ON agent_runs;
CREATE POLICY "agent_runs: self read" ON agent_runs
  FOR SELECT USING (user_id = auth_user_id());

DROP POLICY IF EXISTS "agent_runs: admin read" ON agent_runs;
CREATE POLICY "agent_runs: admin read" ON agent_runs
  FOR SELECT USING (has_role('admin') OR has_role('ops'));

REVOKE INSERT, UPDATE, DELETE ON agent_runs FROM anon, authenticated;

ALTER TABLE agent_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_events: self read" ON agent_events;
CREATE POLICY "agent_events: self read" ON agent_events
  FOR SELECT USING (run_id IN (SELECT id FROM agent_runs WHERE user_id = auth_user_id()));

DROP POLICY IF EXISTS "agent_events: admin read" ON agent_events;
CREATE POLICY "agent_events: admin read" ON agent_events
  FOR SELECT USING (has_role('admin') OR has_role('ops'));

DROP TRIGGER IF EXISTS agent_events_no_update ON agent_events;
CREATE TRIGGER agent_events_no_update
  BEFORE UPDATE ON agent_events
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
REVOKE INSERT, UPDATE, DELETE ON agent_events FROM anon, authenticated;

-- ─── ai_decisions (0027) — LIFTED from the Mart $mart$ block; always applied ───
-- The single confirmation ledger (Mart + runtime agents). Append-only; the
-- deciding human reads their own rows, admins read all, service role writes.
ALTER TABLE ai_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_decisions: self read" ON ai_decisions;
CREATE POLICY "ai_decisions: self read" ON ai_decisions
  FOR SELECT USING (decided_by = auth_user_id());

DROP POLICY IF EXISTS "ai_decisions: admin read" ON ai_decisions;
CREATE POLICY "ai_decisions: admin read" ON ai_decisions
  FOR SELECT USING (has_role('admin') OR has_role('ops'));

DROP TRIGGER IF EXISTS ai_decisions_no_update ON ai_decisions;
CREATE TRIGGER ai_decisions_no_update
  BEFORE UPDATE ON ai_decisions
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
REVOKE INSERT, UPDATE, DELETE ON ai_decisions FROM anon, authenticated;

-- ─── agent_settings (0027) — closed config registry; admin read, service write ─
ALTER TABLE agent_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_settings: admin read" ON agent_settings;
CREATE POLICY "agent_settings: admin read" ON agent_settings
  FOR SELECT USING (has_role('admin') OR has_role('ops'));

REVOKE INSERT, UPDATE, DELETE ON agent_settings FROM anon, authenticated;

-- ─── agent_grants (0027) — delegated-identity consent; self read/insert/revoke ─
ALTER TABLE agent_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "agent_grants: self read" ON agent_grants;
CREATE POLICY "agent_grants: self read" ON agent_grants
  FOR SELECT USING (user_id = auth_user_id());

DROP POLICY IF EXISTS "agent_grants: self insert" ON agent_grants;
CREATE POLICY "agent_grants: self insert" ON agent_grants
  FOR INSERT WITH CHECK (user_id = auth_user_id());

DROP POLICY IF EXISTS "agent_grants: self revoke" ON agent_grants;
CREATE POLICY "agent_grants: self revoke" ON agent_grants
  FOR UPDATE USING (user_id = auth_user_id()) WITH CHECK (user_id = auth_user_id());

DROP POLICY IF EXISTS "agent_grants: admin read" ON agent_grants;
CREATE POLICY "agent_grants: admin read" ON agent_grants
  FOR SELECT USING (has_role('admin') OR has_role('ops'));

-- Self may INSERT own rows and UPDATE only revoked_at (column-scoped grant); never DELETE.
REVOKE UPDATE, DELETE ON agent_grants FROM anon, authenticated;
GRANT UPDATE (revoked_at) ON agent_grants TO authenticated;

-- ─── payout_dossiers / evidence_photo_hashes (0031, S1.4) — admin read; service write ─
ALTER TABLE payout_dossiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "payout_dossiers: admin read" ON payout_dossiers;
CREATE POLICY "payout_dossiers: admin read" ON payout_dossiers
  FOR SELECT USING (has_role('admin') OR has_role('ops'));

-- A decision is written once (function created in 0031).
DROP TRIGGER IF EXISTS payout_dossiers_decision_guard ON payout_dossiers;
CREATE TRIGGER payout_dossiers_decision_guard
  BEFORE UPDATE ON payout_dossiers
  FOR EACH ROW EXECUTE FUNCTION payout_dossiers_decision_once();
REVOKE INSERT, UPDATE, DELETE ON payout_dossiers FROM anon, authenticated;

ALTER TABLE evidence_photo_hashes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "evidence_photo_hashes: admin read" ON evidence_photo_hashes;
CREATE POLICY "evidence_photo_hashes: admin read" ON evidence_photo_hashes
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
REVOKE INSERT, UPDATE, DELETE ON evidence_photo_hashes FROM anon, authenticated;

-- ─── quote_extractions / provider_price_book (0032, S1.1) — provider read own; admin read; service write ─
ALTER TABLE quote_extractions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quote_extractions: provider read own" ON quote_extractions;
CREATE POLICY "quote_extractions: provider read own" ON quote_extractions
  FOR SELECT USING (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));

DROP POLICY IF EXISTS "quote_extractions: admin read" ON quote_extractions;
CREATE POLICY "quote_extractions: admin read" ON quote_extractions
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
REVOKE INSERT, UPDATE, DELETE ON quote_extractions FROM anon, authenticated;

ALTER TABLE provider_price_book ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "provider_price_book: provider read own" ON provider_price_book;
CREATE POLICY "provider_price_book: provider read own" ON provider_price_book
  FOR SELECT USING (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));

DROP POLICY IF EXISTS "provider_price_book: admin read" ON provider_price_book;
CREATE POLICY "provider_price_book: admin read" ON provider_price_book
  FOR SELECT USING (has_role('admin') OR has_role('ops'));
REVOKE INSERT, UPDATE, DELETE ON provider_price_book FROM anon, authenticated;

-- ─── order_events append-only guard (0019) ────────────────────────────────────
-- Mirrors migration 0019: same protections quote_events/terms_acceptances carry.
-- raise_append_only() is created in 0017 (bootstrap runs migrations first).
DROP TRIGGER IF EXISTS order_events_no_update ON order_events;
CREATE TRIGGER order_events_no_update
  BEFORE UPDATE ON order_events
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
REVOKE UPDATE, DELETE ON order_events FROM anon, authenticated;

-- ─── orders ───────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "orders: msme all own" ON orders;
CREATE POLICY "orders: msme all own" ON orders
  FOR ALL
  USING (msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id()))
  WITH CHECK (msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id()));

DROP POLICY IF EXISTS "orders: provider all own" ON orders;
CREATE POLICY "orders: provider all own" ON orders
  FOR ALL
  USING (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()))
  WITH CHECK (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));

DROP POLICY IF EXISTS "orders: admin all" ON orders;
CREATE POLICY "orders: admin all" ON orders
  FOR ALL USING (has_role('admin') OR has_role('ops'));

-- order_safe_view: masks buyer phone from provider until order is accepted.
-- DROP first: the view is `o.*`, so any new orders column shifts the column
-- list and CREATE OR REPLACE errors (42P16) — found by the Phase 8 restore
-- drill, where the freshly-migrated schema had a column live's view lacked.
DROP VIEW IF EXISTS order_safe_view;
CREATE VIEW order_safe_view AS
  SELECT
    o.*,
    CASE
      WHEN o.status = 'placed'
        AND o.provider_id IN (
          SELECT id FROM provider_profiles WHERE user_id = auth.uid()
        )
      THEN NULL
      ELSE (
        SELECT u.phone FROM users u
        JOIN msme_profiles mp ON mp.user_id = u.id
        WHERE mp.id = o.msme_id
      )
    END AS msme_phone
  FROM orders o;

-- ─── order_events ─────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "order_events: parties read" ON order_events;
CREATE POLICY "order_events: parties read" ON order_events
  FOR SELECT USING (
    order_id IN (
      SELECT id FROM orders
      WHERE msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
         OR provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
    )
  );

DROP POLICY IF EXISTS "order_events: parties insert" ON order_events;
CREATE POLICY "order_events: parties insert" ON order_events
  FOR INSERT WITH CHECK (
    order_id IN (
      SELECT id FROM orders
      WHERE msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
         OR provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
    )
  );

DROP POLICY IF EXISTS "order_events: admin all" ON order_events;
CREATE POLICY "order_events: admin all" ON order_events
  FOR ALL USING (has_role('admin') OR has_role('ops'));

-- ─── order_milestones & order_documents ───────────────────────────────────────

-- Evidence engine (0028): order parties READ; writes go through the milestone
-- route (service role). The legacy "parties all" policy is dropped.
DROP POLICY IF EXISTS "order_milestones: parties all" ON order_milestones;
DROP POLICY IF EXISTS "order_milestones: parties read" ON order_milestones;
CREATE POLICY "order_milestones: parties read" ON order_milestones
  FOR SELECT USING (
    order_id IN (
      SELECT id FROM orders
      WHERE msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
         OR provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
    )
  );
REVOKE INSERT, UPDATE, DELETE ON order_milestones FROM anon, authenticated;

DROP POLICY IF EXISTS "order_documents: parties all" ON order_documents;
CREATE POLICY "order_documents: parties all" ON order_documents
  FOR ALL USING (
    order_id IN (
      SELECT id FROM orders
      WHERE msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
         OR provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
    )
  );

-- ─── payments ─────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "payments: msme read own" ON payments;
CREATE POLICY "payments: msme read own" ON payments
  FOR SELECT USING (
    order_id IN (
      SELECT id FROM orders
      WHERE msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
    )
  );

DROP POLICY IF EXISTS "payments: admin all" ON payments;
CREATE POLICY "payments: admin all" ON payments
  FOR ALL USING (has_role('admin') OR has_role('ops'));

-- ─── refunds ──────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "refunds: msme read own" ON refunds;
CREATE POLICY "refunds: msme read own" ON refunds
  FOR SELECT USING (
    payment_id IN (
      SELECT id FROM payments
      WHERE order_id IN (
        SELECT id FROM orders
        WHERE msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
      )
    )
  );

DROP POLICY IF EXISTS "refunds: admin all" ON refunds;
CREATE POLICY "refunds: admin all" ON refunds
  FOR ALL USING (has_role('admin') OR has_role('ops'));

-- ─── payouts ──────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "payouts: provider read own" ON payouts;
CREATE POLICY "payouts: provider read own" ON payouts
  FOR SELECT USING (
    provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
  );

DROP POLICY IF EXISTS "payouts: admin all" ON payouts;
CREATE POLICY "payouts: admin all" ON payouts
  FOR ALL USING (has_role('admin') OR has_role('ops'));

-- ─── disputes ─────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "disputes: parties all" ON disputes;
CREATE POLICY "disputes: parties all" ON disputes
  FOR ALL USING (
    order_id IN (
      SELECT id FROM orders
      WHERE msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
         OR provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
    )
  );

DROP POLICY IF EXISTS "disputes: admin all" ON disputes;
CREATE POLICY "disputes: admin all" ON disputes
  FOR ALL USING (has_role('admin') OR has_role('ops'));

-- ─── reviews ──────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "reviews: public read published" ON reviews;
CREATE POLICY "reviews: public read published" ON reviews
  FOR SELECT USING (status = 'published');

DROP POLICY IF EXISTS "reviews: msme insert verified" ON reviews;
CREATE POLICY "reviews: msme insert verified" ON reviews
  FOR INSERT WITH CHECK (
    msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
    AND order_id IN (
      SELECT id FROM orders
      WHERE status = 'completed'
        AND msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
    )
  );

DROP POLICY IF EXISTS "reviews: provider reply" ON reviews;
CREATE POLICY "reviews: provider reply" ON reviews
  FOR UPDATE
  USING (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()))
  WITH CHECK (provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()));

DROP POLICY IF EXISTS "reviews: admin all" ON reviews;
CREATE POLICY "reviews: admin all" ON reviews
  FOR ALL USING (has_role('admin') OR has_role('ops'));

-- ─── conversations & messages ──────────────────────────────────────────────────

DROP POLICY IF EXISTS "conversations: parties all" ON conversations;
CREATE POLICY "conversations: parties all" ON conversations
  FOR ALL USING (
    msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
    OR provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
  );

DROP POLICY IF EXISTS "messages: parties all" ON messages;
CREATE POLICY "messages: parties all" ON messages
  FOR ALL USING (
    conversation_id IN (
      SELECT id FROM conversations
      WHERE msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
         OR provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
    )
  );

-- ─── saved_providers ──────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "saved_providers: owner all" ON saved_providers;
CREATE POLICY "saved_providers: owner all" ON saved_providers
  FOR ALL USING (
    msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
  );

-- ─── notifications ────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "notifications: owner read" ON notifications;
CREATE POLICY "notifications: owner read" ON notifications
  FOR SELECT USING (user_id = auth_user_id());

DROP POLICY IF EXISTS "notifications: owner mark read" ON notifications;
CREATE POLICY "notifications: owner mark read" ON notifications
  FOR UPDATE
  USING (user_id = auth_user_id())
  WITH CHECK (user_id = auth_user_id());

-- ─── coupons ──────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "coupons: public read active" ON coupons;
CREATE POLICY "coupons: public read active" ON coupons
  FOR SELECT USING (is_active = true AND valid_to > now());

DROP POLICY IF EXISTS "coupons: admin all" ON coupons;
CREATE POLICY "coupons: admin all" ON coupons
  FOR ALL USING (has_role('admin') OR has_role('ops'));

-- ─── coupon_redemptions ───────────────────────────────────────────────────────

DROP POLICY IF EXISTS "coupon_redemptions: msme read own" ON coupon_redemptions;
CREATE POLICY "coupon_redemptions: msme read own" ON coupon_redemptions
  FOR SELECT USING (
    msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
  );

-- ─── invoices ─────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "invoices: parties read" ON invoices;
CREATE POLICY "invoices: parties read" ON invoices
  FOR SELECT USING (
    order_id IN (
      SELECT id FROM orders
      WHERE msme_id IN (SELECT id FROM msme_profiles WHERE user_id = auth_user_id())
         OR provider_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())
    )
  );

DROP POLICY IF EXISTS "invoices: admin all" ON invoices;
CREATE POLICY "invoices: admin all" ON invoices
  FOR ALL USING (has_role('admin') OR has_role('ops'));

-- ─── audit_logs ───────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "audit_logs: admin read" ON audit_logs;
CREATE POLICY "audit_logs: admin read" ON audit_logs
  FOR SELECT USING (has_role('admin') OR has_role('ops'));

-- ─── cms_banners ──────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "cms_banners: public read active" ON cms_banners;
CREATE POLICY "cms_banners: public read active" ON cms_banners
  FOR SELECT USING (is_active = true AND (ends_at IS NULL OR ends_at > now()));

DROP POLICY IF EXISTS "cms_banners: admin all" ON cms_banners;
CREATE POLICY "cms_banners: admin all" ON cms_banners
  FOR ALL USING (has_role('admin') OR has_role('ops'));

-- ─── provider_profiles column privileges (§5.7 — no PAN/GSTIN to public) ───────
-- RLS is row-level; restrict sensitive COLUMNS via grants. Owner/admin read via
-- the service-role key (bypasses these). See migration 0004.
REVOKE SELECT ON provider_profiles FROM anon, authenticated;
GRANT SELECT (
  id, user_id, legal_name, display_name, slug, about, logo_url,
  state, city, languages, years_experience, website, status,
  avg_rating, review_count, completed_orders,
  median_response_minutes, capacity_paused, top_rated,
  created_at, updated_at, deleted_at
) ON provider_profiles TO anon, authenticated;

-- ═══ AMC Mart (0022) — mirrors migration 0022 §7 verbatim ═══════════════════
-- Guarded: bootstrap applies migrations first, so these tables exist; on a
-- database where 0022 is NOT yet applied (prod during the dark build) the
-- whole block is skipped so policies.sql stays re-runnable against prod.
DO $mart$
BEGIN
  IF to_regclass('public.products') IS NULL THEN
    RAISE NOTICE 'AMC Mart tables absent (0022 not applied) — skipping Mart policies';
    RETURN;
  END IF;

  -- The column-grant block above re-applies 0004's fixed list on every run,
  -- which drops 0022's sells_goods grant; the public catalog policies read it.
  EXECUTE 'GRANT SELECT (sells_goods) ON provider_profiles TO anon, authenticated';

  EXECUTE 'DROP POLICY IF EXISTS "mart_categories: public read active" ON mart_categories';
  EXECUTE 'CREATE POLICY "mart_categories: public read active" ON mart_categories FOR SELECT USING (is_active = true)';
  EXECUTE 'DROP POLICY IF EXISTS "mart_categories: admin all" ON mart_categories';
  EXECUTE 'CREATE POLICY "mart_categories: admin all" ON mart_categories FOR ALL USING (has_role(''admin'') OR has_role(''ops''))';

  EXECUTE 'DROP POLICY IF EXISTS "mart_settings: admin read" ON mart_settings';
  EXECUTE 'CREATE POLICY "mart_settings: admin read" ON mart_settings FOR SELECT USING (has_role(''admin'') OR has_role(''ops''))';
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON mart_settings FROM anon, authenticated';

  EXECUTE 'DROP POLICY IF EXISTS "products: public read active" ON products';
  EXECUTE 'CREATE POLICY "products: public read active" ON products FOR SELECT USING (
    status = ''active'' AND deleted_at IS NULL
    AND seller_id IN (SELECT id FROM provider_profiles WHERE status = ''active'' AND deleted_at IS NULL AND sells_goods = true))';
  EXECUTE 'DROP POLICY IF EXISTS "products: seller crud own" ON products';
  EXECUTE 'CREATE POLICY "products: seller crud own" ON products FOR ALL
    USING (seller_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()))
    WITH CHECK (seller_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()))';
  EXECUTE 'DROP POLICY IF EXISTS "products: admin all" ON products';
  EXECUTE 'CREATE POLICY "products: admin all" ON products FOR ALL USING (has_role(''admin'') OR has_role(''ops''))';

  EXECUTE 'DROP POLICY IF EXISTS "price_tiers: public read active" ON price_tiers';
  EXECUTE 'CREATE POLICY "price_tiers: public read active" ON price_tiers FOR SELECT USING (
    product_id IN (SELECT p.id FROM products p JOIN provider_profiles s ON s.id = p.seller_id
      WHERE p.status = ''active'' AND p.deleted_at IS NULL AND s.status = ''active'' AND s.deleted_at IS NULL AND s.sells_goods = true))';
  EXECUTE 'DROP POLICY IF EXISTS "price_tiers: seller crud own" ON price_tiers';
  EXECUTE 'CREATE POLICY "price_tiers: seller crud own" ON price_tiers FOR ALL
    USING (product_id IN (SELECT id FROM products WHERE seller_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())))
    WITH CHECK (product_id IN (SELECT id FROM products WHERE seller_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())))';
  EXECUTE 'DROP POLICY IF EXISTS "price_tiers: admin all" ON price_tiers';
  EXECUTE 'CREATE POLICY "price_tiers: admin all" ON price_tiers FOR ALL USING (has_role(''admin'') OR has_role(''ops''))';

  -- product_events: append-only (trigger from 0022), read-only for clients.
  EXECUTE 'DROP POLICY IF EXISTS "product_events: seller read own" ON product_events';
  EXECUTE 'CREATE POLICY "product_events: seller read own" ON product_events FOR SELECT USING (
    product_id IN (SELECT id FROM products WHERE seller_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())))';
  EXECUTE 'DROP POLICY IF EXISTS "product_events: admin read" ON product_events';
  EXECUTE 'CREATE POLICY "product_events: admin read" ON product_events FOR SELECT USING (has_role(''admin'') OR has_role(''ops''))';
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON product_events FROM anon, authenticated';
  -- NOTE: ai_decisions policies moved to the always-applied section (0027 lifts
  -- the table out of staged 0022). Nothing for ai_decisions belongs here now.
END
$mart$;

-- ═══ AMC Mart M1 (0023) — mirrors migration 0023 §7 verbatim ════════════════
DO $mart_pools$
BEGIN
  IF to_regclass('public.pools') IS NULL THEN
    RAISE NOTICE 'AMC Mart pool tables absent (0023 not applied) — skipping pool policies';
    RETURN;
  END IF;

  EXECUTE 'DROP POLICY IF EXISTS "pools: public read live" ON pools';
  EXECUTE 'CREATE POLICY "pools: public read live" ON pools FOR SELECT USING (status IN (''open'',''closed_met'',''closed_unmet'',''ordered'',''fulfilled'') AND deleted_at IS NULL)';
  EXECUTE 'DROP POLICY IF EXISTS "pools: seller read own" ON pools';
  EXECUTE 'CREATE POLICY "pools: seller read own" ON pools FOR SELECT USING (seller_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id()))';
  EXECUTE 'DROP POLICY IF EXISTS "pools: admin all" ON pools';
  EXECUTE 'CREATE POLICY "pools: admin all" ON pools FOR ALL USING (has_role(''admin'') OR has_role(''ops''))';
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON pools FROM anon, authenticated';

  EXECUTE 'DROP POLICY IF EXISTS "pool_members: member read own" ON pool_members';
  EXECUTE 'CREATE POLICY "pool_members: member read own" ON pool_members FOR SELECT USING (user_id = auth_user_id())';
  EXECUTE 'DROP POLICY IF EXISTS "pool_members: seller read awarded" ON pool_members';
  EXECUTE 'CREATE POLICY "pool_members: seller read awarded" ON pool_members FOR SELECT USING (
    pool_id IN (SELECT id FROM pools WHERE status IN (''closed_met'',''ordered'',''fulfilled'')
      AND seller_id IN (SELECT id FROM provider_profiles WHERE user_id = auth_user_id())))';
  EXECUTE 'DROP POLICY IF EXISTS "pool_members: admin read" ON pool_members';
  EXECUTE 'CREATE POLICY "pool_members: admin read" ON pool_members FOR SELECT USING (has_role(''admin'') OR has_role(''ops''))';
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON pool_members FROM anon, authenticated';

  EXECUTE 'DROP POLICY IF EXISTS "pool_events: member read" ON pool_events';
  EXECUTE 'CREATE POLICY "pool_events: member read" ON pool_events FOR SELECT USING (pool_id IN (SELECT pool_id FROM pool_members WHERE user_id = auth_user_id()))';
  EXECUTE 'DROP POLICY IF EXISTS "pool_events: admin read" ON pool_events';
  EXECUTE 'CREATE POLICY "pool_events: admin read" ON pool_events FOR SELECT USING (has_role(''admin'') OR has_role(''ops''))';
  EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON pool_events FROM anon, authenticated';

  EXECUTE 'REVOKE ALL ON buyer_pool_discipline_v1 FROM anon, authenticated';
  EXECUTE 'GRANT SELECT ON buyer_pool_discipline_v1 TO authenticated';
END
$mart_pools$;
