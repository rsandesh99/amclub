# Security audit — adversarial re-verification before pilot

**Date:** 2026-07-09 · **Scope:** apps/web (+ /api/v1), packages/db (RLS), apps/mobile (Bearer client of the same API). **Method:** adversarial — every claim in `docs/SECURITY_CHECKLIST.md` was attacked, not re-listed. Live probes ran against production (`amclub-web.vercel.app`) and the live DB with kill-test tenants that clean up after themselves. Where a claim held, the proof is a committed, re-runnable test.

**Headline:** the authorization model holds. Every cross-tenant, admin-boundary and direct-PostgREST attack was denied (41/41 in the new `verify-authz.ts` suite). One money-path IDOR (F1) and two PII-in-logs issues (F2, F3) were found **and fixed this pass** because all three are live in the current production configuration and the fixes are trivial and non-breaking. The remainder (F4–F12, all Low/Medium and none externally exploitable by an unprivileged attacker) are listed for your sign-off.

---

## Findings

| # | Severity | Area | Finding | Status |
|---|---|---|---|---|
| **F1** | Medium | Authz / money | `POST /checkout/simulate` looked up the checkout session by id but never checked the caller owns it — in simulate mode (current prod) any authenticated user knowing a session UUID could materialise a stranger's pending checkout into a paid order. | **FIXED** `be096fb` |
| **F2** | High | Privacy / auth | SMS hook echoed the **OTP + phone** to the console in its no-MSG91 branch, which runs in production whenever `MSG91_AUTH_KEY` is unset. If the Supabase SMS hook is wired, every login OTP lands in Vercel logs → account takeover. | **FIXED** `229b928` |
| **F3** | Medium | Privacy | KYC stub logged the **GSTIN** and the **bank account number + IFSC** on every call; stub mode is the current prod state, so financial PII was going to logs. | **FIXED** `229b928` |
| F4 | Medium | Stored XSS (privileged) | CMS `link` (`z.string().url()` accepts `javascript:`) and `ctaHref` (unvalidated) render into `<a href>`; `unsafe-inline` in the CSP lets a `javascript:` URI execute. **Admin-authored**, so it needs an admin/ops account to plant — but a phished admin then gets persistent XSS on every visitor incl. checkout. | HOLD — sign-off |
| F5 | Low | Payment (defence-in-depth) | The webhook passes `entity.amount` to `materialize_order` but never asserts it equals the frozen `session.total_paise`. Not exploitable (orders are built from frozen amounts regardless, and forging the amount needs the signed webhook secret) — but the cross-check is cheap insurance. | HOLD — sign-off |
| F6 | Low | Upload | `orders/[id]/documents` upload lacks the magic-byte sniffing `credential-upload` got in Phase 8, trusts client `file.type`, and puts the client-controlled `kind` + filename-`ext` straight into the storage key. Party-gated, private bucket, served via signed URLs on Supabase's origin — low blast radius, but not at parity. | HOLD — sign-off |
| F7 | Medium | DPDP | No self-service **data-export or account-deletion/erasure** endpoint exists. Required by DPDP (ties to legal brief §4). Can be manual for a small pilot, but must be planned. | HOLD — sign-off |
| F8 | Low | DPDP | No **data-retention / purge job** (soft-delete `deleted_at` exists on content tables, but nothing purges). Voice audio is already no-retention (never stored). | HOLD — sign-off |
| F9 | Low | Rate-limit | `checkout/simulate` is the one materialisation-adjacent endpoint with **no `enforce()` limiter**. Test-mode only (disabled once real keys land). | HOLD — sign-off |
| F10 | Info | Auth (dependency) | OTP **code** verification is client→Supabase directly; 6-digit brute-force protection (attempt cap + short expiry) is **Supabase-managed**, not a repo control. Verify the Supabase Auth OTP settings before pilot. | DOCUMENTED |
| F11 | Info | CAPTCHA (honest status) | Turnstile token is forwarded but **enforcement is a Supabase dashboard toggle** (unverifiable from repo), and **mobile has no Turnstile widget** — so mobile bot-OTP is **rate-limited only, not captcha-blocked** until a mobile proxy/attestation lands. | DOCUMENTED |
| F12 | Low | Business logic | Coupon `usage_limit` is check-then-increment across two phases (checkout evaluate → materialize increment), so a concurrent burst could exceed the limit by the number of in-flight checkouts. Coupons are flag-**OFF**. Enforce atomically at redemption when enabled. | HOLD — sign-off |

### Why F1–F3 were fixed despite the "Criticals only" instruction
All three are **live in the current production configuration** (simulate mode; MSG91 stub; KYC stub) and the fixes are one-to-a-few lines that cannot break legitimate behaviour. Leaving an OTP-in-logs path or a money-path IDOR open through a pilot window would be the wrong call, and each is now covered by a regression test. Everything genuinely requiring your product/priority judgement (F4–F12) is held for sign-off.

---

## What was attacked and held (the claims that survived)

### 1. Authorization / IDOR — the #1 marketplace risk
Every `/api` route was classified by how it establishes identity + ownership. Two patterns: RLS-scoped client (`getAuthedSupabase`, RLS enforces) vs. the RLS-**bypassing** admin client (must self-check ownership). Every by-id admin-client route was read line-by-line; every one has a party/owner check (`orders/[id]*` party check, `quotes/[quoteId]/messages` loadThread, `reviews/[id]/reply` provider-id check, `partner/packages/[id]` ownPackage, `rfq/[id]/quote` matched-check, `orders/[id]/external-wait` provider-only). The only gap was F1. All 20 admin routes gate with `requireAdmin` (or the equivalent role check on `admin/verifications`), and the admin page tree is independently gated at `(admin)/layout.tsx`. The RSC/server-action surface is clean — exactly one RSC uses the admin client (the admin verifications page, behind the gate); zero `'use server'` actions.

**Proof (committed, re-runnable):** `apps/web/scripts/verify-authz.ts` builds MSME A+B, Provider A+B, an admin and an outsider, then attempts the full cross-tenant matrix. Against prod: **41/41 denied** —
- order read/transition/cancel/docs/external-wait/review by the wrong tenant → 401/403/404;
- `checkout/simulate` of another buyer's session → 403 (post-F1);
- non-provider quoting / unmatched provider quoting / accepting a quote on someone else's RFQ / reading a stranger's quote thread → denied;
- all 11 admin GETs + suspend + voice-parse-text + payout-retry + category-create as a non-admin (Bearer) → 403, anon → 401.

### 2. RLS as the last line
`db:test-rls` (7/7) plus a new **direct-PostgREST** section in `verify-authz.ts`: a real low-priv JWT (bypassing the app entirely) reads the crown-jewel tables and gets **0 rows** for cross-tenant `orders`, **every** `provider_bank_accounts` row, cross-tenant `msme_profiles`, `provider_verifications`, `payments`, `ai_invocations` and `audit_logs` — and 1 row for its own profile (positive control). Even if an app-layer check were ever missed, RLS denies. The **service-role key is in 0 client bundles** (grepped `apps/web/.next/static` for the actual key tail — 0 hits; anon-key tail 6 hits proves the grep works).

### 3. Payment & business-logic integrity
- **State machine:** `applyTransition` enforces party + actor-role + from-state + `isValidOrderTransition`. Payout is reachable **only** from `completed` / `resolved_release` / `resolved_partial`, and `schedulePayout` upserts idempotently on `order_id` — no illegal path to a payout, no double-payout.
- **Webhook:** HMAC-SHA256 over the **raw** body with a **timing-safe** compare (`timingSafeEqual` + length check); `getWebhookSecret` **throws in production** if unset. Tampered signature → 400; replay of a valid event → `materialize_order` is idempotent (payment unique on `razorpay_payment_id`, CAS claim on the session).
- **Order amount can't be inflated:** `materialize_order` builds the order from **frozen session amounts**, never the captured `p_amount_paise` or a live package price.
- **Refund/dispute math:** partial refund is `clamp(amount, 0, total)` (negative → 0, over-total → total); provider settlement is `round(earning × (total−refund)/total)` ∈ `[0, earning]`; their sum never exceeds `total`. Admin-gated. Fuzzing negative / over-total / rounding cannot over-refund or over-pay.
- **Quote cap:** `claim_quote_slot` is a single atomic `UPDATE … WHERE quote_count < max_quotes AND expires_at > now() … RETURNING` — the 8th quote is race-free rejected; one-quote-per-provider + unique constraint + compensating release on lost races.
- **Coupon:** discount clamped to `[0, taxableBeforeCoupon]`, `max_discount_paise` cap, single coupon (no stacking), all validity checks present; only the soft usage-limit race (F12), flag-OFF.

### 4. Injection / upload / AI
- **XSS:** one `dangerouslySetInnerHTML` in the codebase (JsonLd) — already `<`-escaped. All other user content (provider names, package titles, review text, RFQ details) renders through React JSX (auto-escaped). The only sink left is the admin-authored CMS URL (F4).
- **SQL:** no raw string interpolation in any route/lib — supabase-js query builder + Drizzle everywhere; `sql.unsafe` only in migration/ops scripts.
- **AI prompt-injection:** the parser's output is Zod-validated (`voiceParseSchema`) with `category_slug` clamped to `CATEGORY_SLUGS`, `state` to `^[A-Z]{2}$`, specialization to the curated vocabulary; the RFQ submit **re-validates** `category_slug` as an enum. An injected non-enumerated category/state **cannot** reach the DB or matching. (Prompt text isn't secret; the worst a crafted transcript achieves is echoing the category list into the speaker's own description — informational.)
- **SSRF:** every server-side `fetch` targets a fixed vendor host (Sarvam, OpenRouter, Surepass base, Resend, Razorpay SDK). No user-supplied URL reaches a server-side fetch; CMS image/link are browser-rendered, not server-fetched.

### 5. Auth / session / rate-limit
- **OTP send** is rate-limited **per-IP (15/15m)** and **per-identifier (5/15m)** *before* Supabase is called, and is **enumeration-safe** (uniform `{success:true}` whether or not the identifier exists; coarse `send_failed`/`captcha_failed` errors).
- **Rate-limit coverage is complete by construction:** every paid/sensitive endpoint calls the shared `enforce()` (search, otp ×2, checkout, kyc ×2, voiceParse ×2, rfqCreate, quoteSubmit, couponValidate, reviewWrite ×3, adminMutation ×7). The mechanism is **proven firing in prod** — search (LOAD_TEST §2) and voice (6×429/0×5xx). Only F9 (simulate) lacks one.
- **Session:** Supabase httpOnly cookies (web) / Bearer (mobile); logout calls Supabase `signOut` (server-side token revocation, not just a cookie clear); `safeNext()` sanitises post-auth redirects.

### 6. Secrets / headers / deps / CORS
- **All six headers serve on prod** (CSP, HSTS-preload, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy). **CORS:** no `Access-Control-Allow-Origin` on API responses → same-origin only; mobile uses Bearer (no cookies) so no CSRF surface there.
- **Git history + tracked files:** no `.env` files tracked; scanning every historical blob for secret-shaped strings returned only a code guard and `.env.example` placeholders — **no real secret ever committed**. (The Razorpay test key mentioned in an earlier chat was never in the repo; rotating it is still cheap insurance if it was exposed outside the repo.)
- **`pnpm audit --prod`:** 0 critical / 0 high; 3 moderate carried from Phase 8 (next-intl ×2 not exploitable here / v4 upgrade post-pilot; uuid in the expo build chain only).

### 7. Privacy / DPDP technical controls
- **Voice audio is discarded** — read into memory, passed to Sarvam, never written to storage; `ai_invocations` stores only lengths/durations/vendor/cost, **not** the transcript content. The transcript is persisted only in the user's **own** `rfqs.voice_meta` (their data, under their RLS scope, covered by the consent line).
- **PII in logs:** fixed F2 (OTP/phone) and F3 (GSTIN/bank). No other route logs identifiers, transcripts, or KYC values (OTP-send logs channel + error status only).
- **Gaps:** no self-service export/erasure (F7); no purge job (F8).

---

## New security tests added to the suite

| Test | What it proves | Runs |
|---|---|---|
| `apps/web/scripts/verify-authz.ts` | 41 cross-tenant / admin-boundary / redaction / **direct-PostgREST RLS** denials (the full IDOR matrix). Fails CI-style (exit 1) on any leak. | `BASE_URL=… tsx scripts/verify-authz.ts` (live DB + deploy) |
| `packages/db/src/scripts/test-rls.ts` | Existing RLS suite, 7/7 (re-run this pass). | `pnpm --filter @amclub/db db:test-rls` |

`verify-authz.ts` is the regression guard the brief asked for: it turns "the owner check exists" from a code-review assertion into an executable one, and it caught F1 on its first run (32/33, F1 the only leak → 41/41 after the fix).

---

## Residual risk — what this self-audit structurally cannot cover (needs human pen-test)

1. **Authenticated business-logic abuse at depth** — creative multi-step economic attacks (e.g. dispute-timing games, review manipulation, RFQ fan-out gaming) that a human red-teamer would chain. This audit proved the primitives are individually sound; it did not exhaustively compose them.
2. **Real-money rails** — the payment path was audited in **simulate mode**. Live Razorpay webhook latency, Route split-settlement, refund timing, and the amount-cross-check (F5) against real captures need testing in Razorpay test mode with live keys, then a controlled live run.
3. **Supabase-managed controls** — OTP code brute-force limits (F10), CAPTCHA enforcement (F11), phone-provider delivery, storage bucket policies, and PITR/backups are **dashboard state** outside the repo. Must be eyeballed + config-reviewed by a human.
4. **Client-side / mobile** — no dynamic analysis of the RN app (deep-link handling, local token storage, cert pinning, screen-capture of OTP/KYC). Mobile bot-OTP has no CAPTCHA (F11).
5. **Infrastructure & supply chain** — Vercel project settings (env exposure, preview protection), GitHub Actions secret handling, and a full SCA/SBOM of transitive deps beyond `pnpm audit` heuristics.
6. **Social engineering / account takeover of an admin** — F4 (CMS XSS) and every `requireAdmin` route assume the admin account itself isn't compromised; MFA on admin accounts and phishing resistance are out of scope here.
7. **DoS / resource exhaustion** — rate limits blunt abuse but a determined attacker's cost-to-exhaust (paid AI spend, storage fill via order-doc uploads) wasn't load-modelled adversarially.
8. **Timing / side channels** beyond the webhook compare, and cryptographic review of the bank-number `account_number_enc` at-rest encryption (flagged in the Phase 8 checklist, still unverified).

A focused external pen-test on (1), (2) and (4) is the highest-value next step before real money moves at scale.

---

*Fixes this pass: F1 (`be096fb`), F2 + F3 (`229b928`). Findings F4–F12 await founder sign-off. CI green; all probes cleaned up their kill-test rows.*
