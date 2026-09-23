# AMClub market survey — Moglix (MG) — goods/MRO benchmark for AMC Mart

SESSION: moglix.com · logged in as BUYER · 23 Sep 2026 · ≈12 min

Safety log:
- I added one ₹699 item to the cart and looked at checkout up to the **address step**. I didn't add an address or press "Proceed to pay".
- I removed the item and **confirmed the cart shows "Your cart is currently empty!"**.
- The bulk-enquiry form was read, not submitted.
- No personal data is recorded.

## CHECKPOINT 1 — Map

| Area | Page type | URL pattern | Persona | Priority |
|---|---|---|---|---|
| Home | Retail-style B2B home (deals, cities with 24 h delivery) | / | all | H |
| Search | Search / category listing with facets | /search?search_query= | all | H |
| Listing | Product detail | /<slug>/mp/<msn> | all | H |
| Checkout | Cart + checkout summary | /quickorder → /checkout | buyer | H |
| RFQ | Bulk enquiry | /rfq | buyer | H |
| Enterprise | Moglix Business (procurement, supply chain, financing) | business.moglix.com | enterprise | M |

## CHECKPOINT 2 — Features

| ID | Area | Feature | What it does (observed) | Persona | Where | Evidence | AMClub status | How theirs differs from ours |
|---|---|---|---|---|---|---|---|---|
| MG-01 | Listing | Price incl. GST with the split shown | "₹699 (Incl. of all taxes) · ₹592 + ₹107 GST · MRP ₹926 · 24% OFF" | all | PDP | Observed | PARITY (AMC Mart: per-line GST on the server) | They show both the gross price and the split, right on the PDP |
| MG-02 | Listing | Quantity-tier pricing ("Buy More & Save More") | Qty 2 ₹693/pc · 3 ₹691 · 4–5 ₹688 · 6–7 ₹683 · 8+ ₹678, each with its % off | all | PDP | Observed | PARITY (tiered prices) | Tier table shown as tappable chips |
| MG-03 | Invoicing&GST | **ITC framing at checkout** | Checkbox "Get GST Invoice — **Claim ₹107.00 on your input tax credit**" | buyer | /checkout | Observed | PARITY (ITC-aware price display) | They put a rupee amount on ITC at the moment of purchase. Opt-in (unticked by default) |
| MG-04 | Logistics | Delivery options at checkout | "Get 1 item in 24 hours — online payment only" vs "Regular delivery (5 days) — COD / online / **partial payment**"; "Cities with 24 Hours Delivery" list; pincode check on PDP; "20,000+ pincodes" | buyer | PDP, /checkout, home | Observed | MISSING (delivery promise) / NOT-NOW (COD) | A speed tier gated to online payment steers people off COD |
| MG-05 | Payment | Platform fee | "Platform Fee ₹19" appears only in the checkout summary | buyer | /checkout | Observed | N/A | Drip pricing (anti-pattern) |
| MG-06 | Membership | Mogli Coins | "Pay only ₹693 + 6 Mogli Coins / earn 6 coins on this purchase"; "Use 6 Mogli Coins" at checkout | buyer | PDP, /checkout | Observed | NOT-NOW (gamification points) | — |
| MG-07 | Discovery | Social proof / urgency | "20 people bought this recently" | all | PDP | Observed | CHECK | Soft urgency |
| MG-08 | Analytics | "Moglix Insights" on PDP | "<Brand> is top brand in electrodes, preferred by 28% of users"; "20% of users prefer electrodes in ₹600–700" | all | PDP | Observed | MISSING (for goods) / PARITY-ish (fair price ranges, built/off) | Aggregate purchase behaviour shown as buyer guidance. Similar spirit to our fair price ranges |
| MG-09 | Escrow&Trust | Trust tiles | Money back · Genuine product · Easy return · Get GST invoice · Secure payments · 365-day help desk · "4.7 avg rating, 50+ lakh orders, 93% happy customers" | all | PDP, checkout header ("Buyer Protection") | Observed | PARITY | — |
| MG-10 | Search | Facets | Category, price bands with counts, brand (with counts), availability (in stock only), discount %, ratings | all | search | Observed | PARITY | — |
| MG-11 | RFQ | Bulk enquiry | "Fill your bulk requirement and our experts will get in touch… within 30 min"; "Bargain deals + GST benefit"; product-type picker | buyer | /rfq | Observed (form not submitted) | PARITY (goods RFQ) | Humans call back within 30 min (a promised SLA) |
| MG-12 | Order | Cart abandonment aids | "Recently viewed items", "More items to explore" in cart, "Move to wishlist" on remove | buyer | /checkout | Observed | CHECK | — |
| MG-13 | Credit&Finance | Enterprise procurement + financing | "From procurement to financing"; MRO sourcing, custom-manufacturing procurement, infra supplies; 3,500+ enterprises, 45k+ suppliers | enterprise | business.moglix.com | Observed | LATER (NBFC credit) | — |

## FINAL REPORT — Moglix, 23 Sep 2026, buyer

### 1. Coverage
- **Visited:** home, search, PDP, cart/checkout (up to address), bulk RFQ, business landing.
- **Not reached, and why:**
  - Payment step: rule 3.
  - Order tracking and returns flow: no orders.
  - Seller side: no seller login.
- **Checkpoints posted:** 1–2.

### 2. Journeys
- **B1:** search → brand/price facets → PDP (tiers, GST split, insights) → cart.
- **B4:** checkout. Delivery tier (24 h online-only vs 5-day COD/partial) → address → GST invoice (ITC) → coins → coupon → platform fee → pay.
- **B6:** wishlist and recently viewed.

### 3. Monetisation
- Retail margin plus a ₹19 platform fee.
- Brand banners ("up to 60% off").
- Enterprise procurement services.

### 4. Trust
- Genuine-product and money-back tiles.
- Aggregate ratings and order counts.
- GST invoice.

### 5. AI
- No AI touchpoints were visible on the consumer site. "AI-Powered Procurement" appears only on the Moglix Business banner.

### 6. Adopt (for AMC Mart)
1. **Show the rupee value of ITC at checkout**: "Claim ₹X as input tax credit" (MG-03).
   - Metric: search→checkout (goods).
   - Effort: S. Principles: kept.
2. **Delivery-speed promise per pincode** from sellers' declared dispatch SLAs, shown on the PDP (MG-04).
   - Metric: search→checkout.
   - Effort: M. Principles: kept.
   - Risk: missed promises. Tie them to the delivery-photo payout.
3. **Purchase-behaviour insights on goods PDPs** from paid orders with privacy thresholds (MG-08). This reuses the fair-price-range machinery.
   - Effort: S–M.
4. **Callback SLA on goods RFQs** ("quotes within N hours"), which pairs with our 72 h expiry (MG-11).

### 7. AI horizon
- **Cluster demand forecasting for Kurnool fabrication.** Predict consumable reorders (electrodes, cutting wheels) and pre-fill a reorder pool.
  - **Foundations to lay now:**
    - Order lines with SKU attributes (diameter, grade, pack size).
    - Buyer sector and equipment tags.
    - Reorder intervals.
  - **Dark version now:** a "you usually reorder in ~N days" reminder, rule-based.
  - **Excluded list:** no.

### 8. Anti-patterns
- The platform fee appears only at checkout (drip pricing).
- Perpetual MRP strike-throughs.
- Coins/points.
- The 24 h delivery tier is gated to online payment. That one is arguably good for us: it is a nudge off COD.

### 9. Open
- What the returns flow looks like for industrial items.
- Whether ITC is claimed correctly when the invoice checkbox is unticked.
