# AMClub market survey — IndiaMART (IM)

SESSION: IndiaMART — https://www.indiamart.com · logged in as BUYER (no seller account; seller side seen only as the free-seller shell and help docs) · 23 Sep 2026 · time spent ≈ 45 min

Safety log: I made no enquiries, calls or "Get Best Price"/"Submit Requirement" submissions, and didn't open the Message Centre or unread leads. The "Fill using AI" RFQ chat got one harmless message; I did **not** press "Fill my form" or "Next". No personal data is recorded here. Supplier names are omitted.

---

## CHECKPOINT 1 — Map (page inventory)

| Area | Page type | URL pattern | Persona | Priority |
|---|---|---|---|---|
| Buyer home | "My IndiaMART" dashboard (logged-in home replaces www home) | buyer.indiamart.com/ | buyer | H |
| Search | Search results (products + services) | dir.indiamart.com/search.mp?ss= | all | H |
| Search | Advanced search | www.indiamart.com/search.html | all | M |
| Listing | Product/service detail | www.indiamart.com/proddetail/<slug>-<id>.html | all | H |
| RFQ | Post a Requirement (AI + form) | buyer.indiamart.com/buyertools/postbl/ | buyer | H |
| Trust | Payment Protection landing | buyer.indiamart.com/payment-protection | buyer | H |
| Trust | Seller Verification / Payment Safety (lookup by mobile/email/GSTIN) | buyer.indiamart.com (SPA panels) | buyer | H |
| Membership | Verified Business Buyer plans | buyer.indiamart.com (SPA panel) | buyer | H |
| Logistics | Ship With IndiaMART (FTL/PTL/courier booking) | shipwith.indiamart.com/book/full-load | buyer/seller | M |
| Finance | Loans; Credit Score (goes to HelloTrade, a group site) | buyer.indiamart.com; hellotrade.com/free-credit-score | buyer | M |
| Seller | Seller registration wizard | www.indiamart.com/seller/ | seller | H |
| Seller | BuyLeads console (free-seller shell) | seller.indiamart.com/bltxn/ | seller | H |
| Help | Help centre + categories + KB articles | help.indiamart.com/… | all | H |
| Help | Complaint form | help.indiamart.com/complaint-registration/ | all | M |
| Other | Exporters site, Hindi site, IndiaMART Lens, Flips, Tally on web/mobile, GST e-invoice, accounting software (footer) | various | all | L (not visited) |

---

## CHECKPOINT 2 — Buyer discovery, listings, RFQ

| ID | Area | Feature | What it does (observed) | Persona | Where | Evidence | AMClub status | How theirs differs from ours |
|---|---|---|---|---|---|---|---|---|
| IM-01 | Search | Unified product+service search | One box for goods and services; result count shown ("849 products available" for GST registration) | all | search.mp | Observed | PARITY | Services are shown as "products" with spec tables, not packages |
| IM-02 | Search | City chips + "Near Me" | One-click city filters (Hyderabad, Delhi…), All India, Near Me | all | search.mp | Observed | PARITY (state filter) | Filters by city, not state; one click, no filter panel |
| IM-03 | Search | Related-category chips | Horizontal chips for sibling categories (GST consultant, return filing, company registration…) | all | search.mp | Observed | CHECK | Helps people who typed the wrong term |
| IM-04 | Search | Image search | "Search by Image" icon in the search bar | all | header | Observed (not used, rule 5) | MISSING | — |
| IM-05 | Language&Voice | Voice search in 9 languages | Voice or typed search in Hindi, Bangla, English, Gujarati, Kannada, Malayalam, Marathi, Telugu, Tamil | all | help article + mic icon | Help-doc | THEIRS-BETTER | We have voice RFQ; they also have voice search across 9 Indic languages |
| IM-06 | Search | Advanced search | Search type (Product/Company); seller type (Wholesaler/Manufacturer/Retailer/Exporter); city (sellers FROM vs DEALING IN the city); "With price only" | all | search.html | Observed | THEIRS-BETTER | "Only with price" and "from vs serving this city" are useful; we lack both toggles (CHECK) |
| IM-07 | Search | Results-quality feedback | "Did you find the Services for '<q>'? Yes/No" | all | search.mp | Observed | MISSING | Cheap relevance labels for search evals |
| IM-08 | RFQ | Inline RFQ widget in results | "Tell us what you need, and we'll help you get quotes", prefilled with the query; appears mid-results and at the bottom | all | search.mp | Observed (not submitted) | CHECK | Turns a failed search into an RFQ with one click |
| IM-09 | Listing | Service listing = spec table + price | Service mode, applicant type, turnover band, documents required, duration, payment mode (often "Online/Offline"), service location "Pan India"; single price or none | all | proddetail | Observed | OURS-BETTER | We sell fixed-scope packages with delivery days and escrow. Theirs is a price hint; the real price comes after the lead |
| IM-10 | Listing | GST-derived firmographics on seller card | Legal status, GST registration year, turnover band, nature of business, verified GSTIN, IEC, member since, employee band | all | proddetail "About" | Observed | THEIRS-BETTER | We verify GSTIN but (CHECK) don't show turnover band or legal status to buyers |
| IM-11 | Trust | Response-rate and call-answer % | "67% Response Rate", "86% Calls Answered", "Usually replies within 4 hrs", "Highly Active" | all | cards, proddetail, seller verification | Observed | PARITY/CHECK | We show response time; they also show response rate and call-answer % |
| IM-12 | Trust | Rating distribution + sub-scores | 1–5★ histogram plus Response %, Quality %, Delivery % | all | proddetail | Observed | CHECK | Sub-scores are cheap, useful facets |
| IM-13 | Language&Voice | "View in Hindi" | Listing title machine-translated to Hindi | all | proddetail | Observed | CHECK | — |
| IM-14 | Discovery | "Top local sellers near you" | Geo cross-sell block under the listing | all | proddetail | Observed | CHECK | — |
| IM-15 | Discovery | "Related to items you viewed" feed | Personalised dashboard feed with Get Best Price, Ask Price, heart (Add to Favourites) and Verify Seller | buyer | buyer home | Observed | PARITY (saved providers) | Their feed is browsing-driven, pushed to the dashboard |
| IM-16 | Ads&Monetisation | Paid-rank labels in results | "LEADING SUPPLIER", "STAR SUPPLIER" tags on sponsored/paid sellers at the top of results | all | search.mp | Observed | NOT-NOW / LATER (featured placement) | Pay-to-rank mixed into organic results |
| IM-17 | Listing | Goods listing | Unit price (₹/Kg, ₹/Piece), spec table, "Enter Quantity + Submit Requirement" inline. No MOQ, GST/ITC display, delivery promise or sample option on the samples checked | all | proddetail (welding electrodes, fasteners) | Observed | OURS-BETTER (AMC Mart: server-side GST, ITC display, delivery-photo payout) | Price is indicative only; no checkout |
| IM-18 | RFQ | RFQ "strength" meter | 0–100 score with a checklist: product name +10, image +10, specs +26, delivery location (prefilled), timeline +10, payment terms +10, buyer type +5, profile +5, purchase frequency +5, additional details +5; shows "FILL NEXT" | buyer | postbl | Observed | THEIRS-BETTER | We run a quality pre-check before sending; they show a live score while you type, which nudges completion |
| IM-19 | AI | "Fill using AI" RFQ chat | Chat asks what you need. My test ("50 kg of 3.15 mm MS welding electrodes for fabrication") came back with a correct restatement and one clarifying question, "preferred brand?", with brand chips. Then "Fill my form" fills the form | buyer | postbl | Observed (1 harmless message; did not fill) | PARITY (voice RFQ + ≤1 clarifying Q) | Theirs is text chat with tappable answer chips; ours is voice-first |
| IM-20 | RFQ | Voice + camera on the RFQ name field | Mic and camera icons in the product-name input; "Post RFQ via Photo" upload card on the dashboard | buyer | postbl, buyer home | Observed (not used) | PARITY (voice/photo intake) | Photo-first RFQ is promoted on the dashboard |
| IM-21 | RFQ | Drafts / recent searches | "Continue where you left off"; recent searches listed as suggestions | buyer | postbl | Observed | CHECK | — |
| IM-22 | RFQ | What happens next | "IndiaMART will connect you with relevant suppliers via email and mobile"; "Get instant quotes from verified suppliers" | buyer | help: buy-requirement | Help-doc | OURS-BETTER | Their RFQ hands your phone number to sellers, and calls follow (see IM-A1). Ours caps at 7 quotes, masks contact details and keeps it on-platform |
| IM-23 | Quote | "RFQ reply" card | Dashboard card: "<seller> replied to you… IndiaMART connected you with this seller → Chat Now" | buyer | buyer home | Observed | PARITY | No structured quote or compare; just a chat thread |

---

## CHECKPOINT 3 — Trust, protection, membership, logistics, finance

| ID | Area | Feature | What it does (observed) | Persona | Where | Evidence | AMClub status | How theirs differs from ours |
|---|---|---|---|---|---|---|---|---|
| IM-24 | Escrow&Trust | Buyer Payment Protection (≤₹5 lakh) | Refund of up to ₹5L for **non-delivery only**, on first orders with **TrustSEAL** sellers the buyer was **connected with via IndiaMART**, paid by **NEFT/RTGS/IMPS to the seller's verified bank account**. Not covered: poor quality, partial delivery. Claim within 60 days by phone/email; 15–20 days to settle, up to 60 | buyer | /payment-protection | Observed | OURS-BETTER | We hold money in escrow and cover quality via disputes. Theirs is an after-the-fact claim, paid off-platform, non-delivery only |
| IM-25 | Verification | Seller Verification lookup | Buyer enters a seller's mobile, email or GSTIN and sees: connected-to-you or not, GST, calls-answered %, member since, reply time, "View Secured Payment Channels Before Paying" (verified bank account), reviews ("<City> Buyer — verified buyer review"), top markets, key products | buyer | buyer home → Seller Verification / Payment Safety | Observed | MISSING (as a lookup) | Our answer is to keep payment on-platform. The idea worth copying is "is this bank account really this provider's?", useful for off-platform fraud checks |
| IM-26 | Verification | What "Payment Safety" says it verifies | GST authenticated with the GSTIN portal; bank account validated; "complete background check: PAN, ratings, full history" | buyer | Payment Safety panel | Observed | PARITY (GSTIN + penny-drop) | Theirs is shown to buyers as a named checklist; ours sits in the admin queue (CHECK whether buyers see it) |
| IM-27 | Membership | Verified Business Buyer (buyer paid tiers) | **Mini ₹999/month**: Procurement Assistant on 2 RFQs, ₹5L protection, multi-supplier quotes. **Plus ₹1,999/yr**: 10 RFQs, ₹10L protection, VBB badge, Vendor Management System. **Max ₹9,999/yr**: 50 RFQs, **Buy Now Pay Later**, **"No spam calls"** | buyer | buyer home → Verified Business Buyer | Observed | LATER (membership tiers) | Buyers pay for sourcing help, a trust badge and relief from spam calls |
| IM-28 | AI | Procurement Assistant (paid) | 4-step demo: understands need → drafts RFQ (product, qty, process, location) → finds curated suppliers with ratings → shares best quotes with "GST verified", "96% match" and ₹/kg | buyer | VBB panel | Observed (marketing demo, not used) | PARITY (Procurement Agent, built/off) | Monetised as a buyer subscription; shows a "% match" score per supplier |
| IM-29 | Membership | Verified Business Buyer badge | Badge visible to all suppliers; "higher chance of seller response, priority attention" | buyer | VBB panel | Observed | MISSING | A buyer-side trust signal to lift provider response. Relevant to our RFQ→quote ≥70% target |
| IM-30 | Order | Vendor Management System | "Centralized RFQ tracking and supplier shortlists; track order and shipment status in one place" | buyer (Plus+) | VBB panel | Observed (claim) | CHECK | — |
| IM-31 | Credit&Finance | Buy Now Pay Later | Included in the Max plan | buyer | VBB panel | Observed (claim) | LATER (NBFC credit) | — |
| IM-32 | Credit&Finance | Loans + Credit Score | "Loans" in buyer nav. "Credit Score" opens the group's HelloTrade free credit score page. "MSME Loans" in the seller header | buyer/seller | buyer nav; seller header | Observed | LATER (NBFC credit) | Lead-gen for lenders |
| IM-33 | Logistics | Ship With IndiaMART | Book Full Truck (>2.5 t), Part Truck (30 kg–2.5 t) or Courier (<30 kg): pickup/drop city, weight band (≤3 t, 3–9, 9–18, >18) → compare shipping cost from logistics partners | buyer/seller | shipwith.indiamart.com | Observed (form not submitted) | MISSING (we're not building a fleet; an aggregator link is different) | A marketplace for transporters, not own logistics |
| IM-34 | Support&Disputes | Complaint form | Categories: BuyLead/Tender/Enquiry issue; complaint against buyer; complaint against seller; activation/deactivation; deletion; profile; IPR complaint; **Modify NACH**; other. Also phone, WhatsApp, email | all | /complaint-registration | Observed | OURS-BETTER | We have in-order disputes with statements from both parties. Theirs is a generic complaint form |
| IM-35 | Support&Disputes | Irrelevant-supplier escalation | "If you receive irrelevant suppliers for your requirement, write to buyershelp@…" | buyer | help: trade disputes | Help-doc | N/A | Shows matching quality is a known pain point |

---

## CHECKPOINT 4 — Seller side (shell + help docs)

| ID | Area | Feature | What it does (observed) | Persona | Where | Evidence | AMClub status | How theirs differs from ours |
|---|---|---|---|---|---|---|---|---|
| IM-36 | Verification | Seller registration: GSTIN or PAN | Step 1 of 2: "I have GSTIN → auto-verify & fill details" or "GST exempt → use PAN". "Don't remember your GSTIN? Find it with your mobile or PAN" | seller | /seller/ | Observed (not submitted) | THEIRS-BETTER | Their GSTIN lookup by mobile/PAN and auto-fill cuts onboarding friction; we verify GSTIN (CHECK: do we auto-fill from it?). PAN-only path for GST-exempt sellers |
| IM-37 | Analytics | Drop-off stage tracking | Registration redirect URL carries base64 `{"stage":3,"reason":"dropped user"}` | seller | /seller/?rditm= | Observed | CHECK | They re-target onboarding drop-outs by the stage they left at |
| IM-38 | Seller-tools | BuyLead console | Tabs: Relevant · Recent · Export · Catalog Views · More Leads · Shortlisted · Latest Tenders · Past Transactions. Filters: location (Recommended / own state / India / nearby states), categories, order value (>₹10k, >₹50k), lead type (Bulk ₹20k+, GST-registered buyer), "Recent" toggle | seller | seller.indiamart.com/bltxn/ | Observed (empty; search blocked until registration) | N/A (lead-buying) | Sellers pull leads. Our matched fan-out pushes RFQs to ≤7 providers |
| IM-39 | Ads&Monetisation | Seller paid plans (prices ex-GST) | MDC ₹35k/1y · ₹72k/2y · ₹90k/3y (10 leads/week + 1/day). TrustSEAL Pro ₹60k/1y · ₹90k/2y · ₹1.2L/3y (14/week + 1/day; **cost per lead ₹55/41/37**). Maximiser Pro ₹85k/1y · ₹1.3L/2y · ₹1.7L/3y (28/week). IM Star Pro (30/week; 6/week per category; "Star Supplier" label), IM Leader Pro (40/week; "Leading supplier"), Industry Leader (prime category + location slot): price on request | seller | help: paid-services-of-indiamart; trustseal-pro | Help-doc | N/A (pay-per-lead is not our model) | Their revenue is subscriptions plus lead quotas. Ours is success commission |
| IM-40 | Ads&Monetisation | TrustSEAL Pro inclusions | Certificate (physical + e-copy), stamp and logo, higher listing position, top-keyword promotion, templated catalogue up to 10,000 products, subdomain, PDF brochure, catalogue views, lead manager, seller performance report, business loans, Ship with IM, buyer payment protection eligibility, price-hike protection | seller | help: trustseal-pro | Help-doc | N/A | **Trust is sold**: the badge buyers rely on for protection comes with a ₹60k/yr ad plan |
| IM-41 | Seller-tools | Leads API (pull + real-time push to CRMs) | Lead Manager pull API and CRM push API | seller | help: im-lms-leads-api | Help-doc | LATER (provider APIs) | — |
| IM-42 | Seller-tools | Tally on web / accounting / GST e-invoice | Seller-nav "Tally on web"; footer: Accounting Software, Tally on Mobile, GST e-Invoice | seller | seller nav, footer | Observed (not opened) | CHECK (Documents Agent drafts invoices) | Bundled accounting ties sellers in |
| IM-43 | Seller-tools | Tenders feed | "Latest Tenders" tab in the lead console | seller | bltxn | Observed | MISSING | GeM/tender alerts for providers. Fits our govt & licensing category |
| IM-44 | Support&Disputes | Account manager | "How do I check my account manager details" (paid sellers get a named rep) | seller | help | Help-doc | N/A | — |
| IM-45 | Payment | NACH auto-debit for plans | "Modify NACH" complaint type means plan fees are auto-debited | seller | complaint form | Observed | N/A | — |

---

## FINAL REPORT — IndiaMART, 23 Sep 2026, logged in as buyer

### 1. Coverage
- **Visited:** 14 page types (dashboard, search, advanced search, service listing, goods listing, post-RFQ + AI chat, payment protection, seller-verification result, payment safety, VBB plans, Ship With IM, seller registration, BuyLead console, help home/categories/7 KB articles, complaint form).
- **Found, not visited:** exporters site, Hindi site, Lens, Flips, Tally/e-invoice tools, mobile-app-only screens, Loans page body.
- **Not reached, and why:**
  - Message Centre and inbox: rule 5. Also, the browser safety classifier blocked opening it.
  - RFQ steps after the product name: rule 2. The field list comes from the strength checklist.
  - Contact Supplier / Get Best Price / Call Now forms: rule 1.
  - Seller BuyLead search, listing creation and payouts: login (not a registered seller); from help docs only.
  - Cart/checkout: no buy-now checkout found on the buyer side.
- **Checkpoints posted:** 1–4.

### 2. Journeys (compact)

| Journey | Steps observed | Friction / notes |
|---|---|---|
| B1 Find | Search → city chip → related chips → listing → "Contact Supplier" or "Call Now" | No compare view. Prices are indicative, and "Payment mode: Online/Offline" on services |
| B2 RFQ | Name (voice/camera/AI chat) → specs → delivery location → timeline → payment terms → buyer type → profile → purchase frequency → additional details, with a 0–100 strength meter | After posting, sellers get your number and call (IM-A1). Good at getting a complete RFQ |
| B3 Quotes | "RFQ reply" card → Chat Now; negotiation happens in chat or on the phone | No structured quotes and no side-by-side compare (inferred from the absence of UI) |
| B4 Order→pay | No on-platform order or checkout for buyers. Payment is NEFT/RTGS/IMPS to the seller. Paid tiers promise order/shipment tracking | Off-platform payment |
| B5 Protection | Verify the seller → pay their verified bank account → claim within 60 days for non-delivery only | Quality and partial delivery aren't covered |
| B6 Reorder | Favourites (heart), "related to items you viewed", recent searches; VMS supplier shortlists (paid) | — |
| S1 Onboarding | GSTIN (auto-fill) or PAN → products → done | Low friction. Drop-offs tracked by stage |
| S2 Listing | Not reached (login). Help: templated catalogue up to 10k products on TrustSEAL | — |
| S3 Leads | Lead console tabs/filters (IM-38). Leads come from plan quotas (10–40/week) | Pay-per-lead; tenders tab |
| S4 Orders/payouts | Not on-platform | — |
| S5 Growth | Plans IM-39; labels STAR/LEADING; top-keyword promotion; account manager | — |
| T1 Trust | See §4 | — |
| A1 AI | Fill-using-AI RFQ chat; Procurement Assistant (paid); voice search 9 languages; image search; Hindi listing view | — |

### 3. Monetisation observed
- **Seller subscriptions (ex-GST):**
  - MDC: ₹35k, ₹72k or ₹90k for 1, 2 or 3 years.
  - TrustSEAL Pro: ₹60k, ₹90k or ₹1.2L; effective ₹55/41/37 per lead.
  - Maximiser Pro: ₹85k, ₹1.3L or ₹1.7L.
  - Star, Leader and Industry Leader: price on request.
- **Buyer subscriptions (new):** VBB Mini ₹999/month, Plus ₹1,999/yr, Max ₹9,999/yr.
- **Other revenue lines:** logistics aggregation, loans/BNPL, accounting (Tally), payment-protection eligibility bundled into TrustSEAL, and ads for brands/agencies.

### 4. Trust system

| Badge / level | What it verifies | Prominence |
|---|---|---|
| GST tick | GSTIN matches the GST portal | Every card |
| TrustSEAL | Paid plan (₹60k+/yr); certificate; inferred document check. Needed for payment protection | Every card, high |
| Payment Protected | Seller is TrustSEAL and eligible for ≤₹5L non-delivery refund | Seller cards |
| STAR / LEADING SUPPLIER / Industry Leader | **Paid placement tier**, not a quality signal | Top of results, high |
| Verified Exporter | Paid export service (not opened) | Cards |
| Response rate, calls answered, reply time, "Highly Active" | Behavioural | Cards / verification page |
| Ratings + Response/Quality/Delivery % | Buyer reviews ("verified buyer review" label) | Listing |
| Verified Business Buyer | Buyer paid tier + badge | Shown to sellers |

### 5. AI features

| Feature | Input → output | Quality from my test | Disclosure | Human confirms? |
|---|---|---|---|---|
| Fill using AI (RFQ) | Free text → restatement + 1 clarifying Q with brand chips → form fill | Good: parsed qty/size/material/use correctly; one sensible question | "Fill using AI" label | Yes: the user presses "Fill my form", then submits |
| Procurement Assistant | Need → RFQ → curated suppliers → quotes with "% match" | Not tested (paid) | Marketed as AI | Inferred yes |
| Voice search (9 languages) | Speech → query | Not tested | Help doc | n/a |
| Image search / Lens | Photo → matching products | Not tested (rule 5) | Icon | n/a |
| "View in Hindi" | Listing → Hindi title | Observed working | Label | n/a |

### 6. Top 10 to adopt

1. **Live RFQ strength meter with field weights** (IM-18). Buyers post thin RFQs and providers skip them.
   - Metric: RFQ→quote ≥70% in 48 h.
   - Effort: S. Principles: all kept.
   - Risk: people pad fields to push the score up.
2. **Verified Business Buyer signal (free, earned), shown to providers** (IM-29). Providers ignore RFQs from unknown buyers.
   - Earn it from Udyam + GSTIN verification plus a paid-order history.
   - Metric: RFQ→quote response.
   - Effort: S–M. Principles: kept.
   - Risk: new buyers without a badge get fewer quotes.
3. **Public buyer-facing verification checklist per provider** (IM-25/26). "What exactly did you verify?" GSTIN, bank penny-drop, credentials, each with a date.
   - Metric: search→checkout.
   - Effort: S. Principles: kept.
   - Risk: exposing check dates invites gaming.
4. **Multilingual voice search**, not just voice RFQ (IM-05).
   - Metric: search→checkout for Hindi/Telugu users.
   - Effort: M. Principles: kept.
   - Risk: poor ASR on service jargon.
5. **Convert zero or weak search results into an RFQ inline** (IM-08).
   - Metric: search→checkout (via RFQ).
   - Effort: S. Principles: kept.
   - Risk: RFQ spam to providers; keep the pre-check.
6. **Search relevance thumbs ("Did you find…?")** (IM-07). Feeds the eval set.
   - Metric: search→checkout.
   - Effort: S. Principles: kept.
   - Risk: low response volume.
7. **GSTIN lookup by mobile/PAN plus auto-fill in provider onboarding; PAN path for GST-exempt providers** (IM-36).
   - Metric: providers onboarded.
   - Effort: S–M. Principles: kept.
   - Risk: GST-exempt providers are weaker on KYC; label them distinctly.
8. **Response-rate and quality/delivery sub-scores on profiles** (IM-11/12). Buyers still never see the AMC Score number.
   - Metric: review ≥4.2, dispute <5%.
   - Effort: S. Principles: kept.
   - Risk: small-n noise; show only above a review threshold.
9. **Tender/GeM alerts for govt-licensing providers** (IM-43).
   - Metric: providers onboarded / retention.
   - Effort: M. Principles: kept (alerts only).
   - Risk: data licensing of tender feeds.
10. **Onboarding drop-off stage capture + stage-specific WhatsApp nudge** (IM-37).
    - Metric: providers onboarded.
    - Effort: S. Principles: kept.
    - Risk: nagging.

### 7. AI horizon

**1. Procurement Assistant with "% match" per quote.** Theirs is a paid, human-assisted demo.
- **What unlocks it:** cheap frontier reasoning over structured quotes, the provider's history and the buyer's constraints; explanations good enough to trust. Today it's costly and hallucination-prone on price terms.
- **Foundations to lay now:**
  - Store the buyer's stated constraints per RFQ as typed fields: budget band, deadline, must-haves.
  - Store every quote-loss reason as a label.
  - Log which compare flags the buyer viewed.
  - Build an eval set of (RFQ, quotes, chosen) triples.
- **Dark version now:** compute a rule-based "fit %" (price inside the range, on-time history, category credentials) and log it without showing it.
- **Excluded list:** no; the agent must not negotiate.

**2. Voice search and voice RFQ in 9+ Indic languages, near-free.**
- **What unlocks it:** real-time Indic ASR plus a domain lexicon. Today latency/cost and code-mixed jargon ("GST ka return") are the blockers.
- **Foundations to lay now:**
  - Capture voice-RFQ audio→text→edited-text triples, with consent, as an ASR eval set.
  - Build a synonym table of Hindi/Telugu service terms → category IDs.
- **Dark version now:** voice input on the search box, routed through the same transcription pipeline.
- **Excluded list:** no.

**3. Photo → RFQ for goods (and for documents on services).**
- **What unlocks it:** reliable vision on nameplates, drawings and spec sheets.
- **Foundations to lay now:**
  - Store image → final structured RFQ pairs.
  - Record which fields the user corrected.
  - Add an HSN-from-image eval.
- **Dark version now:** shadow-extract fields from uploaded photos and measure the correction rate.
- **Excluded list:** no.

**4. Seller-trust lookup agent.** "Paste a phone number, GSTIN or bank account → is this provider who they claim to be?"
- **What unlocks it:** dependable browser agents on GST, MCA and ICAI portals. Today it's brittle and captcha-bound.
- **Foundations to lay now:**
  - Keep timestamped verification evidence per provider (source URL, fetched-at, hash).
  - Build a registry of the official lookup endpoints per credential type.
- **Dark version now:** nightly re-verification of GSTIN status, flagging cancelled GSTINs to ops.
- **Excluded list:** no.

**5. Buyer spam-shield as a default, not a paid tier.** Theirs is part of VBB Max.
- **What unlocks it:** cheap agents that can triage every inbound provider message and summarise it.
- **Foundations to lay now:**
  - Keep the rule that no provider chat happens before an RFQ exists.
  - Record per-message "useful / not useful" taps.
- **Dark version now:** a digest mode on WhatsApp notifications.
- **Excluded list:** no.

**6. Logistics quote aggregation for AMC Mart orders.**
- **What unlocks it:** agents that can pull rate cards from transporter portals.
- **Foundations to lay now:**
  - Store pickup/drop pincode, weight and volume on every goods order.
  - Record the delivery photo plus timestamps.
- **Dark version now:** a static "estimated freight band" by distance × weight.
- **Excluded list:** no (we're not running a fleet).

### 8. Anti-patterns to avoid

- **Spam calls after an RFQ.** The help article "How to stop calls from IndiaMART" says to delete your requirement or **deactivate your account**. "No spam calls" is a **paid** buyer feature (VBB Max ₹9,999/yr).
- **Trust is sold.** TrustSEAL (the badge payment protection depends on) is bundled into a ₹60k/yr ad plan. STAR and LEADING labels are paid ranks that look like quality badges.
- **Payment protection is narrow.** Non-delivery only, and only for NEFT to a verified account. Quality and partial delivery aren't covered. Claims go by phone/email with a 15–60 day review.
- **Indicative prices.** "Payment mode: Online/Offline" on service listings pushes deals off-platform.
- **Unmatched suppliers.** Buyers are told to email support when they get irrelevant suppliers.

### 9. Open questions / not verified
- **Do we already have these?** (Claude Code to check)
  - Buyer-visible verification checklist
  - Response-rate display
  - GSTIN auto-fill
  - Search-to-RFQ fallback
  - Search relevance feedback
- **Unverified here:**
  - What the TrustSEAL field verification physically involves (only "certificate" is documented).
  - The seller-side lead purchase flow and cost per lead outside TrustSEAL.
  - VBB Procurement Assistant quality (paid).
  - Mobile-app-only features.
- **Your call:** is a free, earned "Verified Business Buyer" badge acceptable under our principles? It favours established MSMEs.
