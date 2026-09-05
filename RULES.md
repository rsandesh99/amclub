# RULES.md — always-on rules for anyone (human or AI agent) changing this repo

These are not preferences. They were each earned by a real incident or a real
money/legal constraint during the pre-cutover hardening sprint (Aug 2026).
`CLAUDE.md` carries the architecture; this file carries the non-negotiables.
Break one only with a founder decision recorded as an ADR in `docs/adr/`.

## Database
1. **Additive-only migrations.** Never drop or rename an existing column or
   table; never change a column's type in place. Add nullable columns, new
   tables, new views. Existing rows and flows must be untouched by a migration.
2. **Migrations deploy with their writers — same push.** Never apply a
   migration to prod and leave the code that writes to it unpushed
   ("migration-first, approval-later" lost quote history once). If verification
   needs the table before push, run it against a local server on the prod DB
   and push immediately after the green run. Every new migration also adds its
   principal objects to the manifest in `apps/web/scripts/verify-migrations.ts`
   — part of its definition of done (the script fails on unmanifested files).
3. **Append-only event tables never gain UPDATE paths.** `order_events`,
   `quote_events`, `terms_acceptances` (and any future `*_events`): new facts
   are new rows. Keep the `BEFORE UPDATE` trigger, keep UPDATE/DELETE revoked
   from client roles, keep RLS without write policies. Correct a mistake with a
   compensating row, never an edit.
4. **RLS on every new table**, mirrored in `packages/db/src/rls/policies.sql`.
   Client roles get only what the policy says; the service role is server-only.

## Money
5. **`apps/web/lib/payments/payout.ts` is the only money-out path.** Dispute
   settlement, admin release, and cron all call `runPayouts`; nothing else may
   create a transfer. Payouts release only from `completed` /
   `resolved_release` / `resolved_partial`.
6. **A real gateway fails loudly; it never simulates.** With real Razorpay keys
   a missing Route account throws and the payout goes `failed` — visible in
   `/admin/payouts`. Simulation exists only in the mock gateway.
7. **`PAYOUT_AUTO_RELEASE` stays OFF** unless a founder decision turns it on,
   recorded as an ADR (today: ADR-002). No auto-release anywhere else.
8. **Refunds are insert-first and key-guarded** (`rfnd_<order_id>`); one
   refund per order; the gateway receipt carries the key. Do not reorder the
   gateway call before the row.
9. **Payout readiness has one definition:** `apps/web/lib/payments/readiness.ts`
   (`ready | missing_route | bank_unverified | not_ready | no_bank`). Every
   surface — providers list, provider detail, payouts monitor, verification
   queue, provider banners, `/profile/me` — reads it. No forks, no local
   re-derivations.
10. **`penny_drop_verified` is server-set.** From a recorded `/kyc/verify-bank`
    result or the audited admin override (`bank_account_verifications.provider
    = 'admin_override'`, reason required). Never from a client-sent flag.

## Product invariants
11. **State machines live in one place** (`packages/shared/src/state-machines.ts`);
    the API rejects illegal transitions. Transitions may be extended, never
    repurposed.
12. **Legal versions are one constant** (`LEGAL_VERSIONS` in `@amclub/shared`).
    Pages, the re-acceptance modal, and `terms_acceptances` rows all read it.
    Profile creation refuses without current-version acceptance rows.
13. **Grievance facts live in `apps/web/lib/legal/grievance.ts` only.** The
    officer, address, phone and the 24 h / 15 d commitments are rendered from
    there; never inline them in copy.
14. **i18n everywhere** — every user-visible string has `en` and `hi` keys.
15. **No fabricated stats on trust surfaces.** A number shown to buyers must be
    computed from real events (e.g. `median_response_minutes` from the nightly
    cron with a ≥3-quote gate) or not shown at all.

## Every change, every phase
16. **Done means:** typecheck (web, shared, db, mobile) + lint clean; the shared
    unit tests; and the verification suites that touch what you changed
    (`verify-authz.ts`, `verify-money-loop.ts`, `verify-rfq.ts`, …) green
    against a local server on the prod DB — then, after push, again against
    the deployed URL.
17. **Zero prod residue.** Scripts create kill-test tenants and delete them in
    `finally`; run `cleanup-test-data.ts` (dry run) after a session and fix any
    script that leaves rows.
18. **Diff summary + verification output, then wait for founder approval
    before pushing.** Pushing deploys production.
19. **Additive everywhere:** never rewrite a working flow to add a feature;
    extend it. Optional fields are optional end-to-end (API, DB, UI).
20. **Log follow-ups, don't half-build them** — `docs/FOLLOWUPS.md`.
