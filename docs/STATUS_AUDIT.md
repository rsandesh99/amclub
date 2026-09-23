# AMClub — Present-Status Audit

**Date:** 2026-07-07 · **Auditor:** automated code audit (Claude Code) · **HEAD:** `632c4e4`
**Method:** every claim below is backed by a file/line reference, a command run during this audit, or an explicit "unverified" tag. Commands were run against the working tree at HEAD; DB probes ran read-only (plus the standard kill-test suites, which clean up after themselves).

**Scope caveat up front:** `docs/PRE_LAUNCH_CHECKLIST.md` — which this audit was asked to read — **does not exist** in the repo. Neither does the "§10 / v1.1" architecture section referenced in an earlier instruction (recorded instead under DESIGN.md §Phase 8b). The only launch checklist today is the per-phase done-criteria in `docs/DESIGN.md` §6. Creating a real pre-launch checklist is itself a gap.

---

## 1. REALITY vs CLAIMS

Done-criteria from `docs/DESIGN.md` §6 (lines 659–706) checked against the current tree.

| Item | Claimed | Actual | Evidence |
|---|---|---|---|
| **P0** monorepo + deploy | ✅ | ✅ Deploys on every push; prod live | `turbo.json`, amclub-web.vercel.app (checked this session) |
| **P0** CI pipeline | ✅ | ❌ **CI has never run** — workflow triggers on `main`/`develop`; repo branch is `master`. If it ran, it would fail (`turbo run typecheck` includes broken `@amclub/db`) | `.github/workflows/ci.yml:4-7`, typecheck output below |
| **P0** locale switch | ✅ | ✅ web (4 locales) / ❌ **mobile: no switcher rendered anywhere** — `setLocale` defined but never called; hi.json unreachable, app is en-only | `apps/mobile/lib/i18n.tsx:26` (only definition; zero consumers) |
| **P0** PostHog event fires | ✅ | ✅ gateway + voice funnels wired client-side | `components/gateway/Gateway.tsx:76-78` |
| **P1** RLS suite passes | ✅ | ✅ **Re-ran 2026-07-07: 7/7 pass** (cross-MSME orders, unverified provider hidden, anon sees active packages only, rfq_matches scoped) | `pnpm --filter @amclub/db db:test-rls` output |
| **P1** migrations | ✅ | ✅ 0000–0013 applied. ⚠️ 0001+ are hand-written SQL applied via `apply-sql.ts`, **not journaled** — `drizzle-kit migrate` cannot rebuild a fresh DB; disaster-recovery path is "run 14 files by hand in order" | `packages/db/src/migrations/`, `meta/_journal.json` (0001+ absent) |
| **P2** provider e2e (signup→approve→live) | ✅ | ✅ code paths intact; proven by `verify-signup-loop.ts` / `repro-provider-submit.ts` (last known green Phase 2/3; not re-run today) | `apps/web/scripts/` |
| **P2** phone OTP (MSG91) | ✅ | ⚠️ Server proxy + rate limits + captcha pass-through are solid. **Actual SMS delivery depends on Supabase dashboard SMS-provider config — unverifiable from repo.** Email OTP works | `app/api/v1/auth/otp/route.ts:8-16` |
| **P2** KYC (GSTIN/bank) | ✅ | ⚠️ Stub unless `KYC_API_KEY` is a real key — wizard shows "dev stub" verified state | `lib/kyc/stub.ts:13,27`, `ProviderWizard.tsx:458` |
| **P3** search <300ms p95 | ✅ | ✅ functionally correct in prod (returned 3 real AP tax providers, 2026-07-05); **p95 not re-measured** | Phase 8a smoke tests |
| **P3** Lighthouse ≥90 | ✅ | ✅ measured on `/` 2026-07-05: Perf 90 / A11y 100 / SEO 91 (mobile, 4G). **Category page not re-measured since Phase 3** | Phase 8a acceptance run |
| **P3** ISR | ✅ | ✅ revalidate on all public surfaces (3600/300/86400) | `(public)/services/[category]/page.tsx:14` etc. |
| **P4** money loop | ✅ | ✅ **Re-ran kill-test 2026-07-07: 13/17 pass.** Lifecycle, illegal-transition rejection, payout scheduling, both invoice PDFs, 100%-refund-on-cancel all green. The 4 failures are both cron legs — see next row | `verify-money-loop.ts` output |
| **P4** jobs (auto-accept, payouts, reconcile…) | ✅ | ⚠️ Implemented as **Vercel crons, not pg-boss** (deviation properly recorded in `docs/adr/001-vercel-cron-over-pgboss.md`). **But:** `verifyCron` denies everything in production unless `CRON_SECRET` is set, and `CRON_SECRET` is **not in `.env.example`** — whether it's set in Vercel is unverifiable from the repo. If unset, all 5 crons (auto-cancel→refund, auto-accept→payout, rfq-expire, reconcile, payout batch) are silently dead in prod. DB heartbeat probe today found 0 stale rows (weak-positive — traffic is low enough that this proves little) | `lib/jobs/cron-auth.ts:11-12`, `apps/web/vercel.json:3-9`, heartbeat probe output |
| **P4** webhook replay safe | ✅ | ✅ signature check + idempotent materialize; kill-test scripts exist (`killtest-webhook-replay.ts`, `killtest-dropped-webhook.ts`; last known green Phase 4, not re-run today) | `app/api/v1/webhooks/razorpay/route.ts:26` |
| **P4** real payments | ✅ (test mode) | ⚠️ **Active path in prod is `simulate`** — orders are created by `/api/v1/checkout/simulate`, not by Razorpay webhooks, until real keys land | `app/api/v1/checkout/route.ts:232`, `checkout/simulate/route.ts:12` |
| **P5** RFQ engine | ✅ | ✅ atomic quote-slot claim, 7-cap, fan-out (re-proven 2026-07-06 with `matched=1` real provider), contact masking wired | `api/v1/rfq/[id]/quote/route.ts:99`, `quotes/[quoteId]/messages/route.ts:85` |
| **P6** WhatsApp template in sandbox | ✅ | ❌ **Never done.** WhatsApp channel is a stub that logs "would send"; no Gupshup/Interakt integration exists. The done criterion was reported met but the code cannot deliver a sandbox message | `lib/notifications/channels.ts:88-92` |
| **P6** reviews / coupons / CMS | ✅ | ✅ reviews live; coupons code-complete but flag-OFF; CMS hero live | `lib/flags.ts`, `CheckoutClient.tsx:148` |
| **P7** dispute e2e, commission freeze, audit log | ✅ | ✅ paise-exact resolution lib + admin console + append-only audit_logs | `lib/disputes/resolve.ts`, `schema/engagement.ts:110` |
| **P7** payout monitor | ✅ | ⚠️ **No dedicated payout monitor UI.** Payout state is visible only inside individual admin order/dispute pages; there is no `/admin/payouts` queue (grep of `(admin)` for "payout": 2 files, both detail pages) | route list; `app/[locale]/(admin)/` |
| **P8** hardening (axe, k6, PWA, restore rehearsal, OWASP) | — | ❌ **Phase 8 was skipped.** No k6 scripts, no PWA manifest/service worker, no recorded axe run, no restore-from-backup rehearsal, no security checklist. 8a/8b were built instead. This is the largest claims-vs-reality gap | glob `manifest*/sw*/k6*` → 0 files |
| **P8a** gateway | ✅ | ✅ re-verified 2026-07-05 (choreography, real search, Lighthouse, funnel events). te/ta strings still **draft, pending native review** | `messages/te.json`/`ta.json` `_comment` |
| **P8b** voice RFQ | ✅ | ✅ verified 2026-07-06 (31 checks) + live in stub mode. ⚠️ Sarvam REST tier documented for clips <~30s vs our 60s cap — unresolved until real-key testing. ⚠️ Verification scripts lived in session scratchpad and were **not committed** — not repeatable | this audit's session records; `docs/DESIGN.md` §8b |

---

## 2. JAGGED-EDGES INVENTORY (UI/UX debt — input for a QA engagement)

### Blockers (block a real-user, real-money pilot)

| # | Surface | Defect | Evidence |
|---|---|---|---|
| B1 | Checkout (real-money mode) | After Razorpay opens, success handler redirects to `/app/orders?processing=1` — **no page reads `processing`**; with webhook lag the buyer lands on a list without their paid order, no banner, no poll. Also no `modal.ondismiss` handler: closing the Razorpay sheet leaves the user on checkout with zero feedback. Invisible today only because simulate mode is active | `CheckoutClient.tsx:118`, grep `processing` in `(msme)/app/orders` → 0 hits |
| B2 | Legal / trust | **No /terms, /privacy, /refund pages exist and nothing links to them** — required for Razorpay live onboarding, DPDP compliance, and §9 launch prereqs. Voice consent line references processing but there is no privacy policy behind it | grep `/terms|/privacy|/refund` in apps/web → 0 hits |
| B3 | Ops | `CRON_SECRET` absent from `.env.example`; if also absent from Vercel, refunds (auto-cancel), auto-accept→payouts, RFQ expiry, and reconciliation are all silently dead in prod (every cron 403s). **Must be verified in the Vercel dashboard before pilot** | `lib/jobs/cron-auth.ts:11-12` |
| B4 | Auth (phone) | Phone-OTP delivery unverifiable from repo (Supabase SMS provider config); if unconfigured, the **primary auth method for the target user** silently fails while email works. Needs one real-device test | `auth/otp/route.ts` |

### High

| # | Surface | Defect | Evidence |
|---|---|---|---|
| H1 | Whole app (te/ta users) | te/ta locales are selectable at the gateway but **only `gateway` + `voice` namespaces are translated** — a Telugu user who signs up gets an English app (catalog, RFQ, orders, auth all fall back to en). Either translate the core journeys or scope te/ta to the gateway | `messages/te.json` (2 namespaces vs 34 in en.json) |
| H2 | Mobile (whole app) | No language switcher → Hindi catalog (`hi.json`) unreachable; mobile is English-only in practice | `apps/mobile/lib/i18n.tsx:26`, zero `setLocale` callers |
| H3 | All action surfaces | **No toast/snackbar system exists.** Mutations either show inline text or nothing; several admin actions use raw `alert('Failed')` | grep `toast` in components → 0; `admin/orders/[id]/page.tsx:31`, `admin/providers/[id]/page.tsx:32` |
| H4 | Notifications | Bell loads once on mount — no polling, no Supabase Realtime (despite §2.2 listing Realtime). Unread badge is stale until full reload | `NotificationCenter.tsx:32` |
| H5 | Mobile lists | API helpers swallow failures and return `[]` — network errors render as (or into) empty states with no error message and no retry on search, RFQ list, orders, notifications | `apps/mobile/lib/api.ts:65,137,163` pattern |
| H6 | RFQ templates (i18n) | Category `rfq_template` field labels exist only as `label_en`/`label_hi` — te/ta (web) fall back to English; and templates ignore the mobile switcher gap (H2) | `packages/shared/src/rfq.ts:13-14`, `RfqForm.tsx` `label()` |
| H7 | Accessibility (unknown ≠ fine) | axe was never run on the app shell (only the gateway's Lighthouse a11y 100 exists). Icon-only buttons, focus order in the 7-step provider wizard, contrast of `text-foreground-secondary` — all unaudited | Phase 8 skip (Section 1) |
| H8 | Admin | No payout-monitor queue (P7 claim); ops cannot see failed/held payouts except by opening individual orders | route list |

### Medium

| # | Surface | Defect | Evidence |
|---|---|---|---|
| M1 | Mobile screens | Hardcoded English literals: "Not found" ×3, "FAQs" ×1 | `package/[…].tsx:32,102`, `orders/[id].tsx:50`, `provider/[slug].tsx:52` |
| M2 | Admin | Dates rendered without IST timezone (server renders in UTC → off-by-one near midnight): coupons `valid_to`, disputes list `created_at` | `CouponsClient.tsx:130`, `admin/disputes/page.tsx:49` |
| M3 | Auth + gateway route groups | No `error.tsx`/`loading.tsx` — a thrown error on login/signup/gateway bubbles to the root handler (blank-ish page), unlike the four other groups which have both | glob: only `(msme)/(provider)/(admin)/(public)` have them |
| M4 | Mobile parity | Web-only design system: elevation/press feedback, styled select, CMS hero — already tracked in `docs/MOBILE_PARITY.md` (3 items, none closed since 2026-06-29). Mobile also has **no gateway/onboarding wizard** equivalent — first-run drops straight to login | `docs/MOBILE_PARITY.md` |
| M5 | Voice (mobile) | Recorder uses hardcoded hex colors (`#1B4D3E`, `#B45309`) instead of tokens; recording has no waveform/pulse (web has pulse) — spec asked for "live waveform or pulse" on both | `apps/mobile/components/VoiceRfqRecorder.tsx:139,167` |
| M6 | Voice (both) | te/ta voice + gateway strings are machine-draft pending native review — a Telugu speaker is greeted in possibly-awkward Telugu at the single most trust-sensitive moment (first visit + consent line) | `messages/te.json` `_comment` |
| M7 | Gateway | Voice mic on the results screen is a gate-to-signup tease (by design, since paid STT needs auth) — expect drop-off/frustration; needs copy/UX validation with real users | `RevealResults.tsx` voiceGate block |
| M8 | Checkout | Coupon input hidden by flag (fine), but GST-invoice GSTIN input does no checksum validation client-side (server Zod has the regex; user learns only on submit) | `CheckoutClient.tsx:163+` |
| M9 | Search page (app) | `/app/search` exists separately from public `/services` listing — two search UIs to keep consistent; no recent-searches/suggestions on either | route list |
| M10 | Provider wizard | 7 steps with no progress persistence warning on tab close; bank re-entry required after validation errors (drafts intentionally exclude bank numbers — correct, but the UX cost is invisible re-typing) | `ProviderWizard.tsx:50` |

### Low

| # | Surface | Defect |
|---|---|---|
| L1 | Buttons | `size="sm"` = 36px height — below 44px tap-target guidance where used on touch surfaces (`button.tsx:47`) |
| L2 | Gateway | LCP 3.6s on 4G budget (choreography-driven; passed 90 but no headroom) |
| L3 | Admin categories | Inline error string hardcoded `'Failed'` (`admin/categories/page.tsx:49`) |
| L4 | Seed data | 20 demo providers live in the prod catalog (intentional per founder decision; flag for pilot-day review) |
| L5 | Icons/imagery | `<img alt="">` on CMS banners is correct for decorative use, but banner content authored in CMS has no alt-text field at all (`admin/cms/page.tsx:213`) |

---

## 3. STUBS & FLAGS REGISTER

Env names exist in `.env.local`/Vercel but **presence of a name ≠ live key** — the runtime checks below decide. "To go live" = everything needed, not just the key.

| Capability | Current state | Switch | To go live |
|---|---|---|---|
| SMS (MSG91) | **STUB** — logs "would send", never bills | `MSG91_AUTH_KEY` + code at `channels.ts:83` is `TODO(go-live)` | Real key **+ write the MSG91 call** + DLT template registration |
| WhatsApp (Gupshup/Interakt) | **STUB** (`channels.ts:88-92`) | `WHATSAPP_API_KEY` | Key + build template send + WABA/template approval (days-weeks lead time) |
| Web Push | **STUB** `not-implemented` (`channels.ts:95`) | — | Out of V1 scope per code comment |
| Email (Resend) | **LIVE code path** | `RESEND_API_KEY` | Verify key is real in Vercel; domain/DKIM for deliverability (currently `onboarding@resend.dev` fallback sender — `channels.ts:53`) |
| Razorpay payments | **SIMULATE mode active** — orders via `/checkout/simulate` | `gateway.isReal` ← `RAZORPAY_KEY_ID/SECRET` | Live keys + webhook secret + configure webhook URL + **Razorpay Route onboarding for split payouts** + kill-tests re-run in test mode |
| Payout transfers | Follows Razorpay mode (transfer objects only real when gateway real) | same | Same as above + provider bank verification real (KYC below) |
| KYC (GSTIN/bank) | **STUB** (`lib/kyc/stub.ts`) — providers get "Stub Business Pvt Ltd" | `KYC_API_KEY` | Surepass/Signzy contract + key; re-verify existing provider rows created under stub |
| CAPTCHA (Turnstile) | Widget skipped when site key unset; enforcement lives in **Supabase dashboard** | `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | Set site key + enable CAPTCHA in Supabase Auth settings |
| Rate limiting | **LIVE in production (verified 2026-09-23)** — both vars set for Production + Preview (Upstash `amclub-ratelimit`, AWS ap-south-1, eviction off); 70 cache-busted searches on amclub.in → 60 × 200 + 10 × 429, `rl:search` keys written, no "rate limiting is DISABLED" log line. *(Originally: no-op without Upstash, prod unverified.)* | `UPSTASH_REDIS_REST_URL/TOKEN` | Done. Before the pilot: move Upstash off the free tier (500K commands/month; at the cap Upstash refuses requests and every limited route errors). To re-test, give each request a unique query param: `/catalog/search` is CDN-cached (`s-maxage=60`), so identical URLs never reach the limiter |
| Voice STT (Sarvam) | **STUB** — fixed Guntur/GST transcript, "(Demo mode)" label | `SARVAM_API_KEY` | Key + real-device test incl. >30s clips (REST-tier limit question) |
| Voice parse (OpenRouter) | **STUB** — keyword heuristic | `OPENROUTER_API_KEY` | Key (+ optional `VOICE_PARSE_MODEL`); verify JSON mode on chosen model |
| Voice cost estimates | STT costs log as `null` | `SARVAM_COST_PAISE_PER_MIN` | Set once Sarvam pricing known |
| Coupons | Code-complete, **flag OFF** | `COUPONS_ENABLED=true` | Flip + re-run coupon money tests |
| Gateway | **ON** (default) | `GATEWAY_ENABLED=false` serves LegacyLanding | Kill-switch needs redeploy (`/` is SSG) |
| Crons ×5 | Routes + schedules exist | `CRON_SECRET` | **Verify set in Vercel** (see B3) |
| Phone OTP delivery | Unknown | Supabase dashboard SMS provider | Configure MSG91 in Supabase + one real-device OTP test |

---

## 4. CODE-HEALTH SNAPSHOT (all commands run 2026-07-07)

**Typecheck** (`pnpm typecheck`):
- `@amclub/shared` ✅ · `@amclub/web` ✅ · `@amclub/mobile` ✅
- `@amclub/db` ❌ ~40 errors: pre-existing strictness debt in `seed.ts`/`test-rls.ts` (TS4111/TS18048/TS2532) **plus one regression introduced by the Phase 8b commit**: `schema/engagement.ts:141-142` uses `index(...)` without importing it (runtime-harmless — migrations are raw SQL — but it keeps the package red)

**Lint**:
- Root `pnpm lint` ❌ **has never been runnable**: `@amclub/shared` and `@amclub/db` declare `eslint src --ext .ts` against ESLint 9, which requires a flat `eslint.config.js` neither package has — turbo aborts before web/mobile even run
- `@amclub/web` ✅ 0 warnings (note: `next lint` is deprecated, removed in Next 16)
- `@amclub/mobile` ❌ 8 errors / 13 warnings, all pre-existing `react-hooks/set-state-in-effect` in 7 screens (`category/[slug]`, `checkout`, `notifications`, `orders/[id]` ×2, `partner-rfq/[id]`, `rfq/[id]`, `search`) + stale eslint-disable warnings

**Build**: `@amclub/web` ✅ production build clean (this session). Mobile `expo export` untested (CI marks it `continue-on-error` — and CI never runs, see below)

**CI**: ❌ triggers on `main`/`develop`; branch is `master` → **zero CI runs in project history**; typecheck step would fail today if enabled

**Tests**:
- RLS suite ✅ 7/7 (run today, cleans up)
- Money-loop kill-test: 13/17 (run today) — 4 failures are the cron legs, explained by `verifyCron` denying prod-mode servers without `CRON_SECRET`; core lifecycle/refund/invoice/illegal-transition checks all pass
- **Unit tests: written but unrunnable** *(corrected 2026-07-07 during the fix pass — the original audit said "zero", which was wrong)*: `packages/shared/src/__tests__/` contained 23 money + state-machine tests, but the package had **no `test` script and no CI step**, so they had never been executed. `redactContactInfo` had none. The fix pass wired `vitest run`, added masking/RFQ/coupon coverage (now 35 tests, all passing), and put them in CI
- Webhook replay/dropped kill-tests exist but were not re-run today; Phase 8b voice verification scripts were session-scratch and are **not in the repo**

**DB heartbeat probe** (read-only, today): 0 open-RFQs past expiry, 0 stale delivered orders, 0 placed orders >25h — consistent with crons working, but traffic is too low for this to be conclusive

**Hygiene**: 1 real TODO (`channels.ts:83`); `.claude/settings.local.json` perpetually dirty in git status; `design_handoff_amclub_design_system/` untracked at repo root; `react-native-worklets` unmet peer warning on every install; migrations 0001+ unjournaled (Section 1)

---

## 5. TOP-10 FIX LIST (highest user-pain ÷ effort, fixable by me — separate from human QA)

1. **Turn CI on**: trigger on `master`, scope typecheck to green packages (or fix db, see #2) — restores the only automated safety net. *(S)*
2. **Fix the `engagement.ts` missing `index` import** (my 8b regression) + the ~40 db strictness errors in `seed.ts`/`test-rls.ts` — makes `@amclub/db` green so CI can be strict. *(S/M)*
3. **Checkout → orders handoff**: read `?processing=1`, show a "payment received, order appearing shortly" banner with a short poll; add `modal.ondismiss` feedback on the Razorpay sheet. Must land before live keys. *(M)*
4. **Legal pages** (`/terms`, `/privacy`, `/refund-policy`): static i18n pages + footer/signup links — unblocks Razorpay onboarding and DPDP. Content needs founder/legal review but scaffolding + honest boilerplate can land now. *(M)*
5. **`CRON_SECRET` in `.env.example` + a `/api/v1/cron/health` heartbeat row** so dead crons are visible instead of silent. (Verifying the Vercel env var itself is a founder action.) *(S)*
6. **Mobile language switcher** (header toggle, device-locale default) + replace the 4 hardcoded strings — makes hi.json real. *(S)*
7. **Toast primitive** + replace `alert()`s and silent successes on admin/provider actions. *(M)*
8. **Notification badge freshness**: 30s `refetchInterval` or Supabase Realtime channel. *(S)*
9. **ESLint 9 flat configs for shared/db** so root `pnpm lint` means something again. *(S)*
10. **Unit tests for the money core**: `computeOrderAmounts`, refund matrix, state-machine transition map, `redactContactInfo` — the four pure modules every rupee flows through. *(M)*

*(te/ta strategy — translate core namespaces vs. scope the chips to the gateway — is a product decision before it's a fix; flagging it for you rather than picking.)*

## 6. WHAT THIS AUTOMATED AUDIT CANNOT SEE (residual scope for human QA)

1. **Real devices**: mic permission flows across Android OEMs, expo-audio behavior, keyboard-avoidance, low-end jank, actual tap-target comfort. Mobile was never run in this audit — only typechecked/linted.
2. **Real money**: Razorpay live-mode checkout, webhook latency, Route split settlement, refund timing, invoice correctness against a real GST number. Simulate mode proves logic, not the rails.
3. **Deliverability**: SMS DLT approval, WhatsApp template approval, email spam placement, OTP arrival time on Jio/Airtel.
4. **Language quality**: te/ta (and honestly hi) copy needs native-speaker review everywhere it appears — machine-drafted strings at trust-critical moments (consent, payments) are a reputational risk this audit cannot grade.
5. **Comprehension**: whether a real Tier-2/3 MSME owner understands the gateway doors, the RFQ-vs-buy-now split, escrow copy, or the voice feature's value — usability testing, not code audit.
6. **Perceived quality**: animation smoothness on mid-range phones, font rendering of Indic scripts, layout at 320px, dark-pattern-free feel.
7. **Dashboard state**: Supabase (SMS provider, CAPTCHA, backups/PITR, storage policies) and Vercel (env parity incl. `CRON_SECRET`, UPSTASH, cron execution logs) — outside the repo, must be eyeballed.
8. **Accessibility in practice**: screen-reader runs (TalkBack), full-app axe pass, real contrast rendering — the Phase 8 work that was skipped.
9. **Load**: k6 was never run; p95 under concurrent RFQ fan-outs and search traffic is unknown.
10. **Restore drill**: backup-restore has never been rehearsed; RPO/RTO are theoretical.

---

*Generated by automated audit; nothing was fixed in this pass. Items B1–B4 should gate any real-user pilot regardless of the QA-hire decision.*
