# Security checklist — Phase 8 §8 (OWASP ASVS L1 / Top-10 walk)

**Date:** 2026-07-09 · **Scope:** apps/web (+ API), packages/db (RLS), apps/mobile (client of the same API). Every control lists status + evidence (file refs or commands run this pass). Statuses: ✅ in place · ⚠ partial/accepted-risk · ☐ founder/dashboard action.

## A01 Broken Access Control

| Control | Status | Evidence |
|---|---|---|
| RLS-by-default on every table | ✅ | 61 policies, RLS enabled on 32/32 public tables (verified against live during the §3 restore drill); `packages/db/src/rls/policies.sql` |
| RLS regression suite | ✅ | `pnpm --filter @amclub/db db:test-rls` — 7/7 (cross-MSME orders denied, unverified provider hidden, anon sees active packages only, rfq_matches scoped) re-run 2026-07-09 after the policies re-apply |
| Service-role key never client-reachable | ✅ | `lib/supabase/server.ts:62` behind `import 'server-only'`; env var not `NEXT_PUBLIC_`; grep confirms no client import |
| Admin surface authz (web + Bearer) | ✅ | every `/api/v1/admin/*` route opens with `requireAdmin()` (`lib/auth/admin.ts` — resolves roles via service client); spot-checked providers/orders/disputes/coupons/payouts/voice-parse-text this pass |
| MSME/provider boundary on orders | ✅ | `resolveActor` + per-order party checks in transition route; `verify-phase7.ts` proves cross-party denial; column-privileges migration `0004` masks provider PII columns from anon/authenticated |
| Buyer phone masked from provider pre-acceptance | ✅ | `order_safe_view` (policies.sql:253) + `redactContactInfo` on quote threads (unit-tested) |
| IDOR sweep | ✅ | all detail APIs filter by resolved actor id, not trusting client ids; RLS backstops service-role misuse everywhere except explicit admin paths |

## A02 Cryptographic Failures

| Control | Status | Evidence |
|---|---|---|
| TLS everywhere + HSTS | ✅ | Vercel TLS; `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` added this pass (`next.config.ts`) |
| Secrets management | ✅ | `.env*` gitignored; `.env.example` names only; secrets live in Vercel env; Zod-validated at boot (`lib/env.ts`) |
| Bank account storage | ⚠ | `provider_bank_accounts.account_number_enc` — encrypted-at-rest naming; verify the encryption implementation before live payouts (flagged for go-live review) |
| Password handling | n/a | No passwords — Supabase OTP/OAuth only (kill-test users are service-role-created, non-prod pattern) |

## A03 Injection

| Control | Status | Evidence |
|---|---|---|
| SQL injection | ✅ | supabase-js builders + drizzle parametrisation; `sql.unsafe` only in migration/ops scripts, never on request paths |
| XSS via React | ✅ | JSX escaping; **one real finding fixed this pass**: `JsonLd.tsx` now escapes `<` — provider-authored strings could previously close the JSON-LD `</script>` |
| Input validation | ✅ | Zod on every API input (§2.5 rule 5); `rfqSchema`, `quoteSchema`, checkout, admin bodies all `safeParse` |
| CSP | ✅ | added this pass (`next.config.ts`): default-src 'self'; script-src restricted to self + Razorpay + Turnstile; frame-ancestors 'none'; object-src 'none'. `unsafe-inline` retained for Next bootstrap scripts — nonce plumbing is the strict upgrade path |

## A04 Insecure Design

| Control | Status | Evidence |
|---|---|---|
| State machines with server-enforced transitions | ✅ | `packages/shared/src/state-machines.ts`; illegal transitions rejected (kill-test green); payout retry validates via `isValidPayoutTransition` |
| Webhooks as payment truth + idempotency | ✅ | signature check + idempotent `materialize_order`; replay kill-tests (`killtest-webhook-replay.ts`) |
| Rate limiting on cost/abuse paths | ✅ | `lib/rate-limit.ts` (OTP, search, checkout, RFQ, voice, admin); **verified live in prod** — §2 voice ceiling run returned 6×429/0×5xx |
| Contact-info leakage pre-payment | ✅ | `redactContactInfo` on quote messages, clarifications, order messages and statements; since audit M30 it and `stripContactInfo` and the agent output contract share ONE rule set (`packages/shared/src/contact-mask.ts`: phones incl. Indic / spaced / spelled-out digits, emails, UPI ids, links, handles), driven by one fixture table |

## A05 Security Misconfiguration

| Control | Status | Evidence |
|---|---|---|
| Security headers | ✅ | CSP, HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy (mic self-only for Voice RFQ) — `next.config.ts` this pass |
| Debug/errors leak | ✅ | `serverError()` logs server-side, returns generic body; error.tsx in all 6 route groups (auth+gateway added §7) |
| CORS | ✅ | no `Access-Control-Allow-Origin` headers set → same-origin only; mobile uses Bearer (no cookies) so no CSRF surface there |
| CSRF (web) | ⚠ | Supabase cookies are SameSite=Lax + all mutations are POST JSON — adequate for L1; no per-request CSRF token (accepted; revisit if cross-site embedding ever allowed — frame-ancestors 'none' also blocks clickjacking) |
| CAPTCHA | ☐ | Turnstile pass-through implemented; enforcement lives in the Supabase dashboard (founder toggle) |

## A06 Vulnerable Components

`pnpm audit --prod` (2026-07-09): **0 critical, 0 high**, 3 moderate after fixes:

| Finding | Disposition |
|---|---|
| postcss <8.5.10 (bundled in next) | **FIXED** — pnpm override to ≥8.5.10 (root package.json) |
| next-intl <4.9.1 open redirect | accepted for now — exploit needs attacker-controlled locale redirect paths; middleware only redirects to our own locale routes. Upgrade path: next-intl v4 (breaking) — schedule post-pilot |
| next-intl prototype pollution via attacker-controlled translation catalogs | not exploitable — catalogs are repo-controlled JSON, never user input |
| uuid@7 (deep in expo/xcode build chain) | build-time tooling only, not shipped runtime code |

## A07 Identification & Authentication

| Control | Status | Evidence |
|---|---|---|
| Auth provider | ✅ | Supabase Auth (phone OTP primary, Google OAuth); JWTs verified server-side via `getAuthedSupabase` |
| OTP abuse guards | ✅ | per-identifier (5/15min) + per-IP (15/15min) limiters + captcha pass-through (`auth/otp/route.ts`) |
| Session cookies | ✅ | @supabase/ssr httpOnly cookies; Bearer for mobile |
| Post-auth open redirect | ✅ | `safeNext()` sanitises the `next` param (`lib/auth/safe-next.ts`) |

## A08 Software & Data Integrity

| Control | Status | Evidence |
|---|---|---|
| CI on every push/PR | ✅ | typecheck+lint+unit tests+build+mobile export (blocking) + axe a11y (blocking) |
| Payment mutations idempotent | ✅ | idempotency keys on checkout; replayed webhook does not double-create (kill-test) |
| Audit trail | ✅ | append-only `audit_logs` for admin actions (suspend, resolve, commission, payout retry, …) |
| Money as integer paise + frozen commission | ✅ | §2.5 rule 6; commission-freeze proven in `verify-phase7.ts` criterion 4; 15 money unit tests |

## A09 Logging & Monitoring

| Control | Status | Evidence |
|---|---|---|
| Error monitoring | ✅ | Sentry (server+client) when DSN set |
| AI spend observability | ✅ | `ai_invocations` per-model-call telemetry (cost/latency/status + full vendor error bodies) |
| Cron liveness | ✅ | `cron_heartbeats` + admin Jobs panel |
| Product analytics | ✅ | PostHog events per feature (Appendix A names) |

## A10 SSRF

| Control | Status | Evidence |
|---|---|---|
| User-supplied URL fetches | ✅ none exist | grep across `app/api` + `lib`: every server-side `fetch` targets a fixed vendor host (Sarvam, OpenRouter, Razorpay, Resend, Supabase). CMS banner `link`/`cta_href` are rendered as hrefs (admin-authored), never fetched server-side |
| Upload handling | ✅ | credential-upload: MIME allowlist + 5MB cap + **magic-byte sniffing added this pass** + extension derived from verified type (client filename never reaches the storage path) |

## Residual items (tracked, not silent)

1. **CSP nonce upgrade** — drop `unsafe-inline` for scripts once nonce plumbing is added.
2. **next-intl v4 upgrade** — clears the two moderate advisories; breaking-change migration, post-pilot.
3. **Bank-number encryption review** (`account_number_enc`) before live payouts.
4. Founder/dashboard actions: enable Supabase CAPTCHA, verify `CRON_SECRET` set, Supabase Pro for backups (RUNBOOK_RESTORE.md).
5. Human pen-test remains out of scope for this automated pass (STATUS_AUDIT §6).
