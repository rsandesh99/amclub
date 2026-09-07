-- AMC Mart — Launch Gate config (STAGED with 0022/0023/0024; deploys with the
-- MART_ENABLED=true release). Founder decision §9.2 "who pays return freight"
-- becomes a per-category config column read by the product page note and the
-- return flow copy. Idempotent; re-runnable.
ALTER TABLE mart_categories ADD COLUMN IF NOT EXISTS return_freight_payer text NOT NULL DEFAULT 'seller';
--> statement-breakpoint
ALTER TABLE mart_categories DROP CONSTRAINT IF EXISTS mart_categories_freight_payer_check;
--> statement-breakpoint
ALTER TABLE mart_categories ADD CONSTRAINT mart_categories_freight_payer_check CHECK (return_freight_payer IN ('seller', 'buyer', 'split'));
