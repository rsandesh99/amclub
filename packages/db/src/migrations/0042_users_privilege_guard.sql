-- Security hotfix — users table privilege guard (docs/USER_EXPECTATIONS_AUDIT.md P0-1).
--
-- Before: "users: owner all" was FOR ALL with no column privilege or trigger
-- protecting users.roles, and client roles kept the default table grants. Any
-- signed-in user could `update users set roles = '{admin}'` through PostgREST
-- with the anon key + their own JWT (has_role(), middleware and the admin
-- layout all trust users.roles), and could DELETE their own row.
--
-- After: the owner may only SELECT their row; INSERT/UPDATE/DELETE are revoked
-- from anon + authenticated. Every legitimate write already goes through the
-- service role (lib/auth/session.ts upsertUserRow, api/v1/legal/accept), which
-- keeps its grants. A BEFORE UPDATE trigger refuses any roles change made by a
-- client role, so a future grant regression still cannot mint an admin.
--
-- Rollback: DROP TRIGGER users_roles_guard ON users; DROP FUNCTION
-- users_roles_guard(); DROP POLICY "users: owner read" ON users;
-- GRANT INSERT, UPDATE, DELETE ON users TO authenticated; and recreate
-- "users: owner all" as it was in rls/policies.sql before this change
-- (not recommended — it reopens the escalation).

DROP POLICY IF EXISTS "users: owner all" ON users;
--> statement-breakpoint
DROP POLICY IF EXISTS "users: owner read" ON users;
--> statement-breakpoint
CREATE POLICY "users: owner read" ON users
  FOR SELECT USING (id = auth_user_id());
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON users FROM anon, authenticated;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION users_roles_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.roles IS DISTINCT FROM OLD.roles AND current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'users.roles can only be changed by the platform'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS users_roles_guard ON users;
--> statement-breakpoint
CREATE TRIGGER users_roles_guard
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_roles_guard();
