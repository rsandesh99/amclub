# AMC Mart — Design Document (strategy, regulatory, architecture)

> Source: `AMC_Mart_Design_Document.docx` (v1.0, 31 August 2026), converted to Markdown verbatim for the repo. The buildable spec derived from it is `docs/MART_DESIGN.md`; the UI system is `docs/FRONTEND.md`.

**AMC MART**
Design Document — Services + Goods Super-App for Indian MSMEs

v1.0 · 31 August 2026 · compiles the strategy, regulatory, and architecture conclusions of the founding build threads into one buildable specification

## 0. What AMC Mart is
One platform, two commerce modes, one trust spine. Mode 1 (LIVE): the services marketplace — MSMEs post RFQs (voice-first, vernacular), providers quote, escrow-style payment, milestone photo evidence, founder-released payouts. Mode 2 (THIS DOCUMENT): industrial goods — consumables and MRO supplies (welding rods, abrasives, oils, fasteners, safety gear, spares) sold to the same MSME base by the same verified seller community, with fixed-price catalog purchase, bulk-RFQ, and group buying. The strategic identity: AMC is a CLUB before it is a marketplace — the goods arm is collective purchasing power for members, not a catalog war with incumbents.

Design principle for everything below: ONE SPINE, TWO MODES. Sellers are providers; goods orders are orders; delivery photos are milestone evidence; the AMC Score covers both; payout.ts remains the only money path. Roughly 70% of the goods arm already exists because the services arm was built on append-only events, a single readiness definition, and additive migrations.

## 1. Present Indian situation and competition
### 1.1 The goods-side incumbents and the gap
IndiaMART / TradeIndia: lead-generation directories — they sell introductions, transactions happen offline. No fulfillment truth, fakeable reviews, pay-per-lead seller resentment. Our wedge against them is unchanged from services: verified transactions, pay-only-on-success.

Moglix / OfBusiness / JD-Industrial-style players: full-stack industrial MRO with warehouses, credit books, and enterprise contracts. Do NOT fight them on SKU breadth or logistics — a 2-person team cannot and should not. Their weakness: they serve enterprises and large MSMEs; the Kurnool-scale small fabricator buys consumables from a local kirana-style industrial store at list price with zero leverage.

Udaan: proved eB2B logistics + credit at scale and also proved the cash-burn trap of inventory-led models. Lesson: stay marketplace/aggregation, never hold stock.

China lesson (1688 / ZKH / Xunxi): winners became infrastructure — factory digitization, credit, fulfillment data — not just matching. 1688 runs dual mode (spot wholesale + custom processing RFQ) on one platform: exactly the services+goods duality AMC Mart adopts. ZKH-class MRO platforms won via consolidated procurement for factories — the same job AMC Mart does for a cluster, minus their warehouses.

The open gap AMC Mart occupies: cluster-level trusted MRO with collective bargaining. Nobody aggregates the monthly consumables demand of 50 small units in one industrial belt and negotiates it as one order. Group buying is the goods-side feature incumbents structurally ignore (their margins depend on fragmented buyers) and the truest expression of an "MSME Club".

### 1.2 Demand-side reality
Same buyers as services — the MSME units already being onboarded. Goods PURCHASE FREQUENCY is weekly/monthly versus services’ episodic RFQs: the goods arm is therefore the habit engine of the super-app. A unit that buys welding rods through AMC every month keeps the app alive between service orders — solving services’ low-frequency problem, which is the primary strategic reason to build Mode 2 at all.

## 2. Regulatory environment (decisions already made carry over)
Payments: RBI PA Master Direction (Sept 2025) ₹40L turnover rule blocks Route split-settlement for the new Pvt Ltd — identical for goods. The adopted interim stands: two-step flow, CA-designed merchant-of-record (AMC invoices buyer, seller invoices AMC, receipts booked as advance-from-customers), manual payout with UTR discipline, RazorpayX automation later. Goods GMV under MoR accelerates company turnover toward the ₹40L Route unlock even faster than services.

GST: goods bring rate diversity (5/12/18/28 by HSN), mandatory HSN codes on invoices, and — new obligations services never triggered — E-WAY BILLS for goods movement above ₹50,000 and e-invoicing once turnover thresholds hit. The GST-registered-only seller rule (already decided for MoR input-credit integrity) carries over unchanged and matters even more for goods.

Consumer/e-commerce rules: grievance officer, display obligations, and — goods-specific — returns/refund policy per E-Commerce Rules; country-of-origin display; BIS certification awareness for notified products (helmets, some electricals — exclude notified categories at launch rather than certify).

TDS/TCS: under MoR, seller payments are vendor payments (194-C/194-Q territory, CA to confirm per goods volume) — the 194-O/TCS marketplace regime returns when the agent+Route flip happens at ₹40L. The flip plan (contract v1 MoR / v2 agency drafted together) covers both modes.

DPDP + disclosure doctrine: the thread’s disclosure principle is now platform law: anything that measures users (Score), speaks for them (auto-decline), or reuses their data (aggregated pricing) is disclosed at onboarding, in the addendum, before it operates. Goods sellers inherit the same addendum with a goods schedule.

Structural rails available: GSTIN/Udyam verification APIs (live in onboarding), Account Aggregator (future credit, via licensed FIU partner only), ONDC (future open-network listing of catalog — goods are ONDC-ready long before services), PN3 discipline on any future capital.

## 3. Technical position
### 3.1 Advantages (what the sprint already built that goods inherit free)
Append-only event spine: order_events + quote_events + audit_logs with DB-level append-only enforcement. Goods orders emit the same events; delivery-proof photos reuse the milestone evidence engine as fulfillment evidence. The Trust Graph extends to goods with zero new architecture.

Single definitions: readiness.ts (seller payout-readiness), payout.ts (only money path), LEGAL_VERSIONS + terms_acceptances (versioned consent), RULES.md (engineering constitution). Goods code obeys all four from day one.

Identity + verification: GSTIN-verified, penny-drop-verified seller onboarding exists; goods sellers = same entity with a catalog attached.

AI stack: Sarvam vernacular voice + OpenRouter small-model extraction pipelines proven in production (voice RFQ, quote extraction pattern). Catalog creation, goods RFQs, and group-buy coordination reuse the identical pattern.

Build velocity: demonstrated 6× roadmap compression solo with Claude Code/Antigravity, phase-gated with killtest evidence standards. The goods MVP is a 2–3 week build on this base, not a second startup.

### 3.2 Limitations (design around, not through)
Team of two: founder (part-time, burst-mode — cadence prosthetics in place) + one incoming dev. Nothing in Mode 2 may create an operational load the tile-and-worklist pattern cannot absorb.

No logistics: no fleet, no warehouse, no WMS — by design. Launch fulfillment = seller-arranged local delivery or buyer pickup within the cluster (Kurnool radius), with delivery-photo proof. Courier API integration is a later phase; inventory is never held.

No catalog ops: nobody will manually curate 50,000 SKUs. Catalog creation must be agentic from day one (photo/voice → listing) and capped to launch categories.

Payment interim: manual payout mode + settlement-timing float rules apply to goods payouts identically; goods returns add a refund-frequency the refund-idempotency work (insert-first, rfnd_ keys) already anticipates.

Compute economics: small models for routine extraction, frontier only for judgment; the 2029 cheap-inference thesis (edge/local/cluster compute, solar-powered micro-DC) is an architectural bet expressed ONLY as model-agnostic agent interfaces today — no hardware commitments.

## 4. Founder capabilities (honest inputs to the design)
Domain: director of a fastener manufacturing plant — i.e., the founder IS a goods seller and a goods buyer. The plant is seller #1 (fasteners on the Mart) and buyer #1 (consumables through the Mart): both sides of the goods loop are dogfoodable in-house, a cold-start cheat unavailable to any incumbent.

Distribution: Kurnool/Hyderabad cluster relationships, ~20 committed providers, MSME body EOIs (channel, not demand), plant partner’s decades of supplier relationships as seller pipeline.

Capital posture: runs without founder capital injections for now; the goods arm must be working-capital-light (marketplace model, MoR pass-through, no inventory) — which the design enforces.

Execution pattern: brilliant in bursts, weak in sustained repetition — mitigated by external structure: phase gates, weekly cadence, tiles/worklists, and now a dev inheriting RULES.md. Every Mode-2 feature ships with its own admin worklist so operations survive founder absence.

Skill gap on record: go-to-market/demand generation — the goods arm is deliberately its training ground: group-buy campaigns are repeatable GTM experiments with weekly metrics.

## 5. Agentic AI integration (draft-and-approve doctrine throughout)
Standing guardrails from the agent strategy apply to every item: agents draft and recommend, humans commit; no agent that reads untrusted content also acts externally unmediated; every rupee is human-gated until the rules-gated Phase-4 criteria; every agent action logs to the audit spine; model-agnostic interfaces; Sarvam for all Indic voice.

Catalog Agent (Mode-2 enabler, build first): seller photographs products and speaks descriptions → vision + voice models draft the listing (name, HSN suggestion, specs, price tiers) → seller confirms each field (same confirm-before-commit pattern as quote extraction) → admin approves first N listings per seller. Kills the catalog-ops limitation.

Procurement Agent (unified across modes): one buyer-facing agent that routes intent — "I need 200 welding rods" → catalog/group-buy; "I need this bracket fabricated" → service RFQ. The agent-as-interface for low-literacy owners speaks Telugu on WhatsApp and does not care which mode fulfils the need. This unification is the super-app’s actual UX.

Group-Buy Aggregation Agent: detects overlapping consumable demand across members (or runs scheduled monthly pools per category), proposes a pool with target quantity and indicative discount, coordinates commitments, closes the pool, and hands the seller one consolidated order. Humans opt in; founder approves pool terms. The single most differentiated feature of AMC Mart.

Ops/Payout-Evidence Agent: extends to goods — dossier = delivery photo present, buyer confirmation, amount vs listing/pool price, return window clear → one-tap release recommendation. Same WhatsApp summary, same approval gate.

Munshi (seller clerk): gains goods duties — restock alerts, price-update drafting, pool-participation suggestions, answering catalog questions — alongside its services quoting role. One clerk per seller across both modes.

Future (gated): benchmark pricing from confirmed goods orders (data-use clause already live), machine-originated RFQs (sensors), agentic UPI via UAP when shipped, AA-credit via licensed partner. All consume the same event spine; none require schema foresight beyond what exists.

## 6. Software architecture
### 6.1 Monorepo extension map (additive, zero rewrites)
apps/web        + /mart routes (catalog, product, cart, pool)

apps/mobile     + mart tab (browse, buy, pools) in existing Expo app

packages/db     + schema/catalog.ts, schema/pools.ts (additive)

packages/shared + HSN/GST-rate tables, pool state machine, mart i18n

unchanged: payout.ts · readiness.ts · events · legal · admin shell

### 6.2 Data model (all tables append-event-emitting, RLS from birth)
sellers = providers: no new identity. provider_profiles gains sells_goods boolean + goods activation gate (verified GSTIN mandatory — already policy). Readiness definition unchanged.

products: id, seller_id, name, description, hsn_code, gst_rate, unit, images[], status (draft|active|suspended), created via Catalog Agent with seller-confirmed fields. product_events append-only (created|edited|activated|suspended, actor, payload).

price_tiers: product_id, min_qty, unit_price_paise — native bulk pricing, the substrate of group buys.

orders (extended, not forked): orders.kind = service | goods (additive column, default service). Goods orders skip quote flow, carry line_items jsonb (product_id, qty, tier price), reuse the entire payment → settlement → release → payout pipeline, the same order_events vocabulary plus goods events (dispatched | delivered_photo | buyer_received | return_opened | return_resolved).

pools (group buys): id, product_id (or category spec), target_qty, min_qty, unit_price_paise, closes_at, status (open|closed_met|closed_unmet|ordered|fulfilled), pool_members (pool_id, buyer_id, qty, committed_at). State machine in packages/shared; every transition → pool_events (append-only). On closed_met: one goods order per member (or one consolidated order with member allocations — decide at build with CA input on invoicing), payment collected per member through the standard checkout.

fulfillment evidence: delivery photo + optional buyer-received tap reuse the milestone evidence tables/flow; 72h auto-accept applies with a goods-specific return-window overlay (return_opened blocks auto-release; policy per category, disclosed).

### 6.3 Money (nothing new, deliberately)
Checkout, settlement, advance-from-customers booking, release approval, manual payout with UTR, refund insert-first idempotency, payout_held reasons, aging view, fee-absorption ADR — all apply verbatim to goods orders. Returns create refunds through the existing idempotent path. The only money addition: a per-category return-window config consumed by the release gate. When Route unlocks at ₹40L (accelerated by goods GMV under MoR), both modes flip together behind payout.ts.

### 6.4 Trust spine extension
AMC Score: provider_score_inputs_v1 gains a goods sibling view (on-time dispatch rate, delivery-confirmation rate, return rate, pool-fulfillment record); the public Score blends modes with disclosed factors. Buyers’ two-way rating gains pool-commitment discipline (committing to a pool and defaulting is the goods-side ghosting).

Disclosure additions at seller onboarding: goods listings data use, return policy obligations, pool mechanics, delivery-photo requirement — one goods schedule appended to the provider addendum at its next version bump.

### 6.5 Build phases (each = one gated Claude Code phase with killtests)
M0 — Catalog + direct purchase (2–3 weeks): products, price_tiers, product_events, mart browse + cart + checkout (kind=goods), delivery-photo release gate, Catalog Agent v1, seller goods activation, admin worklists. Launch: ONE category (fasteners — the plant is seller #1) to the Kurnool pilot buyers.

M1 — Group buys (2 weeks): pools + state machine + pool_events, monthly scheduled pools for 3 consumable categories, Group-Buy Agent v1 (drafts pools, founder approves), buyer pool-commitment rating input. This is the marketing event: "AMC members buy together, pay less."

M2 — Goods RFQ (1 week): bulk/spec goods requests reuse the services RFQ + quote flow with kind=goods — 1688’s dual-mode completed. Structured quote fields already exist.

M3 — Reach (gated on traction): courier API integration, ONDC catalog listing (goods are ONDC-ready first), benchmark pricing over confirmed goods orders, AA-credit exploration with licensed partner.

### 6.6 What is explicitly NOT built
No inventory, no warehouse, no logistics fleet, no nationwide catalog acquisition, no notified-BIS categories at launch, no seller credit from AMC’s books, no auto-released money outside the rules-gate criteria, no second identity/trust/payment system for goods — any proposal violating this list requires an ADR and a very good reason.

## 7. Risks and their standing answers
Founder bandwidth: every feature ships with its admin worklist; weekly cadence + dev ownership; goods ops (pool approval, release taps) designed as sub-minute decisions.

Related-party optics: plant as seller #1 and buyer #1 follows the dogfood hygiene regime — market-rate, real commission, GST paper both ways, related-party register, disclosed concentration that visibly dilutes.

Regulatory drift: COMPLIANCE.md owns e-way-bill/e-invoicing thresholds and the MoR→agent flip trigger; CA retainer reviews quarterly.

Incumbent response: Moglix-class players can match SKUs and price, not cluster trust or the club’s collective-bargaining identity; the moat is the Trust Graph + membership, defended by shipping M1 before visibility rises.

Data honesty: no fabricated stats rule extends to goods (no fake "sold 500 units" counters); Score gating (≥5 completed orders) applies per mode.

Closing note: the services app proved the spine; the goods arm is the habit engine that keeps MSMEs in the app weekly and accelerates the company’s own turnover toward the Route unlock. One spine, two modes, one club.

