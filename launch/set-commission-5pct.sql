-- ═══════════════════════════════════════════════════════════════════════════
-- Set platform commission to 5% flat across all categories (launch decision,
-- 2026-08-23). Matches packages/shared/src/categories.ts (all 500 bps).
--
-- WHERE TO RUN: Supabase Dashboard → AMClub project → SQL Editor.
-- Commission is frozen onto each order at purchase time, so this affects
-- only orders created after it runs (no orders exist yet at launch).
-- ═══════════════════════════════════════════════════════════════════════════

-- Preview current values
select slug, commission_bps from categories order by sort_order;

-- Set 5% flat
update categories
   set commission_bps = 500, updated_at = now()
 where commission_bps <> 500;

-- Verify: every row must show 500
select slug, commission_bps from categories order by sort_order;
