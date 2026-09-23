# AMClub market survey — Fiverr (FV) — services-marketplace mechanics

SESSION: fiverr.com · logged in as BUYER · 23 Sep 2026 · ≈12 min, then stopped by a **"Press & Hold" bot check** (rule 6)

Safety log:
- No messages, briefs or orders.
- I opened the checkout page to read the price summary and **did not enter card details or press "Confirm & Pay"**.
- That checkout tab ("Secure Checkout") won't close from my side; it probably shows a "Leave site?" prompt. **Please close it yourself.** Nothing was charged; the page says "You won't be charged yet" before this step.
- No personal data is recorded.

## CHECKPOINT 1 — Map

| Area | Page type | URL pattern | Persona | Priority |
|---|---|---|---|---|
| Home | Personalised home (brief CTA, profile progress, "pick up where you left off", saved services) | / | buyer | H |
| Search | Gig search + filters | /search/gigs?query= | all | H |
| Listing | Gig page (3 packages, compare table, extras, FAQ, reviews, AI summary) | /<seller>/<gig-slug> | all | H |
| Checkout | Order options drawer → payment page | gig drawer → /v4/payments/new | buyer | H |
| RFQ | Project brief ("Get tailored offers") | home CTA | buyer | H (blocked by bot check) |

## CHECKPOINT 2 — Features

| ID | Area | Feature | What it does (observed) | Persona | Where | Evidence | AMClub status | How theirs differs from ours |
|---|---|---|---|---|---|---|---|---|
| FV-01 | RFQ | Project brief → tailored offers | "Recommended for you: Post a project brief — get tailored offers for your needs" | buyer | home | Observed (CTA only; form blocked) | PARITY (RFQ) | — |
| FV-02 | Discovery | Resume + saved | "Pick up where you left off": keep exploring, **Saved services**, last search; "Inspired by your recent browsing" | buyer | home | Observed | PARITY (saved providers) | — |
| FV-03 | Other | Profile-progress nudge | "You've added 30% of your profile — complete it to get tailored suggestions" | buyer | home | Observed | CHECK | Buyer-profile completeness drives recommendations |
| FV-04 | Search | Filters | Category · Service options · **Seller details** (level: Top Rated / Level 2 / Level 1 / New seller; **hourly rate**; seller type: Agency; seller speaks: English, Hindi, Urdu, Bengali +27; seller lives in: India, US…) · Budget · Delivery time · toggles **Pro services** and **Online now** | all | search | Observed | PARITY (price, rating, language, delivery time, verified) / MISSING (online now, agency vs individual, seller level) | — |
| FV-05 | Trust | Seller levels and badges | New → Level 1 → Level 2 → **Top Rated**; **Vetted Pro**; **Fiverr's Choice**; "Ad" tag on sponsored gigs | all | cards | Observed | PARITY-ish (AMC Score, hidden) | Their levels are public and earned from metrics. Our score stays hidden and only affects ordering |
| FV-06 | Listing | 3 packages + compare table | Basic ₹18,067 (landing page, 3-day delivery, 3 revisions) / Standard ₹40,149 / Premium ₹70,260, plus a **"Compare packages" feature matrix** (functional site, pages, responsive, content upload, e-commerce, payment integration, plugins, hosting setup…) | all | gig page | Observed | PARITY (packages) / THEIRS-BETTER (compare matrix across tiers) | CHECK whether our packages have a tier-comparison table |
| FV-07 | Order | Paid extras ("upgrade your order") | Checkbox add-ons with price and added days: extra-fast 2-day delivery ₹7,026; additional revision ₹3,012 (+1 day); e-commerce ₹25,093 (+2 days); additional page ₹10,038 (+1 day); payment integration ₹12,045 (+2 days); opt-in form…; gig quantity stepper; "You won't be charged yet" | buyer | order-options drawer | Observed | MISSING | Add-ons raise order value without negotiation (compatible with our rules) |
| FV-08 | Order | Hourly option | "Need flexibility? Hire by the hour… weekly payments ₹5,018/hour — Request hourly offer" | buyer | gig sidebar | Observed | MISSING (N/A for fixed-scope compliance) | — |
| FV-09 | Messaging | "Contact me" before ordering | Pre-order chat with the seller; floating "Message <seller> · Online · avg. response time 1 hour" | buyer | gig page | Observed | NOT-NOW (provider chat before RFQ/order) | — |
| FV-10 | Trust | Capacity signal | "17 orders in queue" | all | gig header | Observed | PARITY (provider capacity) / CHECK (whether buyers see it) | Visible queue depth sets delivery expectations |
| FV-11 | Trust | Social proof | "Among my clients": client logos; reviews show country and "Nth project with this seller" | all | gig page | Observed | CHECK | Repeat-client reviews are a strong signal |
| FV-12 | AI | **AI Gig Summary** | Bulleted AI summary of the gig and its reviews ("clients value high-quality results and clear communication…") with an ⓘ | all | gig page | Observed | MISSING | Summarises reviews for scanning |
| FV-13 | AI | "What people loved about this freelancer" | Curated/highlighted review carousel | all | gig page | Observed | CHECK | — |
| FV-14 | Listing | Seller FAQ | Scope boundaries ("hosting not included", "content provided by client; placeholder text used otherwise") | all | gig page | Observed | PARITY (package FAQs) | — |
| FV-15 | Payment | Checkout fees | Package ₹18,066.84 + **service fee ₹1,344.98** (~7.4%) = subtotal ₹19,411.81 + **GST ₹3,493.93** (18%) = **total ₹22,905.74**; PayPal or cards; save card; promo code | buyer | /v4/payments/new | Observed | CHECK (do we charge buyers a fee?) | Buyer-side fee on top of a seller-side cut (inferred: 20% seller commission) |
| FV-16 | Escrow&Trust | Escrow statement at checkout | "We've got your back: your payment will be held by Fiverr until your order is completed" | buyer | checkout | Observed | PARITY (escrow) | — |
| FV-17 | Order | Order lifecycle: delivery → revisions → auto-complete after 3 days; Resolution Center for cancellations and disputes | Order page | buyer/seller | help (not opened this session) | Inferred (prior knowledge, not verified) | PARITY (we auto-accept after 72 h; capped revisions; disputes) | — |
| FV-18 | Other | Accessibility mode | "Enable accessibility for low vision / open the accessibility menu" | all | global | Observed | CHECK | — |
| FV-19 | Security | Bot defence | "It needs a human touch — PRESS & HOLD" after several page loads | all | global | Observed | N/A | — |

## FINAL REPORT — Fiverr, 23 Sep 2026, buyer

### 1. Coverage
- **Visited:** home, search, filters, gig page, order drawer, checkout summary.
- **Not reached, and why:**
  - Project brief form, order page, resolution centre and inbox: **bot check (rule 6)** plus rule 5.
  - Seller side: no seller login.
- **Checkpoints posted:** 1–2.

### 2. Journeys
- **B1:** search → seller-level/language/budget/delivery filters → gig → packages → compare matrix → extras → checkout.
- **B4:** checkout → service fee + GST → escrow "held until completed".
- **B6:** saved services; "Nth project with this seller" reviews show repeat buying.

### 3. Monetisation
- Buyer service fee (~7.4% here), plus GST on the total.
- Sponsored gigs ("Ad").
- Pro / Vetted Pro tier.
- Hourly contracts.

### 4. Trust

| Badge / signal | Basis | Prominence |
|---|---|---|
| Level 1 / Level 2 / Top Rated | Performance metrics (inferred: on-time, rating, response, earnings) | High |
| Vetted Pro | Manual vetting (inferred) | High |
| Fiverr's Choice | Algorithmic pick for a query (inferred) | Medium |
| Orders in queue, online now, avg. response time | Live signals | Medium |

### 5. AI

| Feature | Output | Quality | Disclosure |
|---|---|---|---|
| AI Gig Summary | 5-bullet summary from the gig and its reviews | Generic but accurate | ⓘ on the "Gig Summary" header |

### 6. Adopt
1. **Paid add-ons on packages**: fast-track, extra revision, extra deliverable, each with ₹ and +days (FV-07).
   - Metric: take rate, search→checkout.
   - Effort: M. Principles: kept (no negotiation, escrow).
   - Risk: price creep. Cap it at 3 add-ons.
2. **Tier-comparison matrix across a provider's packages** (FV-06).
   - Effort: S.
3. **AI review summary on provider profiles**, built only from verified-purchase reviews (FV-12).
   - Metric: search→checkout.
   - Effort: S.
   - Risk: must not hallucinate. Cite the reviews it's based on.
4. **Public earned tiers** derived from the AMC Score *bands* (e.g. "Reliable", "Top reliable"), without exposing the number (FV-05).
   - Metric: review ≥4.2, repeat.
   - Effort: S. Principles: kept.
   - Risk: this changes our "buyers never see the score" rule. **Your call.**
5. **Queue depth / next-available-start date on profiles** (FV-10).
   - Metric: dispute rate (fewer late deliveries).
   - Effort: S.

### 7. AI horizon
- **Scope-to-package matcher.** The buyer describes a need → the agent picks a tier and add-ons from a provider's package + extras, with a reason.
  - **Foundations to lay now:** package deliverables as structured line items (not prose); add-on catalogue; record which package and add-ons each buyer picked.
  - **Dark version now:** a rule-based "Recommended tier" badge.
  - **Excluded list:** no.

### 8. Anti-patterns
- The buyer service fee appears only at checkout.
- Sponsored gigs are mixed into results.
- Pre-order chat pulls deals off-platform (they allow it; we deliberately don't).
- The aggressive bot check interrupts normal browsing.

### 9. Open
- Brief form fields.
- Resolution-centre mechanics.
- Level criteria.

These weren't verified because of the bot check.
