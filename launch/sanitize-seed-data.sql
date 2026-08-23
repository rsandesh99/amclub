-- ═══════════════════════════════════════════════════════════════════════════
-- AMClub launch sanitize — retire the Phase-1 demo/seed data before real users.
--
-- WHERE TO RUN: Supabase Dashboard → SQL Editor (executes as service role).
-- Idempotent — safe to run more than once.
--
-- Seed markers (from packages/db/src/seed.ts):
--   providers: users.phone LIKE '+9198000%'   (20 rows)
--   MSMEs:     users.phone LIKE '+9197000%'   (10 rows)
--
-- Mirrors the admin actions exactly:
--   provider suspend  → provider_profiles.status='suspended' + scheduled payouts held
--   msme suspend      → msme_profiles.deleted_at = now()  (soft delete — never hard-delete)
--
-- DO NOT delete the categories — they are the real 8-category taxonomy, not demo data.
--
-- AFTER RUNNING: redeploy on Vercel (a fresh deployment resets the ISR/Data
-- cache, so suspended providers vanish from cached pages immediately). Then
-- spot-check: open /services and one old seed provider URL logged-out.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 0. PREVIEW — run this block alone first and eyeball the counts ──────────
select 'seed_providers (expect ~20)' as what, count(*) as n
  from provider_profiles pp join users u on u.id = pp.user_id
 where u.phone like '+9198000%'
union all
select 'seed_packages (expect ~60)', count(*)
  from packages p
  join provider_profiles pp on pp.id = p.provider_id
  join users u on u.id = pp.user_id
 where u.phone like '+9198000%'
union all
select 'seed_msmes (expect ~10)', count(*)
  from msme_profiles mp join users u on u.id = mp.user_id
 where u.phone like '+9197000%';

-- ── 1. Suspend the seed providers ───────────────────────────────────────────
update provider_profiles pp
   set status = 'suspended', updated_at = now()
  from users u
 where u.id = pp.user_id
   and u.phone like '+9198000%'
   and pp.status <> 'suspended';

-- ── 2. Hold any scheduled payouts for them (none expected — belt & braces) ──
update payouts
   set status = 'held'
 where status = 'scheduled'
   and provider_id in (
     select pp.id from provider_profiles pp
     join users u on u.id = pp.user_id
     where u.phone like '+9198000%');

-- ── 3. Pause their packages ─────────────────────────────────────────────────
-- (RLS already hides packages of suspended providers; this makes intent
-- explicit and covers every other read path.)
update packages
   set status = 'paused', updated_at = now()
 where status = 'active'
   and provider_id in (
     select pp.id from provider_profiles pp
     join users u on u.id = pp.user_id
     where u.phone like '+9198000%');

-- ── 4. Soft-delete the seed MSME buyer profiles ─────────────────────────────
update msme_profiles mp
   set deleted_at = now(), updated_at = now()
  from users u
 where u.id = mp.user_id
   and u.phone like '+9197000%'
   and mp.deleted_at is null;

-- ── 4b. Retire leftover a11y/killtest fixtures ──────────────────────────────
-- The a11y scan created providers with slugs 'a11y-…-prov' and emails
-- '…@killtest.amclub'. They appear in the public catalog and sitemap.
update provider_profiles
   set status = 'suspended', updated_at = now()
 where status <> 'suspended'
   and (slug like 'a11y-%'
        or user_id in (select id from users where email like '%@killtest.amclub'));

update packages
   set status = 'paused', updated_at = now()
 where status = 'active'
   and provider_id in (
     select id from provider_profiles
      where slug like 'a11y-%'
         or user_id in (select id from users where email like '%@killtest.amclub'));

-- ── 5. VERIFY — every count below must be 0 ─────────────────────────────────
select 'active_seed_providers' as check_name, count(*) as must_be_zero
  from provider_profiles pp join users u on u.id = pp.user_id
 where u.phone like '+9198000%' and pp.status = 'active'
union all
select 'active_seed_packages', count(*)
  from packages p
  join provider_profiles pp on pp.id = p.provider_id
  join users u on u.id = pp.user_id
 where u.phone like '+9198000%' and p.status = 'active'
union all
select 'live_seed_msmes', count(*)
  from msme_profiles mp join users u on u.id = mp.user_id
 where u.phone like '+9197000%' and mp.deleted_at is null
union all
select 'active_a11y_fixtures', count(*)
  from provider_profiles
 where status = 'active'
   and (slug like 'a11y-%'
        or user_id in (select id from users where email like '%@killtest.amclub'));
