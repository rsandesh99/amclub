# Compliance status — pre-cutover sprint closeout (2026-08-28)

Single view of every legal/regulatory/operational item that gates real money
and real users. **Owner** is who moves it; **next date** is when it is next
reviewed or due. `FOUNDER_FILL` marks facts only the founder can supply.

| Item | Status | Evidence / where it lives | Owner | Next date |
|---|---|---|---|---|
| Grievance Officer displayed (name, designation, address, phone, email) — IT Rules 2021 r.3(2)(a), E-Commerce Rules 2020 r.4(4)-(5) | **LIVE** (2026-08-28, `45f2784`) | `/grievance`, `/terms`, `/help`; facts in `apps/web/lib/legal/grievance.ts` | Founder (officer of record) | Counsel review — FOUNDER_FILL |
| Grievance commitments: acknowledge ≤ 24 h, resolve ≤ 15 days (stricter of both regimes) | **LIVE** | Same pages; `GRIEVANCE_SLA` constant; privacy §8 converged | Founder | Ongoing — every grievance logged with a reference number |
| Terms of Service + Privacy Policy acceptance captured per user, versioned | **LIVE** (`terms_acceptances`, `LEGAL_VERSIONS` terms/privacy `2026-07-07`) | Signup checkbox (web + mobile), API-level gate on profile creation, re-acceptance modal for existing users | Engineering | On any doc change → bump `LEGAL_VERSIONS` |
| Provider Addendum (escrow, AMC Score, buyer rating, auto-decline, data use) | **LIVE — DRAFT FOR COUNSEL** (v `2026-08-28`) | `/provider-addendum`; accepted by every provider at onboarding + on version bump | Founder → counsel | Counsel review — FOUNDER_FILL |
| Legal copy counsel review (terms, privacy, refund, addendum, grievance page) | **PENDING** | Files carry `DRAFT FOR COUNSEL REVIEW` comments | Founder | FOUNDER_FILL |
| Razorpay Route activation on the live account | **PENDING** — blocks live cutover | ADR-003 checklist; `docs/ROUTE_ONBOARDING.md` §1 | Founder | Before live cutover — FOUNDER_FILL |
| Route linked account per active provider (`razorpay_route_account_id`) | **IN PROGRESS** — 0 active providers today; 1 under review lacks a Route id | Admin dashboard tile "Payout-ready providers" = worklist; `/admin/providers?readiness=unready` | Founder/ops | Same day as each approval (option ii promise) |
| Penny-drop bank verification — KYC vendor (`KYC_API_KEY`, Surepass/Signzy) | **PENDING** — blocks live cutover; manual audited override in use meanwhile | `bank_account_verifications` (vendor vs `admin_override` always distinguishable) | Founder | Before live cutover — FOUNDER_FILL |
| Razorpay live keys + webhook registration (retires simulate mode) | **PENDING** | ADR-003 cutover procedure; `rzp_live_` guard in `lib/payments/index.ts` | Founder + engineering | Cutover date — FOUNDER_FILL |
| Payout approval gate (`PAYOUT_AUTO_RELEASE=false`) | **LIVE by decision** | ADR-002; every payout born `held`; admin release settles immediately | Founder | Revisit once provider trust is established (ADR required to change) |
| TDS (Sec 194-O) / GST-on-commission structure — CA engagement | **PENDING** | Provisional 18 % GST on commission in `computeOrderAmounts` / invoices; `tcs_paise` readiness column exists; §9.1 requires CA sign-off before go-live | Founder | FOUNDER_FILL (engage CA before first real-money order) |
| Incorporation / entity status (name on invoices, GSTIN of the platform, signatory for Razorpay) | **FOUNDER_FILL** | Invoices currently name the platform generically | Founder | FOUNDER_FILL |
| DPDP: consent capture, voice audio not retained, data-export/erasure endpoint | **PARTIAL** — consent + no-retention LIVE; export/erasure endpoint NOT built (security audit F7/F8) | `docs/SECURITY_AUDIT.md`; `docs/FOLLOWUPS.md` | Engineering | Before pilot scale — schedule as Phase 5 item |
| Security posture (headers, RLS last line, secrets, rate limits) | **LIVE** — audit F1–F5, F9 fixed; F6, F10–F12 held | `docs/SECURITY_AUDIT.md`, `verify-authz.ts` (88 checks) | Engineering | Re-run suites every phase; human pen-test before real-money scale |
| Cron liveness (auto-cancel, auto-accept, rfq-expire, reconcile, payouts, provider-stats) | **LIVE** — `CRON_SECRET` must be set in Vercel | `/admin` heartbeat panel | Engineering | Check panel weekly |
| Test-data hygiene (no kill-test residue in prod) | **LIVE** | `cleanup-test-data.ts` dry run after each session | Engineering | Every phase |

## How to use this file
- Update the **Status** cell in the same commit as the change that moves it.
- A `PENDING` item marked *blocks live cutover* must be `LIVE` before the
  `rzp_live_` guard is removed (ADR-003).
- `FOUNDER_FILL` cells are facts the repo cannot know; fill them, don't guess.
