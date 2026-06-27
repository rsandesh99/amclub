-- LOCK 5 (provider-vs-government time, §3.7/§4.3) — mark time an in-progress
-- order is blocked on an external party (government portal, registrar, bank).
-- Display sub-state only: the canonical order status stays `in_progress`, so
-- the §3.7 transition map and payout-release set are untouched (§8.4-safe).
-- Additive + nullable; backfill = NULL.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_wait_since timestamptz;
