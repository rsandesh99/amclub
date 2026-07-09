# Backup & restore runbook — Phase 8 §3

**Drill executed:** 2026-07-09, on a scratch PostgreSQL 17.10 instance, against a live logical dump. Nothing below is theoretical unless explicitly marked.

## Backup tier — current state + founder decision

The plan tier is **not verifiable from the repo** (Supabase dashboard → Settings → Billing). What the tiers mean for us ([pricing](https://supabase.com/pricing), [backups docs](https://supabase.com/docs/guides/platform/backups), [PITR docs](https://supabase.com/docs/guides/platform/manage-your-usage/point-in-time-recovery)):

| Tier | Automated backups | RPO (worst-case data loss) | Cost |
|---|---|---|---|
| Free | **NONE** | unbounded — whatever we dump ourselves | ₹0 |
| **Pro** ← recommended before pilot | daily, 7-day retention | 24 h | **$25/mo** |
| Pro + PITR add-on | WAL-based point-in-time | ~2 min | +**$100/mo** per 7-day window (needs ≥ Small compute) |

**Recommendation:** Pro at pilot (real money + real KYC data with a 24 h RPO floor is the minimum defensible posture). PITR is NOT required for pilot volumes — revisit at >100 orders/day, where replaying a lost day stops being feasible. So: PITR does require the Pro upgrade, but the $25/mo Pro tier alone (not the $100/mo add-on) is the pilot decision.

Until Pro is confirmed: run the ad-hoc dump below before every schema change and at least daily (it took **4.9 s**; there is no excuse to skip it).

## Measured drill results (2026-07-09)

| Step | Time | Result |
|---|---|---|
| `pg_dump` of live public schema (-Fc) | **4.9 s** | 183 KB |
| Full local restore sequence (createdb → shim → `pg_restore` → auth backfill) | **0.9 s** | 32 tables · **61/61 RLS policies** · RLS enabled on 32/32 tables · row counts match live (8 categories / 62 packages / 23 providers / 39 users) |
| Fresh-DB rebuild — `db:bootstrap` (15 migrations + RLS, one command) | ~8 s | **schema + policies byte-identical to live** (see drift note) |
| **Data-layer RTO at current size** | **< 6 s** | grows with data; re-measure at pilot scale |

End-to-end RTO to a *serving* system also includes: create Supabase project (~2 min), repoint `DATABASE_URL`/`NEXT_PUBLIC_SUPABASE_URL`/keys in Vercel, redeploy (~3 min), DNS nothing (Vercel URL unchanged). Realistic total: **~15–20 min**, dominated by project provisioning and env swaps, not data.

### Drift found by the drill (and fixed)

Diffing the migration-built schema against the live dump surfaced one drift: live's `order_safe_view` was created before migration 0008 and lacked `orders.external_wait_since` (a `SELECT o.*` view freezes its column list). No app code reads that view today, so zero user impact — but `CREATE OR REPLACE VIEW` also can't fix it (42P16). `rls/policies.sql` now does `DROP VIEW IF EXISTS` first; re-applied to live 2026-07-09; **RLS suite re-run: 7/7 pass**. This is exactly the class of bug restore drills exist to find.

## Runbook A — restore to a NEW Supabase project (the real disaster path)

1. Dashboard → New project (same region `ap-south-1`). Note the new `DATABASE_URL` (Session pooler, port 5432), anon + service-role keys.
2. If on Pro: Dashboard → Database → Backups → Restore (into the same project), **or** download the backup and continue with step 3 against the new project.
3. From a logical dump (works on every tier):
   ```bash
   # dump (from the old/live DB — session pooler URL, NOT the 6543 transaction pooler)
   pg_dump --dbname="$OLD_DATABASE_URL" -n public -Fc -f amclub.dump
   # restore into the new project
   pg_restore --dbname="$NEW_DATABASE_URL" --no-owner --no-privileges amclub.dump
   ```
   (On a real Supabase target the `auth` schema/roles already exist — no shim, and the `users_id_auth_fk` restores cleanly only after auth users are migrated; see step 4.)
4. **Auth users live in the `auth` schema and are NOT in this dump.** Migrate them via Dashboard → Authentication → Users export/import, or `supabase db dump --db-url … -s auth` on Pro/CLI. Restore auth BEFORE the public data if you want the FK to attach first time; otherwise attach it after (`INSERT`-then-`ALTER` as in the drill).
5. Storage objects (credential uploads, deliverables): copy bucket contents via the Storage API (service keys of both projects) — `apps/web/scripts` has upload plumbing to crib from. Buckets/policies are recreated by `setup-storage.ts`.
6. Point Vercel env at the new project (URL, anon, service-role, `DATABASE_URL`), redeploy, then run:
   ```bash
   pnpm --filter @amclub/db db:test-rls   # 7/7 must pass
   npx tsx apps/web/scripts/verify-money-loop.ts   # core lifecycle
   ```

## Runbook B — local forensic restore (what the drill executed)

For inspecting a backup without touching any live system (binaries: any PostgreSQL 17 client works):

```bash
initdb -D ./pgdata -U postgres && pg_ctl -D ./pgdata -o "-p 5533" start
psql -p 5533 -U postgres -c "CREATE DATABASE amclub_restore"
psql -p 5533 -U postgres -d amclub_restore -f shim.sql   # auth schema + uid() + roles; see scripts/bootstrap.ts SUPABASE_SHIM
pg_restore -p 5533 -U postgres -d amclub_restore --no-owner --no-privileges amclub.dump 2>errors.txt
psql -p 5533 -U postgres -d amclub_restore -c "INSERT INTO auth.users(id) SELECT id FROM public.users ON CONFLICT DO NOTHING;
  ALTER TABLE public.users ADD CONSTRAINT users_id_auth_fk FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;"
```

Expected benign errors: `schema "public" already exists`; the FK attach is the two-liner above. **Always check `errors.txt`** — the drill's first pass looked "done" while a broken pipe had silently truncated it; count policies (`SELECT count(*) FROM pg_policies` → 61) before trusting a restore.

Note: the supabase-js RLS *test suite* cannot run against bare Postgres (it needs Auth + PostgREST) — run it after Runbook A, not B. Runbook B verification is SQL-level: table/policy counts + row-count spot checks vs live.

## Runbook C — fresh database from migrations (ONE command)

```bash
pnpm --filter @amclub/db db:bootstrap -- --url postgres://…/newdb
```

Applies `0000…0014` in order (statement-breakpoint aware) + `rls/policies.sql`; auto-shims `auth.*`/roles on non-Supabase targets. This replaces the audit's "run 14 files by hand" gap. Verified: output schema and policy set are identical to the live DB (one-line diff was the drift fixed above). New migrations are picked up automatically (directory scan, sorted).

## Standing hygiene

- Re-run this drill each phase (it takes minutes) and after any migration touching `orders`, `payments`, `payouts`.
- The dump contains PII + bank rows — treat dump files as secrets; never commit; delete after drills (`amclub-live.dump` was deleted after this one).
- `supabase` CLI + access token would let us script project-to-project restores; not installed on the dev machine today.
