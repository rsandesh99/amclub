-- Phase-4 audit fix #3 — MSME state must be nullable.
--
-- §3.3: the MSME business step (sector/state) is skippable at signup, with a
-- profile-completeness nudge; RFQ (Phase 5) requires state + sector. The NOT NULL
-- constraint forced a fake 'XX' default that would silently break RFQ matching.
-- Make state nullable so "skipped" is honestly NULL, and normalise existing 'XX'.

ALTER TABLE msme_profiles ALTER COLUMN state DROP NOT NULL;
--> statement-breakpoint
UPDATE msme_profiles SET state = NULL WHERE state = 'XX';
