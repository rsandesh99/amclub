# AMClub market survey — TradeIndia (TI)

SESSION: TradeIndia — https://www.tradeindia.com · logged in as BUYER · 23 Sep 2026 · ≈15 min

Safety log:
- No "Send Inquiry", "View Number", "Get Best Price" or buy-requirement submissions.
- The AI Search got one harmless query.
- No personal data is recorded. Seller names seen in results are omitted.

## CHECKPOINT 1 — Map

| Area | Page type | URL pattern | Persona | Priority |
|---|---|---|---|---|
| Home | Home (categories, best sellers, value-adds) | / | all | H |
| AI | "Search AI — your smart sourcing assistant" | /ai-search/ | all | H |
| Search | Search results | /search.html?keyword= | all | H |
| Leads | Public buy-leads list | /TradeLeads/buy/ | seller | M |
| Monetisation | Special-offer packages + detail | /special-offers.html, /special-offers/<pkg>.html | seller | H |
| Escrow | TI Pay (payment protection) | /ti-pay/ | all | H |
| Other (footer, not opened) | Order Credit Report, Tradeindia Rewards, GetBizOnline app, TI Logistics, Digital vCard, Tradekhata ledger app, trade alerts, trade shows, domain booking, "Find distributors" | various | all | L |

## CHECKPOINT 2 — Features

| ID | Area | Feature | What it does (observed) | Persona | Where | Evidence | AMClub status | How theirs differs from ours |
|---|---|---|---|---|---|---|---|---|
| TI-01 | AI | Search AI (chat → product carousel) | NL query → after **~30 s** of "Analyzing… Finalizing" → carousel of local products (price "(Approx.)", MOQ, city, View Number, Send Inquiry) + follow-up chips ("Compare prices and MOQs", "Filter by glove size", "Explore cut-resistant gloves", "Compare nitrile/rubber/leather/cotton"). Starter chips include "Want to raise inquiry?" | all | /ai-search/ | Observed (1 harmless query) | CHECK (we have full-text search + AI pointers on compare) | Understood the city (Hyderabad), but results ignored my quantity (200 pairs) against MOQs of up to 1,000. No text answer or rationale |
| TI-02 | Search | Voice + AI + image in the search bar | Mic icon, "AI Search NEW" button, "Ask" | all | header | Observed | CHECK | — |
| TI-03 | Search | Filters | **Ti Shopping** ("products ready for immediate purchase"), **Active Supplier**, **Ti Trusted**, **With Price**, business type (Manufacturer / Supplier / Exporter / Trader / Wholesaler) + city chips | all | search.html | Observed | PARITY/CHECK | "Active supplier" (recency of activity) is a useful facet |
| TI-04 | Search | Services search quality | "company incorporation" returned 81 results mixing **machines** (a manufacturer with "Incorporation" in its name) and foreign (UAE) formation services. Services show "**MOQ – 3 Number**" | all | search.html | Observed | OURS-BETTER | Services are treated as products |
| TI-05 | Messaging | "View Number" | Reveals the seller's phone on the listing card | buyer | cards | Observed (not clicked) | N/A (we mask contact details on purpose) | Guarantees off-platform leakage |
| TI-06 | RFQ | WhatsApp your buy requirement | Short link opens WhatsApp to post a requirement | buyer | search page | Observed (not used) | PARITY (Procurement Agent on WhatsApp, built/off) | — |
| TI-07 | Escrow&Trust | **TI Pay** | "Buyer pays Tradeindia → supplier delivers → buyer confirms → Tradeindia pays the seller within 24 h". Free; needs the seller's bank details | all | /ti-pay/ | Observed | PARITY | Opt-in, and separate from the main flow (a sign-up page) |
| TI-08 | Order | Ti Shopping | Filter for buy-now products | buyer | search filter | Observed (not opened) | PARITY (AMC Mart, off) | — |
| TI-09 | Ads&Monetisation | Seller packages (INR, time-limited "special offers") | SME Biz Connect ₹48,999 (3-page catalogue, domain, basic SSL) · SME Biz Plus ₹67,999 · SME Biz PRO ₹1,15,999 · TI Premium ₹2,93,999 · TI Super ₹7,48,999 · TI Super Premium ₹10,28,199 · TI Super Bonanza ₹18,42,499. **Every package has a countdown** ("Offer expires in 38 days : 17 hrs…"); "valid till 31 Oct 2026" | seller | /special-offers | Observed | N/A | — |
| TI-10 | Seller-tools | Buy Trade Leads (public list) | Latest buy leads with product, country, date, "Buyer is looking for…" | seller | /TradeLeads/buy/ | Observed | N/A (lead-selling) | — |
| TI-11 | Credit&Finance | Order Credit Report | Paid credit report on a counterparty (footer) | all | footer | Observed (link) | MISSING | Due diligence on the other party |
| TI-12 | Other | Tradekhata, GetBizOnline, Digital vCard, domain booking | Ledger app, website builder, vCard | seller | footer | Observed (links) | N/A | Ecosystem lock-in |
| TI-13 | Other | Tradeindia Rewards | Loyalty/rewards (footer) | all | footer | Observed (link) | NOT-NOW (gamification points) | — |
| TI-14 | Logistics | TI Logistics, freight quotes, packers & movers | Freight-quote lead forms | all | footer | Observed (links) | MISSING (not building logistics) | — |
| TI-15 | Trust | Ti Trusted | Trust badge used as a filter; what it verifies is not shown on the filter (inferred: paid verified membership) | all | filter | Observed tag; scope inferred | CHECK | — |
| TI-16 | Discovery | Trade shows, "Find distributors" | Value-add cards on home | all | home | Observed | N/A | — |

## FINAL REPORT — TradeIndia, 23 Sep 2026, buyer

### 1. Coverage
- **Visited:** 7 page types.
- **Not reached, and why:**
  - Buy-requirement form: the only entry point found was the WhatsApp link.
  - Listing detail page, message centre and seller back-office: not reached, for time and rules 1 and 5.
- **Checkpoints posted:** 1–2.

### 2. Journeys

| Journey | Steps observed |
|---|---|
| B1 | Search/AI search → card → View Number / Send Inquiry. Contact happens off-platform immediately |
| B2 | WhatsApp link or the "Post Buy Requirement" CTA (form not reached) |
| B4 | TI Pay is an opt-in escrow; Ti Shopping is buy-now |

### 3. Monetisation observed
- Seller packages from ₹49k to ₹18.4 lakh, each with a countdown timer.
- Buy-lead sales, ads, domains and credit reports.

### 4. Trust
- **Ti Trusted:** scope not shown.
- **Active Supplier:** activity-based.
- **TI Pay:** escrow.

### 5. AI
- **Search AI:** slow (~30 s). Local matching was OK. It ignored quantity versus MOQ and gave no explanation. It pushes "View Number / Send Inquiry".

### 6. Adopt
1. **"Active provider" facet and label**, from last-seen / last-quote timestamps.
   - Metric: RFQ→quote.
   - Effort: S.
2. **Counterparty credit/compliance report** (LATER-ish): GST filing regularity for providers, shown as a trust signal.
   - Effort: M.
3. **An AI search answer should respect quantity vs MOQ** (for AMC Mart). This is a negative example to learn from.

### 7. AI horizon
- **Conversational search that returns a reasoned shortlist** ("these 3 because…") with quantity/MOQ/budget constraints respected.
  - **Foundations to lay now:**
    - Log the parsed constraints for each search query.
    - Log clicks and orders per result.
    - Build a golden set of (query, constraints, acceptable results).
  - **Dark version now:** run the parser on search logs offline.

### 8. Anti-patterns
- **Countdown timers on every seller package** (fake urgency; "valid till" a month out).
- **"View Number"** exposes the seller's phone on every card.
- Services have MOQs; keyword matching mixes machines into service results.
- ~30 s AI latency behind a spinner.

### 9. Open
- What "Ti Trusted" verifies.
- Whether TI Pay is used on most transactions.
- What the Rewards programme looks like.
