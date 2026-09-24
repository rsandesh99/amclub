-- S3.4 — demand aggregation for services (ADR 024). Agent migration: NOT staged
-- (apply before the writer deploys; every reader and writer is behind
-- AGENT_ENABLED + agents_enabled.demand_aggregation + the cohort, so a database
-- without 0071 fails no query outside the pool surfaces).
--
--   service_pools             one group per (category, service, buyer state) while
--                             live; forming → open → closing → closed, or lapsed /
--                             cancelled (shared SERVICE_POOL_TRANSITIONS).
--   service_pool_members      one buyer's OWN open request in a group; invited →
--                             joined / dismissed / left → released; the offer it
--                             committed to; at close: claimed | skipped + the quote.
--   service_pool_offers       a provider's one group offer (terms as on a v3 quote;
--                             GST and validity stated) + the count / tier it reached.
--   service_pool_offer_tiers  1–3 volume tiers (min_members, price); immutable rows.
--   service_pool_events       append-only history.
--   service_pool_claim(member) claims the member request's quote slot through
--                             claim_quote_slot AND marks the member claimed in ONE
--                             transaction (a crashed close never claims twice).
--
-- No client grant anywhere: the API reads and writes on the admin client after its
-- own authorisation (ADR 018 posture; like quote_options). No existing table gains
-- a column. ai_decisions_feature_check gains 'demand_pool' (the buyer's join).
--
-- Backfill: none (new tables).
-- Rollback (after turning agents_enabled.demand_aggregation off): DROP FUNCTION
--   service_pool_claim(uuid); DROP TABLE service_pool_events,
--   service_pool_offer_tiers, service_pool_members, service_pool_offers,
--   service_pools; restore the 0061 ai_decisions_feature_check. Quotes already
--   written by a close stay ordinary quotes.

CREATE TABLE IF NOT EXISTS service_pools (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id      uuid NOT NULL REFERENCES categories(id),
  service_slug     text NOT NULL CHECK (service_slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  state            text NOT NULL,
  status           text NOT NULL DEFAULT 'forming'
                     CHECK (status IN ('forming', 'open', 'closing', 'closed', 'lapsed', 'cancelled')),
  min_members      integer NOT NULL CHECK (min_members BETWEEN 2 AND 50),
  max_members      integer NOT NULL CHECK (max_members BETWEEN 2 AND 50),
  form_by          timestamptz NOT NULL,
  opened_at        timestamptz,
  closes_at        timestamptz,
  closed_at        timestamptz,
  cancelled_reason text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'open' OR (opened_at IS NOT NULL AND closes_at IS NOT NULL))
);
--> statement-breakpoint
-- One live group per key (a replayed or concurrent detection cannot propose twice).
CREATE UNIQUE INDEX IF NOT EXISTS service_pools_live_key_uq ON service_pools (category_id, service_slug, state)
  WHERE status IN ('forming', 'open', 'closing');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS service_pools_status_idx ON service_pools (status, closes_at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS service_pool_offers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id             uuid NOT NULL REFERENCES service_pools(id) ON DELETE CASCADE,
  provider_id         uuid NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
  delivery_days       integer NOT NULL CHECK (delivery_days BETWEEN 1 AND 365),
  scope               text NOT NULL,
  message             text,
  gst_included        boolean NOT NULL,
  transport_included  boolean,
  valid_until         date NOT NULL,
  advance_percent     integer CHECK (advance_percent BETWEEN 0 AND 100),
  -- Set once, by the close, before any quote is written (a resumed close reuses them).
  achieved_count      integer CHECK (achieved_count >= 0),
  achieved_min_members integer,
  achieved_price_paise bigint CHECK (achieved_price_paise > 0),
  withdrawn_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS service_pool_offers_one_active_uq ON service_pool_offers (pool_id, provider_id) WHERE status = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS service_pool_offers_provider_idx ON service_pool_offers (provider_id, created_at DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS service_pool_offer_tiers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id     uuid NOT NULL REFERENCES service_pool_offers(id) ON DELETE CASCADE,
  min_members  integer NOT NULL CHECK (min_members BETWEEN 1 AND 50),
  price_paise  bigint NOT NULL CHECK (price_paise > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offer_id, min_members)
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS service_pool_offer_tiers_immutable ON service_pool_offer_tiers;
--> statement-breakpoint
CREATE TRIGGER service_pool_offer_tiers_immutable
  BEFORE UPDATE ON service_pool_offer_tiers
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS service_pool_members (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id             uuid NOT NULL REFERENCES service_pools(id) ON DELETE CASCADE,
  rfq_id              uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  msme_id             uuid NOT NULL REFERENCES msme_profiles(id) ON DELETE CASCADE,
  status              text NOT NULL DEFAULT 'invited'
                        CHECK (status IN ('invited', 'joined', 'left', 'dismissed', 'released')),
  joined_at           timestamptz,
  -- The buyer's join of the agent's proposal (ai_decisions feature demand_pool).
  decision_id         uuid REFERENCES ai_decisions(id) ON DELETE SET NULL,
  committed_offer_id  uuid REFERENCES service_pool_offers(id) ON DELETE SET NULL,
  committed_at        timestamptz,
  -- The close: the slot was claimed (then quoted) or the member was skipped.
  claim_state         text CHECK (claim_state IN ('claimed', 'skipped')),
  claim_offer_id      uuid REFERENCES service_pool_offers(id) ON DELETE SET NULL,
  skip_reason         text CHECK (skip_reason IN ('provider_inactive', 'rfq_closed', 'already_quoted', 'declined')),
  quote_id            uuid REFERENCES quotes(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pool_id, rfq_id),
  UNIQUE (pool_id, msme_id)
);
--> statement-breakpoint
-- A request is in at most one live group.
CREATE UNIQUE INDEX IF NOT EXISTS service_pool_members_live_rfq_uq ON service_pool_members (rfq_id)
  WHERE status IN ('invited', 'joined');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS service_pool_members_msme_idx ON service_pool_members (msme_id, created_at DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS service_pool_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_id        uuid NOT NULL REFERENCES service_pools(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN (
                   'proposed', 'invited', 'joined', 'left', 'dismissed', 'opened', 'offer_submitted',
                   'offer_withdrawn', 'committed', 'uncommitted', 'closing', 'closed', 'lapsed', 'cancelled')),
  actor_user_id  uuid,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS service_pool_events_pool_idx ON service_pool_events (pool_id, created_at);
--> statement-breakpoint
DROP TRIGGER IF EXISTS service_pool_events_no_update ON service_pool_events;
--> statement-breakpoint
CREATE TRIGGER service_pool_events_no_update
  BEFORE UPDATE ON service_pool_events
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
--> statement-breakpoint

DROP TRIGGER IF EXISTS set_updated_at ON service_pools;
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON service_pools FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS set_updated_at ON service_pool_offers;
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON service_pool_offers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
DROP TRIGGER IF EXISTS set_updated_at ON service_pool_members;
--> statement-breakpoint
CREATE TRIGGER set_updated_at BEFORE UPDATE ON service_pool_members FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint

-- The close's one claim per member: the request's quote slot (cap, status and
-- expiry enforced by claim_quote_slot) and the member's claim_state move together.
-- Returns 'claimed', 'rfq_closed' (slot refused; the member is marked skipped), or
-- the member's existing claim_state when it was already settled (replay).
CREATE OR REPLACE FUNCTION service_pool_claim(p_member_id uuid)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  m service_pool_members%ROWTYPE;
  n integer;
BEGIN
  SELECT * INTO m FROM service_pool_members WHERE id = p_member_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF m.claim_state IS NOT NULL THEN RETURN m.claim_state; END IF;
  IF m.committed_offer_id IS NULL THEN RETURN 'uncommitted'; END IF;
  n := claim_quote_slot(m.rfq_id);
  IF n IS NULL THEN
    UPDATE service_pool_members
       SET claim_state = 'skipped', skip_reason = 'rfq_closed', claim_offer_id = m.committed_offer_id
     WHERE id = p_member_id;
    RETURN 'rfq_closed';
  END IF;
  UPDATE service_pool_members
     SET claim_state = 'claimed', claim_offer_id = m.committed_offer_id
   WHERE id = p_member_id;
  RETURN 'claimed';
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION service_pool_claim(uuid) FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION service_pool_claim(uuid) TO service_role;
--> statement-breakpoint

ALTER TABLE service_pools ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE service_pool_offers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE service_pool_offer_tiers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE service_pool_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE service_pool_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON service_pools, service_pool_offers, service_pool_offer_tiers, service_pool_members, service_pool_events FROM anon, authenticated;
--> statement-breakpoint

ALTER TABLE ai_decisions DROP CONSTRAINT IF EXISTS ai_decisions_feature_check;
--> statement-breakpoint
ALTER TABLE ai_decisions ADD CONSTRAINT ai_decisions_feature_check CHECK (feature IN (
  'catalog_draft', 'payout_dossier', 'extraction_correction',
  'pool_draft', 'pool_card', 'documents_draft',
  'agent_tool', 'quote_extraction', 'decline_message', 'onboarding',
  'dispute_triage', 'rfq_quality', 'munshi_draft', 'support_reply', 'score_note',
  'rfq_intake', 'munshi_reply', 'support_nudge', 'procurement_step',
  'content_translation', 'demand_pool'
));
