# AMClub market survey — Xometry (XM) — manufacturing RFQ from CAD

SESSION: xometry.com (US site) · logged in as BUYER (your account has one existing auto-quote) · 23 Sep 2026 · ≈10 min

Safety log:
- Nothing uploaded; no configuration edits; no checkout; no "Forward to Purchaser".
- I viewed your own existing quote read-only.
- I left the cookie banner untouched; it offers only "Accept".
- No personal data is recorded.

## CHECKPOINT 1 — Map

| Area | Page type | URL pattern | Persona | Priority |
|---|---|---|---|---|
| Home | Marketing + "Get an Instant Quote" (CAD upload) | / | all | H |
| Quote | Quoting dashboard (Quotes / Orders / Tools / Part Library) | /quoting/home/ | buyer | H |
| Quote | Quote detail / configurator | /quoting/quote/<id> | buyer | H |
| Supplier | Partner network landing | /become-a-supplier/ | supplier | M |

## CHECKPOINT 2 — Features

| ID | Area | Feature | What it does (observed) | Persona | Where | Evidence | AMClub status | How theirs differs from ours |
|---|---|---|---|---|---|---|---|---|
| XM-01 | Quote | **Instant quote from CAD** | Upload STEP/STP/SLDPRT/STL/DXF/IPT/X_T/X_B/3DXML/CATPART/PRT/SAT/3MF/JT → auto-quoted price. "Instant Quoting Engine®, covered by US patents" | buyer | home, dashboard | Observed (existing quote; no upload) | THEIRS-BETTER (we read STEP/DXF into an RFQ; they price it) | They price from geometry + config with no humans in the loop. We extract specs and fan out to providers |
| XM-02 | Quote | Geometry extraction | "Measurement: 77.57 × 59.60 × 20.00 mm, 25,041 mm³" plus threads/tapped holes and inserts counts | buyer | quote detail | Observed | PARITY (CAD read) / CHECK (volume and bounding box) | — |
| XM-03 | Quote | Structured configuration | Process (CNC machining), material (SS 304/304L), preferred subprocess, finish, threads, inserts, **precision tolerance (±0.005″)**, **surface roughness (125 µin / 3.2 µm Ra)**, **inspection level** | buyer | quote detail | Observed | THEIRS-BETTER | The config is a typed spec, not free text. It is the basis for our goods RFQ schema |
| XM-04 | Quote | **3 price × lead-time options** | Least expensive $232.46 (arrives Oct 21) / Standard $870.25 (Oct 5) / Fastest $1,424.72 (Sep 29), each with a struck-through "save $X" | buyer | quote detail | Observed | MISSING | Buyers choose speed versus price. There's no negotiation; price is set by the platform |
| XM-05 | Quote | Manufacturing origin | Dropdown: Global vs (inferred) US-only | buyer | quote sidebar | Observed | N/A | — |
| XM-06 | Compliance | ITAR/EAR/CUI handling toggle; "Add certifications" to the quote | Controlled-data handling and certification requirements per quote | buyer | quote header | Observed | MISSING | Relevant to your aerospace/defence ambitions later |
| XM-07 | Order | **Forward to Purchaser** | Hand the quote to a colleague who pays (approval/PO workflow) | buyer | quote sidebar | Observed (not clicked) | MISSING | Multi-user buying. Related to LATER: multi-branch accounts |
| XM-08 | Order | Teamspace | "Your team manages quotes, tracks orders, shares project details in one place" | buyer | dashboard | Observed (promo) | LATER (multi-branch accounts) | — |
| XM-09 | Order | Repeat Part toggle + Part Library | Mark a part as recurring; saved part library for reorders | buyer | quote detail, dashboard tabs | Observed | MISSING | Drives repeat orders (90-day repeat metric) |
| XM-10 | Quote | Revise CAD (versioning), upload drawings, attach files, activity log | v0/v1 versions of the CAD; "Recent Activity Log" | buyer | quote detail | Observed | PARITY (attachments) / MISSING (versioning) | — |
| XM-11 | Order | Quote list management | Status (Auto-Quoted…), subtotal, arrives by, last updated; filter by date; custom columns; **Export CSV** | buyer | dashboard | Observed | CHECK | — |
| XM-12 | Logistics | Delivery promise + cut-off | "Order today to arrive by Oct 21"; free shipping on CNC/sheet/tube/3DP orders; carbon offset option | buyer | quote sidebar | Observed | MISSING | Date-certain delivery |
| XM-13 | Seller-tools | **Supplier matching with no RFQs** | "Jobs instantly matched to your facility: we match your capabilities and certifications to the best-fit jobs. **No RFQs, no fees, no subscriptions**." Suppliers browse jobs and pick ones that fit their schedule and materials; **1-day payments available** | supplier | /become-a-supplier/ | Observed | CHECK (vs our fan-out to ≤7 providers) | The platform is the seller of record; suppliers accept fixed-price jobs. No bidding |
| XM-14 | Trust | Certifications as marketplace gates | ISO 9001, ISO 13485, AS9100D, IATF 16949, ITAR, CMMC L2, JCP; "certified shops earn more" | all | home, supplier page | Observed | MISSING (for goods/manufacturing) | — |
| XM-15 | Other | DFM guide + "Design parts better" | Content to reduce cost and lead time | buyer | dashboard | Observed | MISSING | — |
| XM-16 | Trust | Public stats | Buyers/suppliers/parts shipped counters; Trustpilot score widget (counter values changed between loads: 0.9/5 then 1.2/5, animated) | all | home | Observed | N/A | The Trustpilot figure looks low. Verify before quoting it |

## FINAL REPORT — Xometry, 23 Sep 2026, buyer

### 1. Coverage
- **Visited:** home, quoting dashboard, one existing quote (read-only), supplier landing.
- **Not reached, and why:**
  - New instant quote: upload is prohibited (rule 4).
  - Configuration editor, checkout and orders: rules 3 and 4.
  - Supplier workcenter: no supplier login.
- **Checkpoints posted:** 1–2.

### 2. Journeys
- **B2/B3:** CAD upload → auto geometry + config → 3 price/lead-time tiers → (Forward to Purchaser) → checkout.
- **B6:** Repeat Part + Part Library.
- **S3:** jobs matched to capability and certifications; supplier picks; 1-day pay.

### 3. Monetisation
- Platform margin between the buyer price and the supplier payout (inferred; Xometry is the seller of record).

### 4. Trust
- Certification gates for suppliers.
- Platform-guaranteed price and delivery date.

### 5. AI
- **Instant Quoting Engine:** geometry → price across 3 lead times. It auto-quoted your existing part without a human; the quote shows the status "Auto-Quoted".

### 6. Adopt (for AMC Mart custom-processing and the CAD path)
1. **Three delivery-speed options on RFQ quotes**: providers quote Economy/Standard/Express in one structured quote.
   - Metric: RFQ→quote, search→checkout.
   - Effort: M. Principles: kept (buyer picks, no negotiation).
2. **Typed manufacturing spec in goods RFQs**: process, material, tolerance, finish, inspection, quantity.
   - Effort: M.
   - Foundation for everything in §7.
3. **Repeat part / reorder library** (XM-09).
   - Metric: 90-day repeat ≥25%.
   - Effort: S–M.
4. **Forward-to-purchaser approval**: a quote link someone else can pay from escrow.
   - Metric: search→checkout for companies.
   - Effort: S–M.
   - LATER-adjacent (multi-user).

### 7. AI horizon
**Instant price bands from CAD for Kurnool job-shop work** (cutting, bending, welding, machining).
- **What unlocks it:** cheap, reliable geometry + drawing understanding, plus enough paid-order history to regress price on features. Today we lack labelled price data.
- **Foundations to lay now:**
  - For every CAD RFQ, store the extracted features (bounding box, volume, hole count, bends, weld length), the typed spec, **every quote received** (price, lead time), the **winning quote**, and the **final paid amount**.
  - Consent for using quote data in aggregate.
  - An eval set of 100 parts with the prices actually paid.
- **Dark version now:** compute a shadow "expected price band" per CAD RFQ and log it against actual quotes. Show it to nobody until its error is under ±20%.
- **Excluded list:** only if we let the platform set the price instead of providers. It stays compatible if shown as guidance ("similar parts closed at ₹X–₹Y"), which is our fair-price-range model.

### 8. Anti-patterns
- The cookie banner has only "Accept".
- Strike-through "Save $X" anchors on engineered-part quotes.

### 9. Open
- Whether AMClub wants the Xometry model (platform prices, then routes) for AMC Mart custom processing, or stays provider-priced. This is a strategic call.
