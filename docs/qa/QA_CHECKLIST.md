# AMClub — manual QA checklist (Experience v3 + Mart, go-live 2026-09-24)

A person clicks through every journey below before real customers arrive and after every release that touches the journey. Automated coverage lives in CI:
- the money rigs, run on every PR;
- the browser journey suite `apps/web/e2e/`;
- the unit suites.

This checklist covers what automation can't:
- how the screens look and read on a real phone;
- copy in each language;
- real SMS, email and payment rails;
- judgement calls ("is this confusing?").

## 0. Setup

| Item | How |
|---|---|
| **Where** | A **preview** deployment for anything that pays. Production refuses simulated payments (ADR 023) and takes money only after the Razorpay cutover (ADR 003). Use **production** for read-only checks and for sign-up / OTP / email with your own accounts. |
| **Accounts** | 1 admin (founder), 2 buyers (one with a GSTIN, one without), 2 providers (one services-only, one `sells_goods` with a verified GSTIN). Use real phone numbers you own; OTP is the real MSG91 path. |
| **Devices** | A. Android phone, Chrome, ~390 px wide. B. iPhone, Safari. C. Desktop Chrome at 1280 px and above. D. The Android app (`apps/mobile`, Expo build). |
| **Languages** | en and hi for every journey. te and ta on journeys 1–4 and 9: they are machine translations pending native review, so note any wrong or awkward line. |
| **Record** | For each step, P / F / N/A plus a screenshot link on any F. File each F as an issue named `QA: <journey>.<step> <device> <lang>`. |

Mark each cell: `P` pass, `F` fail (issue link), `-` not applicable.

## 1. Visitor → buyer sign-up (gateway, OTP, wizard)

| # | Step | Expected | A | B | C | D |
|---|---|---|---|---|---|---|
| 1.1 | Open `/` logged out | Two-door chooser ("I run a business / I provide services"); analytics notice with equal Accept / Decline | | | | |
| 1.2 | Decline, reload | Notice gone; no PostHog request in the network tab | | | | |
| 1.3 | "I run a business" → phone → OTP | SMS arrives within 30 s; wrong code shows an error; resend works after the timer | | | | |
| 1.4 | Complete the MSME wizard (name, business, state, size band) | Lands on `/app`; the size band is saved (profile shows it) | | | | |
| 1.5 | Switch language to हिन्दी, then తెలుగు, then தமிழ் | Header, footer, home and consent notice change language; no sideways scroll | | | | |

## 2. Discovery (search, filters, service pages, compare)

| # | Step | Expected | A | B | C | D |
|---|---|---|---|---|---|---|
| 2.1 | `/services` → type "GST registration" | Results with filter chips (Verified, ≤7 days, Price, 4★+, Language, More) | | | | |
| 2.2 | `/search?q=gst` | Redirects to `/services?query=gst` | | | | |
| 2.3 | Apply a state filter | All 37 states and UTs listed by name; results narrow | | | | |
| 2.4 | Open a category → a service page (`/services/<cat>/<service>`) | Level-2 page with its packages; breadcrumb back works | | | | |
| 2.5 | A search with no results | "Get quotes… from up to 7 verified providers" card leads to the requirement form, prefilled | | | | |
| 2.6 | Shortlist 2–3 providers → `/compare` | Side-by-side view; removing one works | | | | |
| 2.7 | Mic button (signed in) | Speaks a query in en / hi / te; languages without a passed eval say "type instead" | | | | |
| 2.8 | "Did you find what you need?" → No + reason | Thanks message; no error | | | | |

## 3. Provider profile and package (trust, pricing)

| # | Step | Expected | A | B | C | D |
|---|---|---|---|---|---|---|
| 3.1 | Open a provider `/p/<slug>` | Two buttons above the fold (See packages / Post a requirement); verification checklist with dates; no "Top Rated" | | | | |
| 3.2 | Measured stats (on-time %, repeat buyers) | Shown only when each has its minimum sample; otherwise hidden, never "0 %" | | | | |
| 3.3 | Open a package | Price reads "₹X + GST = ₹Y" from the first card to checkout (same numbers everywhere) | | | | |
| 3.4 | Tiered package (Basic / Standard / Premium) | Comparison table; "Choose this if…" line; switching tier updates the price | | | | |
| 3.5 | Add-ons in the buy box (if the provider has any) | Each add-on changes the total once; days change as stated | | | | |
| 3.6 | Phone (A/B): scroll the package page | Sticky Buy bar visible in the first screen | | | | |
| 3.7 | `/p/<slug>/reviews` | Paginated; "Show all reviews" links here | | | | |

## 4. Buy now → order (preview, simulated payment)

| # | Step | Expected | A | B | C | D |
|---|---|---|---|---|---|---|
| 4.1 | Logged out: Buy now | Checkout opens with inline sign-up; after OTP you land back on the **same** checkout | | | | |
| 4.2 | Add a GSTIN (buyer with GST) | Checksum error on a wrong one; ITC value shown | | | | |
| 4.3 | Pay (simulated on preview) | Order created; "what happens next" shown; notification arrives (in-app + email) | | | | |
| 4.4 | Production only: Buy now before the cutover | "Payments are not available right now — you have not been charged." No order created | | | | |
| 4.5 | Open the order `/app/orders/<id>` | Next-step bar, tabs, "Funded ✓"; the phone is masked | | | | |
| 4.6 | Messages tab: write "call me 98765 43210" | Number arrives masked on the provider side | | | | |

## 5. Requirement (RFQ) → quotes → pay

| # | Step | Expected | A | B | C | D |
|---|---|---|---|---|---|---|
| 5.1 | `/app/rfq/new`: type a requirement | Strength meter moves as you type; one free-text box; budget as a range | | | | |
| 5.2 | Voice requirement (hi / te) | Transcript and parsed fields shown for confirmation; at most one clarifying question | | | | |
| 5.3 | Submit | Matched providers get it (check provider inbox, 6.1) | | | | |
| 5.4 | Two providers quote (one with Economy / Express options) | Compare shows scope, normalised totals, options; "fair price range" line only when the sample allows | | | | |
| 5.5 | Ask a clarification; provider answers | Visible to the buyer and every matched provider; contact details masked | | | | |
| 5.6 | Accept one quote → pay (preview) | Order created; the other quote shows a loss label to its provider (insights), never the winner's exact price | | | | |
| 5.7 | Decline a quote with a reason | Provider sees the decline | | | | |

## 6. Provider journey

| # | Step | Expected | A | B | C | D |
|---|---|---|---|---|---|---|
| 6.1 | Sign up as a provider (`/partner/signup`) | Onboarding wizard saves each step; leaving and returning resumes | | | | |
| 6.2 | Admin approves (`/admin/verifications`) | Provider becomes active; listings can go live | | | | |
| 6.3 | Create a package with tiers + add-ons (`/partner/listings/new`, `/partner/listings/tiers`) | Validation messages in the chosen language; package live within 5 s of publish | | | | |
| 6.4 | RFQ inbox `/partner/rfqs` → quote | Quote form (with speed options); revision up to 3 times | | | | |
| 6.5 | Order: accept → requirements → deliver (upload files) | Each step moves the buyer's next-step bar; files open for the buyer | | | | |
| 6.6 | Buyer requests a revision / accepts | Revision count respected; completed order shows the review prompt to the buyer | | | | |
| 6.7 | `/partner/insights` | Funnel Views → Matched → Quoted → Won with real counts | | | | |
| 6.8 | `/partner/earnings` | Payout shown as held until the admin releases it | | | | |

## 7. Admin and money

| # | Step | Expected | A | B | C | D |
|---|---|---|---|---|---|---|
| 7.1 | `/admin/payouts`: release a completed order's payout (preview) | Payout moves to processing/paid (simulated); audit log row | | | | |
| 7.2 | Buyer opens a dispute; both parties write statements | `/admin/disputes/<id>` shows both; resolve refund / release / partial works once; a second resolve is refused | | | | |
| 7.3 | Cancel an order within policy | Refund row for the policy %; order shows refunded | | | | |
| 7.4 | Commission change in `/admin/categories` | Only NEW orders use it | | | | |
| 7.5 | Coupons (`/admin/coupons`) | Create, apply at checkout, usage counted once | | | | |

## 8. Mart (goods)

| # | Step | Expected | A | B | C | D |
|---|---|---|---|---|---|---|
| 8.1 | Seller activates goods (`/partner/goods`) | Needs a verified GSTIN; listing wizard (photos → confirm → pricing tiers) | | | | |
| 8.2 | Admin approves the listing (`/admin/mart`) | Listing appears on `/mart` | | | | |
| 8.3 | `/mart`: category chips, attribute filters, sort | Filters narrow results; no sideways scroll in any language | | | | |
| 8.4 | Services \| Goods switch on `/services` and `/mart` | Keeps the query when switching | | | | |
| 8.5 | Add to cart → checkout (preview) | Server-computed totals; "After input credit" line; one seller per order | | | | |
| 8.6 | Seller: accept → dispatch (photo + invoice; e-way bill at ≥ ₹50,000) → deliver (photo) | Buyer sees each event; promise badges measured | | | | |
| 8.7 | Buyer: goods received / open a return | Non-returnable categories refuse quality returns; damaged / wrong / short stay claimable | | | | |
| 8.8 | Sample order; Reorder (`/app/mart/reorder`) with a reminder | Sample = one unit at the sample price; reorder shows today's price vs then | | | | |
| 8.9 | Group buy (`/mart/pools`): join, pool closes met, pay within 48 h | One order per member at the pool price | | | | |

## 9. Language and accessibility sweep

| # | Step | Expected | A | B | C |
|---|---|---|---|---|---|
| 9.1 | Every page in 1–8 in hi | No English left on the buying path; numbers and ₹ formatted | | | |
| 9.2 | Journeys 1–4 in te and ta | Readable; log awkward or wrong lines for the native reviewer | | | |
| 9.3 | Keyboard only (desktop) through 4.1–4.3 | Focus always visible; order logical; the sheet traps focus | | | |
| 9.4 | Phone screen reader (TalkBack / VoiceOver) on 3.3 and 4.3 | Price, buttons and errors announced | | | |
| 9.5 | Slow 3G (DevTools) on `/services` and a package page | Usable within 5 s; no layout jump on the price | | | |

## 10. Automated re-runs that need production credentials

These use the scripts in the repo but need keys that CI does not hold.

| Check | Command | Where | Last run |
|---|---|---|---|
| Accessibility (axe, 45 surfaces) | `A11Y_ENFORCE=1 BASE_URL=<url> pnpm --filter @amclub/web exec tsx scripts/a11y-scan.ts` | A preview with the v3 flags on, `apps/web/.env.local` pointing at its Supabase | Signed in, full mode: runs on every PR in `money-rigs.yml` (since #52), against the CI stack with the v3 flags on. A preview run is still useful before a big visual change. |
| Load: search | Actions → **Load test (search)** → Run workflow (or `k6 run -e BASE_URL=<url> loadtest/k6-search.js`) | Production is fine (read-only). The per-IP limiter answers most uncached searches from one machine with 429; that is expected | 2026-09-24 on production: p95 68.5 ms on served searches, zero 5xx (`docs/LOAD_TEST.md`) |
| Load: checkout / RFQ | `tsx apps/web/scripts/loadtest-prep.ts`, then `k6 run -e BASE_URL=<preview> loadtest/k6-checkout.js` (and `k6-rfq.js`), then **always** `tsx apps/web/scripts/loadtest-cleanup.ts` | A **preview**: production refuses simulated checkout (ADR 023) | 2026-07-09 |
| Services suites against prod | `verify-authz`, `verify-money-loop`, `verify-rfq`, `verify-te-render` (CLAUDE.md Mart rule) | Read the script header first; the money ones create and clean up fixtures | Not run since the go-live |

Targets: axe zero critical; k6 search p95 < 800 ms; checkout p95 < 1.5 s on bom1; zero 5xx.
