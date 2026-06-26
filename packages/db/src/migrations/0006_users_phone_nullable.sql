-- Auth-bugfix — users.phone must be nullable.
--
-- The schema assumed phone-primary auth, but email + Google users have no phone.
-- upsertUserRow inserted phone=NULL into a NOT NULL column → the public.users row
-- was never created → getSessionUser returned null → "Unauthorized" on profile
-- save. Make phone nullable; require at least one of phone/email for identity.
-- (UNIQUE on phone still holds — multiple NULLs don't conflict in Postgres.)

ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_or_email_present;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_phone_or_email_present
  CHECK (phone IS NOT NULL OR email IS NOT NULL);
