# Report 1 — Features, technical possibilities, healthy scope creep, and moat

*AMClub market survey, September 2026.*

**Sources:**
- 19 portals: 9 walked in the founder's browser, 10 read from their public pages.
- Every AMClub claim checked against the code (`SURVEY_2026-09.md` §2).

**Companion:** `REPORT_2_UX.md`, which compares page structure, flows and UI elements.

**How to read the marks:**
- ● = has it (observed)
- ◐ = partial or limited
- ○ = not found
- ? = not observed (bot check, login wall, or out of scope for the session)
- ✕ = has it, and it's an anti-pattern or conflicts with our principles

For AMClub:
- **Live** = in production
- **Dark** = built, switched off
- **Part** = partial
- **No** = missing
- **Excl.** = excluded on purpose (§8.3 NOT-NOW)

Competitor marks come from short sessions and public pages, so treat a ○ as "not seen", not "proven absent".

---

## 1. The verdict in one page

**AMClub has the most complete *transaction* loop of any portal surveyed, and the least developed *storefront*.**

**What we have that almost nobody else does:**
- **The whole loop.** Verified provider → fixed-price or quoted order → escrow → milestones → delivery → a dispute with both sides' evidence → a verified-purchase review.
- **Who else has it:** only Fiverr and Upwork (services) and Alibaba Trade Assurance / Xometry (goods) close the loop the same way.
- **The closest Indian analogues don't:** IndiaMART, TradeIndia, JustDial, IndiaFilings and Tata nexarc all let the money and the relationship leave the platform.

**The lead we have and aren't showing:** a set of AI capabilities (Indic voice RFQ, document and CAD intake, quote extraction, the provider clerk, the procurement agent, dispute triage, fair price ranges) with safety rails no competitor shows. Most of it is switched off.

**Where we're behind:** the things a buyer sees in the first 30 seconds.
- **Trust we don't show:** measured trust stats on profiles.
- **Package merchandising:** tiers, "choose this if…", add-ons, bundles.
- **Guidance while typing an RFQ:** a live strength meter, suggested documents.
- **Discovery:** voice search, sibling-category chips, relevance feedback.
- **A pricing bug:** a price note that misstated GST (fixed in PR #28).

**The strategic reading:**
- **Incumbents can copy the storefront in a quarter.**
- **They can't copy the loop without changing their business model.** IndiaMART earns from selling leads and trust badges, and escrow would end that.
- **The loop produces the data that becomes the moat:** closed prices, on-time rates, dispute outcomes, verified reviews.
- **So the plan:**
  1. Ship the cheap storefront fixes now.
  2. Turn the loop's data into visible trust.
  3. Switch the AI on in cohorts, where it is a genuine lead.

---

## 2. Feature comparison

### 2.1 Services marketplaces: AMClub's core

| Capability | AMClub | IndiaMART | TradeIndia | Vakilsearch | IndiaFilings | JustDial | Fiverr | Upwork | Tata nexarc |
|---|---|---|---|---|---|---|---|---|---|
| **Discovery** | | | | | | | | | |
| Category browse | Live | ● | ● | ● | ● | ● | ● | ● | ● |
| Text search + filters | Live (7 filters, 4 sorts) | ● (city chips, advanced) | ● | ◐ (autocomplete) | ◐ | ● | ● (5 menus + 2 toggles) | ? | ? |
| Voice search | No (voice in RFQ only) | ● (9 languages) | ◐ (mic) | ○ | ○ | ? | ○ | ○ | ○ |
| Image search | No | ● | ? | ○ | ○ | ? | ○ | ○ | ○ |
| AI conversational search | No | ○ | ◐ (~30 s, ignores MOQ) | ✕ ("AI" label on autocomplete) | ◐ (claims) | ? | ○ | ● (Uma shortlist) | ? |
| **Listing** | | | | | | | | | |
| Fixed-price packages, Buy Now | Live | ○ (indicative prices) | ◐ (Ti Shopping) | ◐ (price → lead form) | ◐ (some lead forms) | ○ | ● | ◐ | ? |
| Package tiers + "choose this if" | No | ○ | ○ | ● | ● | ○ | ● (3 tiers + matrix) | ○ | ? |
| Paid add-ons (+₹, +days) | No | ○ | ○ | ○ | ○ | ○ | ● | ○ | ? |
| Tax shown before checkout | Part (fixed in PR #28) | ◐ | ◐ | ● (+GST) | ● (+GST) | ? | ✕ (buyer fee at checkout) | ◐ | ? |
| Delivery time per listing | Live | ○ | ○ | ✕ (contradictory) | ● | ○ | ● | ◐ | ? |
| Compliance subscription / bundle | No | ○ | ○ | ● | ● (+ LEDGERS software) | ○ | ○ | ○ | ◐ |
| **RFQ and quotes** | | | | | | | | | |
| Post a requirement | Live | ● | ● (WhatsApp) | ○ | ○ | ◐ | ● (brief) | ● | ● (tenders) |
| AI-assisted RFQ | Live (voice, ≤1 question) | ● (chat + chips) | ○ | ○ | ○ | ? | ? | ● | ? |
| Photo / document / CAD intake | Dark (photo, PDF, STEP/DXF) | ◐ (photo) | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| Live RFQ strength meter | No (check after submit) | ● (0–100) | ○ | ○ | ○ | ○ | ? | ? | ○ |
| Capped matching, no spam | Live (≤7, masked) | ✕ (number to sellers; "no spam calls" sold) | ✕ (View Number) | n/a | n/a | ✕ | ◐ | ✕ (pay-per-proposal) | ? |
| Structured quotes + compare | Live | ○ (chat) | ○ | ○ | ○ | ○ | ◐ (custom offers) | ● | ? |
| Clarifications visible to all quoters | Live | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| **Money** | | | | | | | | | |
| On-platform checkout | Live | ○ (NEFT to seller) | ◐ (TI Pay opt-in) | ◐ | ● | ✕ (JD Pay pass-through) | ● | ● | ? |
| Escrow until delivery | Live | ○ (non-delivery claim ≤₹5 L) | ◐ (opt-in) | ◐ (refund until filed) | ○ (30 days − 20 %) | ○ | ● | ● | ○ |
| Milestones / auto-accept | Live (72 h) | ○ | ○ | ? | ? | ○ | ● (3 days) | ● (14 days) | ? |
| Disputes with evidence from both sides | Live (+ AI triage, dark) | ◐ (complaint form) | ? | ? | ◐ ("Not satisfied" flag) | ? | ● | ● (+ arbitration) | ? |
| Payout hold after release | Live (T+2) | n/a | n/a | n/a | n/a | n/a | ? | ● (5 days) | n/a |
| **Trust** | | | | | | | | | |
| KYC (GSTIN, bank) | Live | ● (GST tick) | ◐ | ? | ? | ? | ◐ | ◐ | ● (PAN) |
| Credentials (CA, Bar Council) | Live | ? | ? | ◐ (reviewed-by CA) | ○ | ? | ○ | ○ | ○ |
| Verification shown to buyers | Part (chips, no dates) | ● (seller lookup, checklist) | ◐ | ◐ | ○ | ? | ◐ | ◐ | ○ |
| Measured stats public | Part (response time) | ● (response %, calls %) | ◐ ("active") | ○ | ○ | ? | ● (level, queue, online) | ● | ○ |
| Verified-purchase reviews | Live | ◐ | ? | ✕ (third-party ratings) | ◐ (volume) | ? (not stated) | ● | ● | ○ |
| Paid badges / ranks that look like quality | No (good) | ✕ (TrustSEAL, STAR) | ✕ (countdown packages) | ○ | ○ | ? | ◐ ("Ad" tag) | ◐ | ○ |
| **Channels and language** | | | | | | | | | |
| Contact masking / no pre-order chat | Live | ✕ | ✕ | n/a | n/a | ✕ | ✕ | ✕ | ? |
| WhatsApp flows | Live (notices) + Dark (agents) | ◐ (support) | ◐ (RFQ link) | ✕ (opt-in pre-toggled) | ○ | ○ | ○ | ○ | ○ |
| Indic UI | Live (en/hi; te/ta in agents) | ● (Hindi site) | ? | ● (Hindi toggle) | ○ | ? | ○ | ○ | ? |
| **AI agents** | | | | | | | | | |
| Provider-side assistant (quote drafting) | Dark (Munshi) | ? | ○ | ○ | ○ | ○ | ? | ● | ○ |
| Buyer procurement agent | Dark (no pay, no negotiation) | ● (paid tier) | ○ | ○ | ○ | ○ | ○ | ● (Uma) | ○ |
| AI negotiation | Excl. | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| **Money model** | | | | | | | | | |
| Commission on success | Live | ○ | ○ | n/a (direct seller) | n/a | ○ | ● (+ buyer fee) | ● (+ buyer fee) | ? |
| Pay-per-lead / proposal | No (by principle) | ✕ (₹37–55/lead) | ✕ (buy leads) | n/a | n/a | ✕ (opaque) | ○ | ✕ (Connects) | ◐ (tender plans) |
| Buyer subscription | No (LATER) | ● (₹999/month–₹9,999/yr) | ○ | ◐ (compliance) | ● | ○ | ◐ (Pro) | ● | ○ |
| Credit / BNPL | No (LATER) | ● | ○ | ○ | ○ | ○ | ○ | ○ | ● (Early Pay) |
| **Retention** | | | | | | | | | |
| Saved providers | Live | ● | ? | ○ | ○ | ? | ● | ● | ? |
| Reorder / repeat | Part (repost RFQ) | ◐ | ○ | ● (bundles) | ● (subscriptions) | ○ | ◐ | ◐ | ? |
| Referral | No | ? | ✕ (rewards) | ● | ? | ? | ? | ? | ? |
| Tender alerts | No | ● (tab) | ○ | ○ | ○ | ○ | ○ | ○ | ● (paid) |

### 2.2 Goods and B2B procurement: AMC Mart (dark)

| Capability | AMC Mart | Alibaba | 1688 | Moglix | Industrybuying | Udaan | OfBusiness | Amazon Business | Xometry | GeM |
|---|---|---|---|---|---|---|---|---|---|---|
| **Catalogue and price** | | | | | | | | | | |
| Buy-now catalogue | Dark | ● | ● | ● | ● | ● | ● | ● | ● (instant quote) | ● |
| Quantity-tier pricing | Dark | ● | ● | ● (chips) | ◐ | ● | ? | ● (from 2+) | ● | ? |
| GST split + ITC in ₹ | Dark | n/a | n/a | ● | ● ("save 18 %") | ? | ? | ● | n/a | ? |
| GST-invoice badge / filter | No (every seller has GSTIN) | n/a | ● ("fast invoicing") | ● (checkbox) | ● | ? | ? | ● | n/a | ? |
| ITC-ineligible disclosure | No | n/a | n/a | ? | ? | ? | ? | ● | n/a | ? |
| MOQ shown / sortable | Part (tier min qty) | ● | ● (sort) | ○ | ? | ? | ? | ◐ | n/a | ? |
| Samples | No | ● | ? | ○ | ● | ? | ? | ? | n/a | ○ |
| Customisation level / "made to order" | No | ● | ● (定制) | ○ | ○ | ○ | ● (in-house) | ○ | ● | ○ |
| Deep attribute facets | No (category, brand, price) | ● | ●● (16+ facets) | ● (6 groups) | ? | ? | ? | ● | ● | ● |
| Certification facets | No | ● | ● | ○ | ○ | ○ | ? | ○ | ● | ● (BIS) |
| Image search | No | ● | ● (+ plugin) | ○ | ○ | ? | ? | ? | ○ | ○ |
| Live commodity price | No | ○ | ○ | ○ | ○ | ○ | ● | ○ | ○ | ○ |
| **Fulfilment** | | | | | | | | | | |
| Delivery promise | Part ("ships in ~N days") | ◐ (+ delay compensation) | ● ("ships in 48 h" filter) | ● (24 h vs 5 days, pincode) | ◐ | ✕ (vague) | ? | ● (Prime) | ● (date) | ? |
| Returns by category | Dark (hours per category) | ● | ● (return freight covered) | ◐ | ● (7 days) | ● (1–45 days) | ? | ? | ? | ? |
| Non-returnable list | No | ? | ? | ? | ● | ◐ | ? | ? | n/a | ? |
| Escrow / payment protection | Dark (release after delivery photo) | ● (Trade Assurance) | ? | ◐ | ? | ◐ (fraud refunds) | ? | ◐ | ● (seller of record) | ● (govt) |
| **RFQ and quotes** | | | | | | | | | | |
| Bulk / spec RFQ | Dark (unit price + GST + HSN) | ● | ◐ | ● (30-min callback) | ◐ (human rep, 7–15 days) | ? | ? | ✕ (discount request) | ● (from CAD) | ✕ (auction above ₹30 L) |
| AI RFQ generator | No (goods) | ● (adds standards) | ? | ○ | ○ | ○ | ● (VED AI) | ? | ● (geometry) | ○ |
| Price/speed tiers in one quote | No | ○ | ○ | ● (delivery tiers) | ○ | ○ | ○ | ○ | ● (3 tiers) | ○ |
| Group buying (pools) | **Dark (unique)** | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| **Repeat buying and credit** | | | | | | | | | | |
| Reorder / subscribe | No | ◐ | ? | ◐ (wishlist) | ○ | ● | ? | ● (Subscribe & Save) | ● (part library) | ○ |
| Repeat-rate on seller cards | No | ● | ● (回头率) | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| Multi-user / approvals | No (LATER) | ? | ? | ◐ (enterprise) | ○ | ○ | ? | ● (+ three-way match) | ● (forward to purchaser) | ● (secondary users) |
| Credit / BNPL | No (LATER) | ● | ● (先采后付) | ● (enterprise) | ◐ | ● (udaanCapital) | ● (Oxyzo) | ● (Pay Later) | ○ | ● (SAHAY) |
| Loyalty points | Excl. | ○ | ○ | ✕ (coins) | ○ | ○ | ○ | ✕ | ○ | ○ |
| **AI** | | | | | | | | | | |
| AI agent | Dark (catalogue, documents, group-buy drafts) | ● (AI Mode, incl. negotiation ✕) | ? | ○ | ○ | ○ | ● (VED AI) | ○ | ● (quoting engine) | ○ |

### 2.3 Tally

Counted row by row over the 43 services capabilities in §2.1. A row counts as a **lead** when no Indian competitor has it (Fiverr/Upwork may). Principle rows (no paid badges, no pay-per-lead) count as leads because they're a deliberate difference buyers and providers feel.

| Position | Count | Rows |
|---|---|---|
| **We lead** | 12 | Fixed-price Buy Now packages; photo/document/CAD intake (dark); capped, masked matching; structured quotes + compare; clarifications visible to all quoters; escrow until delivery; credential verification; no paid badges; contact masking; WhatsApp flows; provider assistant with confirm gates (dark); no pay-per-lead |
| **Parity** | 15 | Category browse; text search; delivery time; post a requirement; AI-assisted RFQ; on-platform checkout; milestones/auto-accept; disputes with evidence; payout hold; KYC; verified-purchase reviews; Indic UI; buyer procurement agent (dark); commission; saved providers |
| **We lag** | 15 | Voice search; image search; conversational search; package tiers; add-ons; tax shown upfront (fixed in PR #28); compliance bundles; RFQ strength meter; verification shown to buyers; measured stats shown; buyer subscription (LATER); credit (LATER); reorder; referral; tender alerts |
| **Excluded on purpose** | 1 | AI negotiation. Pre-order chat, auctions and points are excluded too; they appear in the table as competitor ✕ marks |

**Pattern:** every **lead** is in the transaction loop, and every **lag** is in the storefront or retention layer. The lags are cheap (mostly S/M in `SURVEY_2026-09.md` §3). The leads are expensive for a lead-gen incumbent to copy.

---

## 3. Technical possibilities

### 3.1 What our architecture makes possible that competitors structurally can't match

These follow from building on the transaction, not on the lead.

| # | Possibility | Why we can | Why IndiaMART / TradeIndia / JustDial can't easily |
|---|---|---|---|
| T1 | **Closed-price truth**: "similar jobs closed at ₹X–₹Y" (built dark, S3.2) | We see the **paid** amount of every order | They see asking prices and chat; the deal closes off-platform |
| T2 | **Outcome-measured trust**: on-time %, repeat-buyer %, dispute rate, response rate | Every milestone, delivery and dispute is an event in our database | They see enquiries and calls, not outcomes. Their "trust" is a paid badge |
| T3 | **Evidence-backed disputes and payouts** (dispute triage, payout dossier; dark) | Both statements, the documents, the milestone photos and the timeline all sit in one place | They have no order record to examine |
| T4 | **Agents that act safely** (Munshi, procurement, support; dark) | Agents call the same `/api/v1` under the user's own delegated rights; every money step needs a human tap logged in `ai_decisions`; negotiation is refused in code | Alibaba's AI Mode negotiates and sends inquiries; IndiaMART's assistant is a paid, human-assisted demo. Neither shows safety rails |
| T5 | **Indic voice as the front door** (voice RFQ, WhatsApp) | The speech → structured RFQ pipeline exists, with one-question clarification and evals | Alibaba AI Mode is English/USD only. IndiaMART has 9-language voice **search** but routes the result to a lead |
| T6 | **Spec-level intake**: STEP/DXF bounding box and hole estimates, document extraction | Deterministic parsers + document intake in `shared/drawings` + agent-core | Only Xometry prices from CAD. Indian directories take a photo at most |
| T7 | **Cluster group buying** (pools; dark) | One escrow spine and a pool state machine with pay-on-close | No surveyed portal pools demand |

### 3.2 What becomes possible in about 12 months

The survey assumed models about 10× cheaper and better. Our own gate gives a concrete way to price that: **AI cost must stay under 5 % of commission** (DESIGN §8.6, A2 gate).

- **Example:** a ₹10,000 services order at a 10 % commission earns ₹1,000, so the AI budget is **about ₹50 per order**, across every model call the order touches.
- At today's prices, ₹50 covers a few bounded calls: parse, pre-check, extract, summarise.
- At 10× cheaper, the same ₹50 covers **tens of reasoning calls plus minutes of speech**. That moves these features from uneconomic to routine:

| Horizon feature | Unlocked by | Foundation to lay now (see `SURVEY_2026-09.md` §6.2) | Small dark version now |
|---|---|---|---|
| **Provider-fit % and a reasoned shortlist** before and after quotes | Cheap reasoning over provider facts + the buyer's constraints | F1 quote-outcome labels, F2 typed constraints (budget and deadline already typed), F4 provider facts | A rule-based fit % logged in shadow, shown to nobody |
| **Price guidance from CAD / photo** for job-shop work (guidance, never platform pricing) | Reliable geometry and vision + enough closed prices | F3: save CAD features as typed fields; keep every quote and the paid amount | A shadow price band per CAD RFQ, with its error tracked |
| **Indic voice search + voice everywhere** (search, RFQ, support, provider replies) | Near-free real-time Indic speech-to-text | F6: consented audio → text → edited-text triples; a Hindi/Telugu service-term synonym table | A mic on the search box using the RFQ speech pipeline |
| **"What does my business need?" obligations engine** (Udyam + GSTIN + sector + state → licences and renewals) | Cheap reasoning over state rule tables + certificate reading | F7: a "licences held" table, AP/TS rule table with sources, 50 CA-reviewed profiles as evals | "Businesses like yours also bought…" from orders |
| **Credibility cross-checks** against GST, MCA, ICAI (Alibaba does this with customs records) | Dependable browser agents on government portals | F4: timestamped verification evidence; declared vs actual category | A nightly GSTIN-status re-check that flags cancellations |
| **Review and evidence summaries** that cite their sources | Cheap summarisation + a citation check | Verified reviews and order evidence already stored | Summary generated in shadow; show only above N reviews |
| **Cluster demand forecasting** for group buys and reorders | Cheap time-series + reasoning per buyer | F8: SKU attributes, reorder intervals, pincode/weight | "You usually reorder in ~N days" (rule-based) |
| **Always-on provider clerk** (Munshi drafting every quote, chasing documents, replying on WhatsApp) | Long-running agents at near-zero marginal cost | Price book, drafts ledger, confirm gates (exist) | Munshi is built dark; switch it on per cohort |

**What the model price drop does not unlock:**
- **Trust.** Whoever holds the closed transactions holds the data these features learn from. That's why §5 ranks data capture above AI features.
- **Regulatory and principle limits.** Negotiation, auctions, advice and moving money without a human all stay out, however cheap the models get.

### 3.3 One cross-cutting build that pays for every AI feature above

A **shadow-prediction ledger (F10):** one table holding `(feature, subject, predicted, actual, error, model, prompt_version)`.
- Every new AI feature starts in shadow, predicting without showing.
- It gets switched on only when its measured error is acceptable.
- It reuses the eval harness, the prompt registry and `ai_invocations`.

This turns "AI will get better" into a measured, per-feature switch.

---

## 4. Healthy scope creep

**Scope creep is healthy when it deepens the loop we already own. It is unhealthy when it builds a second business.**

### 4.1 The five tests (all must pass)

1. **Same spine.** It uses the existing order → escrow → payout → dispute path. It adds no second money path (CLAUDE.md, "one spine").
2. **Moves a target metric.** At least one §1.9 metric: RFQ→quote ≥70 % in 48 h, search→checkout ≥2.5 %, repeat ≥25 %, dispute <5 %, review ≥4.2, providers onboarded, take rate 10–12 %.
3. **Keeps the principles.** Escrow; no leaving the platform; no negotiation or auctions; trust earned, never sold.
4. **Ships dark and reverses cleanly.** It sits behind a flag or setting. Money or state-machine changes need an ADR.
5. **Makes the data asset stronger.** It creates or uses outcome data (closed prices, on-time, repeat, disputes) rather than vanity data.

### 4.2 Candidates, classified

| Candidate | Seen at | Tests passed | Call | Note |
|---|---|---|---|---|
| Package tiers + "choose this if" + comparison matrix | Vakilsearch, Fiverr, IndiaFilings | 1–5 | **Healthy: now** | Schema + UI; no money-path change |
| Priced add-ons (+₹, +days) | Fiverr | 1–5 | **Healthy: with ADR** | Touches order amounts |
| Registration + 12-month compliance bundle, paid out by milestone from escrow | Vakilsearch, IndiaFilings | 1–5 | **Healthy: with ADR** | The retention engine. Long escrow needs rules for provider churn |
| GeM onboarding checklist + tender alerts (alerts and application help only) | GeM, MSME Mart, Tata nexarc, IndiaMART | 1–5 (if fenced) | **Healthy** | Must never facilitate bidding |
| Provider funnel analytics | JustDial, Tata nexarc | 1–5 | **Healthy: now** | Must not reveal the AMC Score |
| Public measured stats + a verification checklist | Alibaba, 1688, IndiaMART | 1–5 | **Healthy: needs D1** | Turns loop data into visible trust. The single best item on this list |
| Buyer "verified business" signal to providers | IndiaMART (sold there) | 1–5 | **Healthy: needs D2** | Free and earned, never sold |
| Speed tiers in one quote | Xometry, Moglix | 1–5 | **Healthy: with ADR** | The buyer picks; no negotiation |
| AMC Mart dual mode, typed attributes, samples, promises, reorder | 1688, Alibaba, Moglix, Industrybuying, Amazon Business | 1–5 | **Healthy: Mart roadmap** | Inside the staged Mart build |
| Free tools: GST calculator, company-name check | Vakilsearch | 2, 3, 4 | **Healthy-ish: §8.1** | Top of funnel only; weak on test 5 |
| Paid phone consult entry product | Vakilsearch | 1–4 | **Needs §8.1 (D5)** | Must route into packages, not replace them |
| Order-linked credit (NBFC partner, paid out to the provider through escrow) | Udaan, OfBusiness, GeM, Tata nexarc, Amazon Business | 1, 2, 5 | **LATER (V2→V3 gate)** | Real, proven demand; regulatory weight |
| Buyer membership with metered AI | IndiaMART, Alibaba, Upwork | 2, 4 | **LATER (V1.5)** | Must never gate fair matching |
| Multi-user buying, approvals, three-way match | Amazon Business, Xometry, GeM | 1, 4 | **LATER** (multi-branch) | For larger buyers; not the Kurnool persona |
| Binding arbitration tier | Upwork | 1, 3 | **LATER (D10)** | Needs order values that justify it |
| Our own accounting SaaS (a LEDGERS clone) | IndiaFilings | 2 only | **Unhealthy** | A second product. A *thin* compliance dashboard inside bundles is fine |
| Logistics fleet, warehouses, in-house manufacturing | Zetwerk, OfBusiness, Udaan | — | **Unhealthy** | Explicitly excluded by the Mart spec; the channel-conflict trap |
| Pay-per-lead, paid ranks, trust badges for money | IndiaMART, Upwork, TradeIndia | — | **Unhealthy** | Breaks the model |
| Auctions, AI negotiation, "discount request" flows | Alibaba, GeM, Amazon Business | — | **Excluded (NOT-NOW)** | Recorded, not built |
| Loyalty coins | Moglix, Amazon Business, TradeIndia | — | **Excluded** | Gamification |

---

## 5. Moat

A moat here is **something a well-funded incumbent can't copy within a year without breaking its own business.** Features aren't moats; **data and structural position** are.

| # | Moat layer | What it is | Strength today | What deepens it (next 90 days) | Who could attack it |
|---|---|---|---|---|---|
| M1 | **Transaction truth** | Closed prices, on-time %, repeat %, dispute outcomes, verified reviews, all from escrowed orders | **Building.** The machinery exists; volume is pre-pilot | Get to the 25 real paid orders (Phase 9). Show measured stats (D1). Record why each losing quote lost (F1) | IndiaMART, if it adds escrow. That would cannibalise its lead sales, so it's unlikely soon |
| M2 | **Trust we don't sell** | Badges earned from outcomes and verification, never bought | **Strong in principle, invisible in product** | A verification checklist with dates; wire or remove "Top Rated"; write the rule down (`SURVEY_2026-09.md` §5) | Anyone can claim it. Proof comes from showing *measured* stats they don't have |
| M3 | **Price truth** | Fair price ranges from paid orders only, behind privacy thresholds | **Built dark**; needs ≥30 jobs per key | Switch compute on as soon as volume allows; extend to goods (Moglix-style "insights") | Directories only have asks; Amazon Business has goods prices but no services |
| M4 | **The provider's workflow** | Price book, Munshi drafts, WhatsApp approvals, payouts, score card: the provider runs the business here | **Built dark** | Switch Munshi on for the first cohort; add funnel analytics; the "payment secured" chip | Upwork-style tools; Tally/IndiaMART bundles. Ours is WhatsApp-native and Indic |
| M5 | **Indic voice + WhatsApp front door** | Speech → structured RFQ → escrowed order, in Hindi/Telugu/Tamil | **Partly live** (voice RFQ), agents dark | Voice search; the procurement agent cohort; the voice eval corpus (F6) | IndiaMART (9-language voice search). Alibaba will localise eventually |
| M6 | **Cluster density** | Kurnool fabrication: providers + goods sellers + buyers + group buys in one place | **Not started** (Mart dark) | Mart Launch Gate; one cluster; pools | Moglix / Udaan on price. Not on club identity or trust |
| M7 | **AI safety as a feature** | Confirm gates, a no-negotiation clamp, the injection boundary, evals, the decision ledger | **Strong** (architecture) | Make it visible: a named assistant with a plain "what it can and can't do" line | Alibaba AI Mode negotiates by default, which is a different trust posture |

**The flywheel:** verified transactions (escrow) → outcome data (M1) → visible measured trust (M2) + price truth (M3) → higher conversion, more transactions. Providers stay because the work, the payouts and the reputation live here (M4). Voice and WhatsApp widen the funnel to MSMEs no English form reaches (M5).

**The critical path:** M1 needs real volume. None of the moat exists until paid orders flow. Every moat layer waits on the pilot: live Razorpay, the H7/H8 items and 25 real paid orders.

### 5.1 Threats and responses

| Threat | Likelihood (12 months) | Our response |
|---|---|---|
| IndiaMART adds escrow + AI to its buyer plans (it already sells an AI procurement assistant and "no spam calls") | Medium | Out-execute on outcome trust and on not selling trust; free buyer verification (D2); publish "we never sell your number" |
| Alibaba AI Mode reaches Indian domestic B2B in Indic languages | Low–medium | Services depth + escrow for Indian compliance work; Indic voice first; the cluster play for goods |
| Vakilsearch / IndiaFilings bundle compliance subscriptions | High (already live) | Match with bundles paid out by milestone from escrow; their weakness is no escrow, lead forms and a flat 20 % cancellation charge |
| Tata nexarc brand + tenders + finance | Medium | Provider-level verification vs brand trust; tender alerts free (D9) |
| GeM free registration for MSMEs selling to government | High (structural) | Complement it: a GeM-onboarding service + checklist; don't compete for government buying |

---

## 6. Recommended sequence

**Now (4–6 weeks, all small, no ADR unless noted):**
1. **Provider trust panel:**
   - verification checklist with dates;
   - member since and years of experience;
   - "active this week" (write `last_seen_at`);
   - next available start;
   - wire or remove "Top Rated".
   - Then measured stats after D1.
2. **RFQ conversion:** a live strength meter from the shared rules; the failed-search query carried into the RFQ; relevance thumbs.
3. **Package honesty:**
   - a refund line on the card;
   - a government-dependency disclaimer;
   - "choose this if…";
   - "₹X + GST = ₹Y".
4. **Provider side:** wizard step analytics, GSTIN auto-fill (trade name, state), funnel analytics, the "payment secured" chip, the GeM checklist.
5. **Foundations (dark):** F1 loss labels, F3 typed CAD fields, F4 verification evidence + nightly GSTIN re-check, F10 shadow ledger.

**Next (the quarter, each with its ADR):** package tiers + add-ons; speed tiers in quotes; compliance bundles with milestone escrow; buyer verification signal (D2); PAN-only providers (D3); voice search.

**Gated:** Mart Launch Gate (dual mode, typed attributes, promises, samples, reorder); procurement agent cohort (§8.1); membership + metered AI (V1.5); NBFC credit through the escrow rail (V2→V3).

**Never (as currently defined):** pay-per-lead, paid trust badges, auctions/negotiation, points, own logistics or inventory.
