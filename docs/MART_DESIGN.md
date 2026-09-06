# AMC MART — DESIGN.md
Build spec for the goods/MRO mode of AMC. Audience: Claude Code in a fresh session + the developer.
Posture: PARALLEL DARK BUILD. The services app is live, stable, and is the untouchable baseline.
Mart is developed alongside it in the SAME monorepo, feature-flagged OFF, migrations staged but
NOT applied to prod, and goes live weeks from now via the Launch Gate (§8). Read fully first.
This document + RULES.md govern every change. Where the repo and this document disagree, trust
the repo and report the difference.

## 0. NON-NEGOTIABLE BUILD POSTURE
- Same monorepo, same database schema lineage, same spine. NOT a new app, NOT a new repo.
- ONE SPINE, TWO MODES: sellers are providers; goods orders are orders (kind='goods'); delivery
  photos are milestone evidence; one readiness.ts; one payout.ts; one event mechanism; one admin.
  A second identity/payment/event/admin system = design violation. Stop and report.
- DARK BUILD RULES:
  - All Mart surfaces behind a single flag: MART_ENABLED (env + config). Flag OFF in prod until
    Launch Gate. Flag ON in local/preview.
  - Mart migrations live in the normal migrations dir but are NOT applied to prod during the
    build (exception to "migrations deploy with writers": during dark build, NEITHER deploys;
    at launch, BOTH deploy together — the rule's intent preserved).
  - Zero behavioral change to any live services path while flag is off. Shared-file edits
    (orders schema, readiness, admin shell) must be provably inert when MART_ENABLED=false —
    each such edit needs a killtest asserting services behavior unchanged.
  - Services hotfixes always outrank Mart work; rebase Mart on main frequently; no long-lived
    divergence of shared files.

## 1. EXISTING SPINE — FACTS TO VERIFY IN THE REPO (session step 1: verify, report, then build)
- Turborepo: apps/web (Next.js, Vercel, functions pinned bom1/ap-south-1), apps/mobile (Expo,
  Android-first), packages/db (Drizzle + Supabase Postgres ap-south-1), packages/shared
  (types, zod schemas, i18n en+hi).
- Live services flow: voice RFQ (Sarvam + OpenRouter extraction) → quotes (structured fields
  incl. gst_included, transport_included, valid_until, advance_percent) → order → milestone/
  delivery photo evidence → buyer confirm (72h auto-accept) → founder-released payout.
- Money: payout.ts is the ONLY money path. Manual payout mode with mandatory UTR. Refunds
  insert-first, idempotency key rfnd_<order_id>, replay-killtested. Fee headroom guard: payout
  math leaves gateway fee+GST inside captured amount; loud failure otherwise. PAYOUT_AUTO_RELEASE
  off; human release only.
- Events: order_events, quote_events, audit_logs — append-only at DB level (BEFORE UPDATE
  trigger raises; UPDATE/DELETE revoked; RLS; no update policies). Every transition emits an
  event {actor, timestamp, payload}.
- Trust: provider_score_inputs_v1 view; nightly median_response_minutes cron with ≥3-sample
  gate (NULL below); no fabricated stats anywhere, ever.
- Identity/readiness: provider_profiles is the single seller entity. readiness.ts = single
  payout-readiness definition; all tiles/banners/worklists derive from it. GSTIN verification
  exists in onboarding.
- Legal plumbing: LEGAL_VERSIONS + terms_acceptances (append-only, API-enforced, blocking modal
  on version bump). Grievance page live. Disclosure doctrine: features that measure users,
  speak for them, or reuse their data are disclosed before they operate.
- Engineering constitution (RULES.md): additive-only migrations; append-only stays append-only;
  phase gates (report → approval → implement → verify → approval → push); full suites + zero
  prod residue every phase; render assertions against visible markup only.

## 2. DERIVED BUILD REQUIREMENTS (constraints only; rationale lives in COMPLIANCE.md/ADRs)
- Documents direction: buyer-facing invoices are generated in AMC's name. Seller invoices are
  recorded INBOUND against orders (upload/capture + structured fields). Build the document
  generator + storage accordingly.
- Payouts to sellers are vendor payments through the existing payout pipeline; TDS fields on
  payout records are config-driven (rates from a config table, not hardcoded — CA sets values).
- Sellers must have VERIFIED GSTIN to activate goods selling (hard gate in the activation path).
- Every product carries hsn_code + gst_rate; order line items snapshot both; totals computed
  server-side only.
- E-way-bill data fields captured on dispatch for orders above the config threshold (generator
  integration later; fields now).
- No BIS-notified categories at launch (config blocklist of categories).
- Per-category return_window_hours config; return_opened blocks release.
- ITC display: for GST-registered buyers, show effective cost after input credit beside price.
- Data residency ap-south-1; PII encryption follows the existing pgcrypto pattern.

## 3. PRODUCT SCOPE (Mode 2)
Fixed-price catalog purchase of industrial consumables/MRO + group buying (pools) + bulk goods
RFQ (reuses services RFQ flow). Cluster-dense launch (Kurnool), club-first positioning.
Explicitly NOT built (ADR to override): inventory/warehouse, logistics fleet, nationwide catalog
ops, seller credit from AMC books, auto-released money, BIS-notified goods, any parallel spine.

## 4. DATA MODEL (all additive; every table RLS'd from birth; every transition emits an event)
### 4.1 Sellers
provider_profiles + sells_goods boolean default false. Goods activation gate: verified GSTIN.
readiness.ts untouched.
### 4.2 Catalog
- products(id, seller_id, name, description, hsn_code, gst_rate, unit, images[], status
  'draft'|'active'|'suspended', timestamps)
- price_tiers(id, product_id, min_qty, unit_price_paise) — bulk pricing native; substrate of pools.
- product_events: append-only, mirrors quote_events regime exactly (trigger + revoked grants +
  RLS read policies). Vocabulary: created|edited|activated|suspended|price_changed, with
  before/after payloads on edits.
### 4.3 Orders (extend, never fork)
- orders + kind 'service'|'goods' (additive, default 'service'). Goods orders skip quotes; carry
  line_items jsonb [{product_id, qty, tier_unit_price_paise, hsn_code, gst_rate}]; server-side
  totals.
- order_events goods vocabulary: dispatched (dispatch photo + inbound invoice/batch photo refs),
  delivered_photo, buyer_received, return_opened, return_resolved. Reuse milestone-evidence
  storage/flow for photos.
- Goods release gate: (buyer_received OR 72h auto-accept after delivered_photo) AND return
  window clear. Payout-evidence dossier extends with these checks.
### 4.4 Pools (group buys)
- pools(id, product_id nullable, category, spec jsonb nullable, target_qty, min_qty,
  unit_price_paise, closes_at, status 'open'|'closed_met'|'closed_unmet'|'ordered'|'fulfilled'|
  'cancelled', seller_id nullable until awarded, created_by)
- pool_members(pool_id, buyer_id, qty, committed_at, payment_state 'blocked'|'captured'|
  'released'|'failed')
- pool_events: append-only, same regime. State machine in packages/shared: exhaustive
  transitions, illegal transitions throw, every transition emits.
- Payment mechanic: UPI one-time mandate BLOCK on join (funds blocked in the buyer's own
  account), CAPTURE on closed_met, auto-VOID on closed_unmet/expiry. REPORT-FIRST before
  implementing: verify current PSP block-and-capture support and live limits (Razorpay/Cashfree
  OTM; caps and validity change). Fallback if unavailable at needed limits: pay-on-close, with
  commit-then-default feeding the buyer discipline rating. All money through existing
  checkout + payout.ts, no exceptions.
### 4.5 Trust extension
Goods score-inputs view (sibling of provider_score_inputs_v1): on-time dispatch, delivery
confirmation rate, return rate, pool fulfillment. Same sample gates (≥3 compute, ≥5 public).
Buyer rating gains pool-commitment discipline. Factors public, formula private.
### 4.6 ai_decisions (build in M0; cannot be backfilled)
Append-only decision records: {feature, input_refs, proposed jsonb, final jsonb, decided_by,
decided_at} for every AI output a human confirms/corrects (catalog agent fields, payout dossier
recommendation vs founder tap, extraction corrections). Training corpus. Refs only, no PII blobs.

## 5. AGENTS (draft-and-approve doctrine; all proposals logged to ai_decisions)
Guardrails: agents draft, humans commit; an agent that reads untrusted content never acts
externally unmediated; every rupee human-gated; every tool call audited; model-agnostic config
per step (small models for extraction, frontier for judgment); Sarvam for Indic voice; per-task
cost caps.
- Catalog Agent (M0): seller photos + spoken description → drafted listing (name, description,
  HSN + gst_rate SUGGESTIONS, unit, tiers) → seller confirms each field → admin approves first
  N listings per seller.
- Payout-Evidence Agent (extend existing): goods dossier checks per §4.3 gate → one-tap
  approve/hold recommendation.
- Group-Buy Agent (M1): drafts pools from demand signals + monthly schedules; founder approves
  terms before open; drafts vernacular WhatsApp pool cards; never opens/awards autonomously.
- Documents Agent (M1): drafts AMC buyer invoice + e-way-bill data + seller payout advice from
  order records; human confirm. Seller pitch: the paperwork does itself.
- Munshi goods duties (post-launch): restock alerts, price-update drafts, pool suggestions —
  seller-confirmed, voice-first.

## 6. ARCHITECTURE DOCTRINE (boring-tech now; upgrades only on trigger metrics, each an ADR)
Now: single Supabase Postgres = OLTP + events + FTS (+ pgvector when catalog search ships —
hybrid dense+FTS, never dense-only for product codes) + simple job table as queue. No Kafka, no
Redis, no mesh, no dedicated vector DB, no durable-exec engine. Vercel functions bom1.
Triggers: PgBouncer at connection pressure; Redis at measured hot-read CPU; replicas +
partitioning of event tables at ~100GB; CDC→lakehouse when nightly Parquet export + DuckDB
stops sufficing; Qdrant past ~5–10M vectors; Inngest when agent workflows become long-running.
Training-data posture from day one: nightly export of event tables → Parquet; DuckDB for
point-in-time queries; typed events package as schema contract; ai_decisions per §4.6.

## 7. BUILD MILESTONES (parallel to live services; each = one gated phase per RULES.md;
all work behind MART_ENABLED)
### M0 — Catalog + direct purchase (2–3 weeks)
§4.1–4.3 + §4.6 schema (staged migrations); mart browse/product/cart/checkout (kind='goods')
web+mobile; delivery-photo release gate + return-window config; Catalog Agent v1; goods
activation gate; admin listing-approval queue + goods orders view + extended dossier; ITC-aware
price display; provider-addendum goods schedule drafted (ships with launch version bump).
Acceptance: full goods lifecycle killtested incl. return + refund replay; authz suite extended
(cross-tenant catalog/pool reads = 0 rows; append-only enforced on new event tables);
inertness killtests: MART_ENABLED=false leaves every services suite green and byte-identical
behavior on shared paths; zero prod residue.
### M1 — Group buys (2 weeks)
§4.4 + Group-Buy Agent v1 + WhatsApp pool cards + block-and-capture (after report-first PSP
verification) + pool-discipline rating input + Documents Agent v1.
Acceptance: pool state machine exhaustively tested (met/unmet/expiry/exit/capture-fail);
blocked funds NEVER captured on unmet pools; capture replay killtests.
### M2 — Goods RFQ (1 week)
Bulk/spec goods through existing RFQ+quote flow with kind='goods'. Dual mode complete.
### M3 — Post-launch reach (traction-gated)
Courier API; ONDC catalog listing; benchmark pricing over confirmed goods orders; vision QC at
receipt (buyer photo vs listing: count/brand/batch).

## 8. LAUNCH GATE (Mart goes to prod only when ALL true; founder flips the flag)
1. M0–M2 acceptance green on preview with MART_ENABLED=true; inertness proven with false.
2. Staged migrations applied to prod together with the enabling deploy (rule intent restored).
3. Founder decisions in §9 resolved and encoded in config.
4. Provider-addendum goods schedule shipped via LEGAL_VERSIONS bump (blocking re-accept).
5. Seed supply ready: founder's plant as seller #1 + 2–3 distributor sellers with approved
   listings in the launch category; Kurnool pilot buyer list confirmed.
6. Services baseline healthy at flip time (suites green, payout aging clean) — never flip during
   a services incident.
Flip procedure: apply migrations → deploy → MART_ENABLED=true → smoke the goods lifecycle with
one real internal order → announce.

## 9. OPEN FOUNDER DECISIONS (ask before building the affected part; encode answers as config/ADR)
1. Pool invoicing: consolidated seller order with member allocations vs one order per member.
2. Return windows per launch category + who pays return freight.
3. Goods commission: flat 5% or per-category (consumables margins are thin).
4. M1 pool categories (3 consumables) + the 2–3 seed distributor sellers.
5. Liability/warranty pass-through language (counsel) before Launch Gate.
