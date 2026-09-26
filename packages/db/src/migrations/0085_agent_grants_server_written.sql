-- 0085 — agent_grants is server-written only (WhatsApp readiness audit, 2026-09-26). NOT staged; idempotent.
--
-- agent_grants is two things at once: the user's consent evidence (WhatsApp opt-in, the agent permission screen) and the
-- authority a delegated agent token is minted from (lib/agent/token.ts: the token's scopes are the union of the user's
-- active grants). 0027 revoked UPDATE / DELETE but kept INSERT (Supabase default privileges) and granted UPDATE
-- (revoked_at), under self-insert / self-revoke policies that put no rule on the values. So any token for the user —
-- including a delegated agent token, which carries role=authenticated — could, straight through PostgREST:
--   * revoke its grant and insert a wider one (e.g. place_order, which /checkout honours for delegated tokens);
--   * forge the consent snapshot (surface, text version, time) of a WhatsApp opt-in;
--   * set revoked_at back to NULL (revive a withdrawn consent) or backdate a withdrawal.
-- Every writer is now a route or job on the service role after its own checks: /api/v1/agent/grants (session only,
-- requireNotDelegated, persona ⊆ the user's roles), the Munshi / procurement enable routes, the WhatsApp runtime
-- (START / STOP / phone binding) and the 0079 phone-change trigger. The ADR-018 / ADR-025 rule: no client write grant.
--
-- The trigger keeps the evidence honest for every writer, the service role included: a revoked grant is never revived,
-- and who / what / where / the consent snapshot never change after insert (grants are immutable except revoke; a scope
-- change is revoke + insert, as every writer already does).
--
-- Order: the route change ships first (it works with or without this migration: it writes on the service role).
-- Rollback: GRANT INSERT ON agent_grants TO authenticated; GRANT UPDATE (revoked_at) ON agent_grants TO authenticated;
--           recreate the two 0027 policies; DROP TRIGGER agent_grants_immutable ON agent_grants.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON agent_grants FROM anon, authenticated;
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_grants: self insert" ON agent_grants;
--> statement-breakpoint
DROP POLICY IF EXISTS "agent_grants: self revoke" ON agent_grants;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION agent_grants_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'agent_grants: a revoked grant stays revoked (grant %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.persona IS DISTINCT FROM OLD.persona
     OR NEW.scopes IS DISTINCT FROM OLD.scopes
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.channel_identity IS DISTINCT FROM OLD.channel_identity
     OR NEW.consent IS DISTINCT FROM OLD.consent
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'agent_grants: only revoked_at may change (grant %); revoke and insert a new grant instead', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION agent_grants_immutable() FROM PUBLIC, anon, authenticated;
--> statement-breakpoint
DROP TRIGGER IF EXISTS agent_grants_immutable ON agent_grants;
--> statement-breakpoint
CREATE TRIGGER agent_grants_immutable
  BEFORE UPDATE ON agent_grants
  FOR EACH ROW EXECUTE FUNCTION agent_grants_immutable();
--> statement-breakpoint
-- The WhatsApp store is admin / ops read only (0030); drop the default table privileges RLS does not govern.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON wa_conversations, wa_messages FROM anon, authenticated;
